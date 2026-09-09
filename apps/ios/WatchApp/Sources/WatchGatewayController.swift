import Foundation
import Observation
import OpenClawKit

@MainActor @Observable
final class WatchGatewayController {
    private static let keychainService = "ai.openclaw.watch.direct-node"
    private static let keychainAccount = "gateway"
    private static let enabledDefaultsKey = "watch.directNode.enabled"
    private static let lastSetupSentAtDefaultsKey = "watch.directNode.lastSetupSentAtMs"
    private static let maximumSetupAgeMs: Int64 = 12 * 60 * 1000
    private static let maximumSetupClockSkewMs: Int64 = 2 * 60 * 1000

    @ObservationIgnored lazy var node = WatchDirectNode(owner: self)
    @ObservationIgnored lazy var conversations = WatchDirectConversations(gateway: self)
    let voiceCall = WatchRealtimeCallController()
    private(set) var configuration: WatchGatewayConfiguration?
    private(set) var isEnabled: Bool
    private(set) var voiceConnection: WatchVoiceConnection?
    private(set) var setupIncomplete = false
    private(set) var recoveryRequired = false
    private(set) var isForeground = false
    private var setupMessage: String?
    private var setupTransition: UUID?
    private var pendingSetupSentAtMs: Int64 = 0
    private var grantTransition: UUID?

    var isConfigured: Bool {
        self.configuration != nil
    }

    var isConnected: Bool {
        self.node.isConnected
    }

    var endpointText: String? {
        self.configuration?.endpointText
    }

    var statusText: String {
        self.setupMessage ?? self.node.statusText
    }

    init() {
        self.isEnabled = UserDefaults.standard.bool(forKey: Self.enabledDefaultsKey)
        if let raw = GenericPasswordKeychainStore.loadString(
            service: Self.keychainService, account: Self.keychainAccount)
        {
            self.configuration = try? JSONDecoder().decode(
                WatchGatewayConfiguration.self, from: Data(raw.utf8))
        }
        if let sentAtMs = self.configuration?.setupSentAtMs,
           sentAtMs > Self.lastAcceptedSetupSentAtMs()
        {
            Self.saveLastAcceptedSetupSentAtMs(sentAtMs)
        }
        self.refreshVoiceAvailability()
    }

    func configure(setupCode: String, sentAtMs: Int64) async {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        guard (now - Self.maximumSetupAgeMs...now + Self.maximumSetupClockSkewMs).contains(sentAtMs) else {
            self.setupMessage = String(localized: "Setup expired. Enter a new setup code.")
            return
        }
        guard sentAtMs > max(
            max(Self.lastAcceptedSetupSentAtMs(), self.configuration?.setupSentAtMs ?? 0), self.pendingSetupSentAtMs)
        else { return }
        guard let link = GatewayConnectDeepLink.fromSetupCode(setupCode),
              let next = WatchGatewayConfiguration(setupLink: link, sentAtMs: sentAtMs)
        else {
            self.setupMessage = String(localized: "A setup code with a trusted HTTPS Gateway is required.")
            return
        }
        self.pendingSetupSentAtMs = sentAtMs
        let transition = UUID()
        self.setupTransition = transition
        self.grantTransition = transition
        self.voiceConnection = nil
        self.node.disconnectForBackground()
        let voiceCleanup = self.voiceCall.end()
        await self.conversations.disconnect(clear: true)
        await voiceCleanup.value
        guard self.setupTransition == transition else { return }
        self.setupTransition = nil
        self.pendingSetupSentAtMs = 0
        self.grantTransition = nil
        guard let identity = DeviceIdentityStore.loadOrCreatePersisted(profile: .primary),
              Self.saveConfiguration(next)
        else {
            self.setupMessage = String(localized: "Could not save direct setup securely.")
            self.refreshVoiceAvailability()
            return
        }
        if let previous = self.configuration,
           !GatewayStableIdentifier.matches(previous.gatewayID, next.gatewayID)
        {
            self.clearCredentials(deviceID: identity.deviceId, gatewayID: previous.gatewayID)
        }
        // A fresh setup may narrow an existing grant, including on the same Gateway.
        DeviceAuthStore.clearToken(
            deviceId: identity.deviceId, role: "operator", gatewayID: next.gatewayID, profile: .primary)
        Self.saveLastAcceptedSetupSentAtMs(sentAtMs)
        self.configuration = next
        self.recoveryRequired = false
        self.setupMessage = String(localized: "Setup received. Connecting...")
        self.setEnabled(true)
    }

    func setEnabled(_ enabled: Bool) {
        self.isEnabled = enabled
        UserDefaults.standard.set(enabled, forKey: Self.enabledDefaultsKey)
        if enabled {
            self.refreshVoiceAvailability()
            if self.isForeground { self.node.connectForForeground() }
        } else {
            self.voiceConnection = nil
            self.voiceCall.end()
            self.node.disconnectForBackground()
            self.conversations.suspend()
            self.setupMessage = String(localized: "Direct connection is off")
        }
    }

    func connectForForeground() {
        self.isForeground = true
        guard self.isEnabled else { return }
        self.node.connectForForeground()
        self.conversations.resume()
    }

    func disconnectForBackground() {
        self.isForeground = false
        self.node.disconnectForBackground()
        self.conversations.suspend()
    }

    func forget() async {
        let transition = UUID()
        self.setupTransition = transition
        self.grantTransition = transition
        self.pendingSetupSentAtMs = 0
        self.voiceConnection = nil
        self.node.disconnectForBackground()
        let voiceCleanup = self.voiceCall.end()
        await self.conversations.disconnect(clear: true)
        await voiceCleanup.value
        guard self.setupTransition == transition else { return }
        defer {
            self.setupTransition = nil
            self.grantTransition = nil
            self.refreshVoiceAvailability()
        }
        if let configuration,
           let identity = DeviceIdentityStore.loadOrCreatePersisted(profile: .primary)
        {
            self.clearCredentials(deviceID: identity.deviceId, gatewayID: configuration.gatewayID)
        }
        guard GenericPasswordKeychainStore.delete(
            service: Self.keychainService, account: Self.keychainAccount)
        else {
            self.setupMessage = String(localized: "Could not remove secure setup. Try again.")
            return
        }
        self.configuration = nil
        self.setupIncomplete = false
        self.recoveryRequired = false
        self.setEnabled(false)
    }

    func isInstalled(_ configuration: WatchGatewayConfiguration) -> Bool {
        self.setupTransition == nil
            && GatewayStableIdentifier.matches(configuration.gatewayID, self.configuration?.gatewayID)
            && configuration.setupSentAtMs == self.configuration?.setupSentAtMs
    }

    func acceptNodeHandshake(
        _ response: WatchNodeConnectResponse,
        configuration: WatchGatewayConfiguration,
        identity: DeviceIdentity,
        usedBootstrap: Bool) async throws
    {
        guard self.isInstalled(configuration), usedBootstrap || response.voiceCredential == nil else {
            throw CancellationError()
        }
        // Preserve the redeemed node credential if the later operator write fails.
        // The bootstrap token is removed only after both durable handoffs finish.
        guard DeviceAuthStore.storeTokenPersisted(
            deviceId: identity.deviceId,
            role: "node",
            token: response.deviceToken,
            scopes: [],
            gatewayID: configuration.gatewayID,
            profile: .primary)
        else { throw GatewayOperatorHTTPError.pairingRequired }
        if let voice = response.voiceCredential {
            try await self.installOperatorGrant(
                token: voice.deviceToken,
                scopes: voice.scopes,
                configuration: configuration,
                isCurrent: { true })
        }
        guard self.isInstalled(configuration) else { throw CancellationError() }
        if configuration.link.bootstrapToken != nil {
            let sanitized = configuration.withoutBootstrapToken()
            guard Self.saveConfiguration(sanitized) else { throw GatewayOperatorHTTPError.pairingRequired }
            self.configuration = sanitized
        }
        self.refreshVoiceAvailability()
        // The old-node-token fallback remains useful, but it cannot finish operator onboarding.
        self.setupMessage = self.setupIncomplete
            ? String(localized: "Node connected. Direct chat and voice need a new setup code.")
            : nil
    }

    func installOperatorGrant(
        token: String,
        scopes: [String],
        configuration: WatchGatewayConfiguration,
        isCurrent: @Sendable () -> Bool) async throws
    {
        guard self.isInstalled(configuration), isCurrent(), !token.isEmpty,
              Set(WatchNodeConnectResponse.voiceScopes).isSubset(of: Set(scopes)),
              Set(scopes).isSubset(of: GatewayOperatorHTTPSession.allowedScopes),
              let identity = DeviceIdentityStore.loadOrCreatePersisted(profile: .primary)
        else { throw GatewayOperatorHTTPError.pairingRequired }
        let stored = DeviceAuthStore.loadToken(
            deviceId: identity.deviceId, role: "operator", gatewayID: configuration.gatewayID, profile: .primary)
        if stored?.token == token, Set(stored?.scopes ?? []) == Set(scopes) { return }
        let transition = UUID()
        self.grantTransition = transition
        self.voiceConnection = nil
        defer {
            if self.grantTransition == transition {
                self.grantTransition = nil
                self.refreshVoiceAvailability()
            }
        }
        // end() joins startup and its old Gateway hello storage before the new grant is written.
        await self.voiceCall.end().value
        guard self.grantTransition == transition, self.isInstalled(configuration) else {
            throw CancellationError()
        }
        guard isCurrent() else {
            self.requireSetupRecovery()
            throw CancellationError()
        }
        guard DeviceAuthStore.storeTokenPersisted(
            deviceId: identity.deviceId,
            role: "operator",
            token: token,
            scopes: scopes,
            gatewayID: configuration.gatewayID,
            profile: .primary)
        else {
            self.requireSetupRecovery()
            throw GatewayOperatorHTTPError.pairingRequired
        }
        self.recoveryRequired = false
    }

    func storedOperatorScopes() -> [String] {
        guard let configuration,
              let identity = DeviceIdentityStore.loadOrCreatePersisted(profile: .primary)
        else { return [] }
        return DeviceAuthStore.loadToken(
            deviceId: identity.deviceId, role: "operator", gatewayID: configuration.gatewayID, profile: .primary)?
            .scopes ?? []
    }

    func requireSetupRecovery() {
        self.recoveryRequired = true
        self.voiceConnection = nil
        self.voiceCall.end()
        self.setupMessage = String(localized: "Access could not be recovered. Enter a new setup code.")
    }

    private func refreshVoiceAvailability() {
        self.setupIncomplete = self.configuration != nil && (
            self.configuration?.link.bootstrapToken != nil
                || !Set(WatchNodeConnectResponse.voiceScopes).isSubset(of: Set(self.storedOperatorScopes())))
        self.voiceConnection = self.isEnabled && !self.setupIncomplete && !self.recoveryRequired
            && self.grantTransition == nil ? self.configuration?.voiceConnection : nil
    }

    private func clearCredentials(deviceID: String, gatewayID: String) {
        for role in ["node", "operator"] {
            DeviceAuthStore.clearToken(deviceId: deviceID, role: role, gatewayID: gatewayID, profile: .primary)
        }
    }

    private static func saveConfiguration(_ configuration: WatchGatewayConfiguration) -> Bool {
        guard let data = try? JSONEncoder().encode(configuration),
              let raw = String(data: data, encoding: .utf8)
        else { return false }
        return GenericPasswordKeychainStore.saveString(
            raw,
            service: self.keychainService,
            account: self.keychainAccount)
    }

    private static func lastAcceptedSetupSentAtMs() -> Int64 {
        (UserDefaults.standard.object(forKey: self.lastSetupSentAtDefaultsKey) as? NSNumber)?.int64Value ?? 0
    }

    private static func saveLastAcceptedSetupSentAtMs(_ sentAtMs: Int64) {
        UserDefaults.standard.set(NSNumber(value: sentAtMs), forKey: self.lastSetupSentAtDefaultsKey)
    }
}
