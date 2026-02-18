import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import Observation
import os
import SwiftUI
import UIKit
import UserNotifications

// Wrap errors without pulling non-Sendable types into async notification paths.
private struct NotificationCallError: Error, Sendable {
    let message: String
}
// Ensures notification requests return promptly even if the system prompt blocks.
private final class NotificationInvokeLatch<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Result<T, NotificationCallError>, Never>?
    private var resumed = false

    func setContinuation(_ continuation: CheckedContinuation<Result<T, NotificationCallError>, Never>) {
        self.lock.lock()
        defer { self.lock.unlock() }
        self.continuation = continuation
    }

    func resume(_ response: Result<T, NotificationCallError>) {
        let cont: CheckedContinuation<Result<T, NotificationCallError>, Never>?
        self.lock.lock()
        if self.resumed {
            self.lock.unlock()
            return
        }
        self.resumed = true
        cont = self.continuation
        self.continuation = nil
        self.lock.unlock()
        cont?.resume(returning: response)
    }
}
@MainActor
@Observable
final class NodeAppModel {
    private let deepLinkLogger = Logger(subsystem: "ai.openclaw.ios", category: "DeepLink")
    private let pushWakeLogger = Logger(subsystem: "ai.openclaw.ios", category: "PushWake")
    enum CameraHUDKind {
        case photo
        case recording
        case success
        case error
    }

    var isBackgrounded: Bool = false
    let screen: ScreenController
    private let camera: any CameraServicing
    private let screenRecorder: any ScreenRecordingServicing
    var gatewayStatusText: String = "Offline"
    var nodeStatusText: String = "Offline"
    var operatorStatusText: String = "Offline"
    var gatewayServerName: String?
    var gatewayRemoteAddress: String?
    var connectedGatewayID: String?
    var gatewayAutoReconnectEnabled: Bool = true
    // When the gateway requires pairing approval, we pause reconnect churn and show a stable UX.
    // Reconnect loops (both our own and the underlying WebSocket watchdog) can otherwise generate
    // multiple pending requests and cause the onboarding UI to "flip-flop".
    var gatewayPairingPaused: Bool = false
    var gatewayPairingRequestId: String?
    var seamColorHex: String?
    private var mainSessionBaseKey: String = "main"
    var selectedAgentId: String?
    var gatewayDefaultAgentId: String?
    var gatewayAgents: [AgentSummary] = []
    var lastShareEventText: String = "No share events yet."
    var openChatRequestID: Int = 0

    // Primary "node" connection: used for device capabilities and node.invoke requests.
    private let nodeGateway = GatewayNodeSession()
    // Secondary "operator" connection: used for chat/talk/config/voicewake requests.
    private let operatorGateway = GatewayNodeSession()
    private var nodeGatewayTask: Task<Void, Never>?
    private var operatorGatewayTask: Task<Void, Never>?
    private var voiceWakeSyncTask: Task<Void, Never>?
    @ObservationIgnored private var cameraHUDDismissTask: Task<Void, Never>?
    @ObservationIgnored private lazy var capabilityRouter: NodeCapabilityRouter = self.buildCapabilityRouter()
    private let gatewayHealthMonitor = GatewayHealthMonitor()
    private var gatewayHealthMonitorDisabled = false
    private let notificationCenter: NotificationCentering
    let voiceWake = VoiceWakeManager()
    let talkMode: TalkModeManager
    private let locationService: any LocationServicing
    private let deviceStatusService: any DeviceStatusServicing
    private let photosService: any PhotosServicing
    private let contactsService: any ContactsServicing
    private let calendarService: any CalendarServicing
    private let remindersService: any RemindersServicing
    private let motionService: any MotionServicing
    private let watchMessagingService: any WatchMessagingServicing
    var lastAutoA2uiURL: String?
    private var pttVoiceWakeSuspended = false
    private var talkVoiceWakeSuspended = false
    private var backgroundVoiceWakeSuspended = false
    private var backgroundTalkSuspended = false
    private var backgroundTalkKeptActive = false
    private var backgroundedAt: Date?
    private var reconnectAfterBackgroundArmed = false

    private var gatewayConnected = false
    private var operatorConnected = false
    private var shareDeliveryChannel: String?
    private var shareDeliveryTo: String?
    private var apnsDeviceTokenHex: String?
    private var apnsLastRegisteredTokenHex: String?
    var gatewaySession: GatewayNodeSession { self.nodeGateway }
    var operatorSession: GatewayNodeSession { self.operatorGateway }
    private(set) var activeGatewayConnectConfig: GatewayConnectConfig?

    var cameraHUDText: String?
    var cameraHUDKind: CameraHUDKind?
    var cameraFlashNonce: Int = 0
    var screenRecordActive: Bool = false

    init(
        screen: ScreenController = ScreenController(),
        camera: any CameraServicing = CameraController(),
        screenRecorder: any ScreenRecordingServicing = ScreenRecordService(),
        locationService: any LocationServicing = LocationService(),
        notificationCenter: NotificationCentering = LiveNotificationCenter(),
        deviceStatusService: any DeviceStatusServicing = DeviceStatusService(),
        photosService: any PhotosServicing = PhotoLibraryService(),
        contactsService: any ContactsServicing = ContactsService(),
        calendarService: any CalendarServicing = CalendarService(),
        remindersService: any RemindersServicing = RemindersService(),
        motionService: any MotionServicing = MotionService(),
        watchMessagingService: any WatchMessagingServicing = WatchMessagingService(),
        talkMode: TalkModeManager = TalkModeManager())
    {
        self.screen = screen
        self.camera = camera
        self.screenRecorder = screenRecorder
        self.locationService = locationService
        self.notificationCenter = notificationCenter
        self.deviceStatusService = deviceStatusService
        self.photosService = photosService
        self.contactsService = contactsService
        self.calendarService = calendarService
        self.remindersService = remindersService
        self.motionService = motionService
        self.watchMessagingService = watchMessagingService
        self.talkMode = talkMode
        self.apnsDeviceTokenHex = UserDefaults.standard.string(forKey: Self.apnsDeviceTokenUserDefaultsKey)
        GatewayDiagnostics.bootstrap()

        self.voiceWake.configure { [weak self] cmd in
            guard let self else { return }
            let sessionKey = await MainActor.run { self.mainSessionKey }
            do {
                try await self.sendVoiceTranscript(text: cmd, sessionKey: sessionKey)
            } catch {
                // Best-effort only.
            }
        }

        let enabled = UserDefaults.standard.bool(forKey: "voiceWake.enabled")
        self.voiceWake.setEnabled(enabled)
        self.talkMode.attachGateway(self.operatorGateway)
        self.refreshLastShareEventFromRelay()
        let talkEnabled = UserDefaults.standard.bool(forKey: "talk.enabled")
        // Route through the coordinator so VoiceWake and Talk don't fight over the microphone.
        self.setTalkEnabled(talkEnabled)

        // Wire up deep links from canvas taps
        self.screen.onDeepLink = { [weak self] url in
            guard let self else { return }
            Task { @MainActor in
                await self.handleDeepLink(url: url)
            }
        }

        // Wire up A2UI action clicks (buttons, etc.)
        self.screen.onA2UIAction = { [weak self] body in
            guard let self else { return }
            Task { @MainActor in
                await self.handleCanvasA2UIAction(body: body)
            }
        }
    }

    private func handleCanvasA2UIAction(body: [String: Any]) async {
        let userActionAny = body["userAction"] ?? body
        let userAction: [String: Any] = {
            if let dict = userActionAny as? [String: Any] { return dict }
            if let dict = userActionAny as? [AnyHashable: Any] {
                return dict.reduce(into: [String: Any]()) { acc, pair in
                    guard let key = pair.key as? String else { return }
                    acc[key] = pair.value
                }
            }
            return [:]
        }()
        guard !userAction.isEmpty else { return }

        guard let name = OpenClawCanvasA2UIAction.extractActionName(userAction) else { return }
        let actionId: String = {
            let id = (userAction["id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return id.isEmpty ? UUID().uuidString : id
        }()

        let surfaceId: String = {
            let raw = (userAction["surfaceId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return raw.isEmpty ? "main" : raw
        }()
        let sourceComponentId: String = {
            let raw = (userAction[
                "sourceComponentId",
            ] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return raw.isEmpty ? "-" : raw
        }()

        let host = NodeDisplayName.resolve(
            existing: UserDefaults.standard.string(forKey: "node.displayName"),
            deviceName: UIDevice.current.name,
            interfaceIdiom: UIDevice.current.userInterfaceIdiom)
        let instanceId = (UserDefaults.standard.string(forKey: "node.instanceId") ?? "ios-node").lowercased()
        let contextJSON = OpenClawCanvasA2UIAction.compactJSON(userAction["context"])
        let sessionKey = self.mainSessionKey

        let messageContext = OpenClawCanvasA2UIAction.AgentMessageContext(
            actionName: name,
            session: .init(key: sessionKey, surfaceId: surfaceId),
            component: .init(id: sourceComponentId, host: host, instanceId: instanceId),
            contextJSON: contextJSON)
        let message = OpenClawCanvasA2UIAction.formatAgentMessage(messageContext)

        let ok: Bool
        var errorText: String?
        if await !self.isGatewayConnected() {
            ok = false
            errorText = "gateway not connected"
        } else {
            do {
                try await self.sendAgentRequest(link: AgentDeepLink(
                    message: message,
                    sessionKey: sessionKey,
                    thinking: "low",
                    deliver: false,
                    to: nil,
                    channel: nil,
                    timeoutSeconds: nil,
                    key: actionId))
                ok = true
            } catch {
                ok = false
                errorText = error.localizedDescription
            }
        }

        let js = OpenClawCanvasA2UIAction.jsDispatchA2UIActionStatus(actionId: actionId, ok: ok, error: errorText)
        do {
            _ = try await self.screen.eval(javaScript: js)
        } catch {
            // ignore
        }
    }


    func setScenePhase(_ phase: ScenePhase) {
        let keepTalkActive = UserDefaults.standard.bool(forKey: "talk.background.enabled")
        switch phase {
        case .background:
            self.isBackgrounded = true
            self.stopGatewayHealthMonitor()
            self.backgroundedAt = Date()
            self.reconnectAfterBackgroundArmed = true
            // Release voice wake mic in background.
            self.backgroundVoiceWakeSuspended = self.voiceWake.suspendForExternalAudioCapture()
            let shouldKeepTalkActive = keepTalkActive && self.talkMode.isEnabled
            self.backgroundTalkKeptActive = shouldKeepTalkActive
            self.backgroundTalkSuspended = self.talkMode.suspendForBackground(keepActive: shouldKeepTalkActive)
        case .active, .inactive:
            self.isBackgrounded = false
            if self.operatorConnected {
                self.startGatewayHealthMonitor()
            }
            if phase == .active {
                self.voiceWake.resumeAfterExternalAudioCapture(wasSuspended: self.backgroundVoiceWakeSuspended)
                self.backgroundVoiceWakeSuspended = false
                Task { [weak self] in
                    guard let self else { return }
                    let suspended = await MainActor.run { self.backgroundTalkSuspended }
                    let keptActive = await MainActor.run { self.backgroundTalkKeptActive }
                    await MainActor.run {
                        self.backgroundTalkSuspended = false
                        self.backgroundTalkKeptActive = false
                    }
                    await self.talkMode.resumeAfterBackground(wasSuspended: suspended, wasKeptActive: keptActive)
                }
            }
            if phase == .active, self.reconnectAfterBackgroundArmed {
                self.reconnectAfterBackgroundArmed = false
                let backgroundedFor = self.backgroundedAt.map { Date().timeIntervalSince($0) } ?? 0
                self.backgroundedAt = nil
                // iOS may suspend network sockets in background without a clean close.
                // On foreground, force a fresh handshake to avoid "connected but dead" states.
                if backgroundedFor >= 3.0 {
                    Task { [weak self] in
                        guard let self else { return }
                        let operatorWasConnected = await MainActor.run { self.operatorConnected }
                        if operatorWasConnected {
                            // Prefer keeping the connection if it's healthy; reconnect only when needed.
                            let healthy = (try? await self.operatorGateway.request(
                                method: "health",
                                paramsJSON: nil,
                                timeoutSeconds: 2)) != nil
                            if healthy {
                                await MainActor.run { self.startGatewayHealthMonitor() }
                                return
                            }
                        }

                        await self.operatorGateway.disconnect()
                        await self.nodeGateway.disconnect()
                        await MainActor.run {
                            self.operatorConnected = false
                            self.gatewayConnected = false
                            self.talkMode.updateGatewayConnected(false)
                        }
                    }
                }
            }
        @unknown default:
            self.isBackgrounded = false
        }
    }

    func setVoiceWakeEnabled(_ enabled: Bool) {
        self.voiceWake.setEnabled(enabled)
        if enabled {
            // If talk is enabled, voice wake should not grab the mic.
            if self.talkMode.isEnabled {
                self.voiceWake.setSuppressedByTalk(true)
                self.talkVoiceWakeSuspended = self.voiceWake.suspendForExternalAudioCapture()
            }
        } else {
            self.voiceWake.setSuppressedByTalk(false)
            self.talkVoiceWakeSuspended = false
        }
    }

    func setTalkEnabled(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: "talk.enabled")
        if enabled {
            // Voice wake holds the microphone continuously; talk mode needs exclusive access for STT.
            // When talk is enabled from the UI, prioritize talk and pause voice wake.
            self.voiceWake.setSuppressedByTalk(true)
            self.talkVoiceWakeSuspended = self.voiceWake.suspendForExternalAudioCapture()
        } else {
            self.voiceWake.setSuppressedByTalk(false)
            self.voiceWake.resumeAfterExternalAudioCapture(wasSuspended: self.talkVoiceWakeSuspended)
            self.talkVoiceWakeSuspended = false
        }
        self.talkMode.setEnabled(enabled)
        Task { [weak self] in
            await self?.pushTalkModeToGateway(
                enabled: enabled,
                phase: enabled ? "enabled" : "disabled")
        }
    }

    func requestLocationPermissions(mode: OpenClawLocationMode) async -> Bool {
        guard mode != .off else { return true }
        let status = await self.locationService.ensureAuthorization(mode: mode)
        switch status {
        case .authorizedAlways:
            return true
        case .authorizedWhenInUse:
            return mode != .always
        default:
            return false
        }
    }

    private func applyMainSessionKey(_ key: String?) {
        let trimmed = (key ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let current = self.mainSessionBaseKey.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed == current { return }
        self.mainSessionBaseKey = trimmed
        self.talkMode.updateMainSessionKey(self.mainSessionKey)
    }

    var seamColor: Color {
        Self.color(fromHex: self.seamColorHex) ?? Self.defaultSeamColor
    }

    private static let defaultSeamColor = Color(red: 79 / 255.0, green: 122 / 255.0, blue: 154 / 255.0)
    private static let apnsDeviceTokenUserDefaultsKey = "push.apns.deviceTokenHex"
    private static var apnsEnvironment: String {
#if DEBUG
        "sandbox"
#else
        "production"
#endif
    }

    private static func color(fromHex raw: String?) -> Color? {
        let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let hex = trimmed.hasPrefix("#") ? String(trimmed.dropFirst()) : trimmed
        guard hex.count == 6, let value = Int(hex, radix: 16) else { return nil }
        let r = Double((value >> 16) & 0xFF) / 255.0
        let g = Double((value >> 8) & 0xFF) / 255.0
        let b = Double(value & 0xFF) / 255.0
        return Color(red: r, green: g, blue: b)
    }

    private func refreshBrandingFromGateway() async {
        do {
            let res = try await self.operatorGateway.request(method: "config.get", paramsJSON: "{}", timeoutSeconds: 8)
            guard let json = try JSONSerialization.jsonObject(with: res) as? [String: Any] else { return }
            guard let config = json["config"] as? [String: Any] else { return }
            let ui = config["ui"] as? [String: Any]
            let raw = (ui?["seamColor"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let session = config["session"] as? [String: Any]
            let mainKey = SessionKey.normalizeMainKey(session?["mainKey"] as? String)
            await MainActor.run {
                self.seamColorHex = raw.isEmpty ? nil : raw
                self.mainSessionBaseKey = mainKey
                self.talkMode.updateMainSessionKey(self.mainSessionKey)
            }
        } catch {
            if let gatewayError = error as? GatewayResponseError {
                let lower = gatewayError.message.lowercased()
                if lower.contains("unauthorized role") {
                    return
                }
            }
            // ignore
        }
    }

    private func refreshAgentsFromGateway() async {
        do {
            let res = try await self.operatorGateway.request(method: "agents.list", paramsJSON: "{}", timeoutSeconds: 8)
            let decoded = try JSONDecoder().decode(AgentsListResult.self, from: res)
            await MainActor.run {
                self.gatewayDefaultAgentId = decoded.defaultid
                self.gatewayAgents = decoded.agents
                self.applyMainSessionKey(decoded.mainkey)

                let selected = (self.selectedAgentId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if !selected.isEmpty && !decoded.agents.contains(where: { $0.id == selected }) {
                    self.selectedAgentId = nil
                }
                self.talkMode.updateMainSessionKey(self.mainSessionKey)
            }
        } catch {
            // Best-effort only.
        }
    }

    func setSelectedAgentId(_ agentId: String?) {
        let trimmed = (agentId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let stableID = (self.connectedGatewayID ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if stableID.isEmpty {
            self.selectedAgentId = trimmed.isEmpty ? nil : trimmed
        } else {
            self.selectedAgentId = trimmed.isEmpty ? nil : trimmed
            GatewaySettingsStore.saveGatewaySelectedAgentId(stableID: stableID, agentId: self.selectedAgentId)
        }
        self.talkMode.updateMainSessionKey(self.mainSessionKey)
        if let relay = ShareGatewayRelaySettings.loadConfig() {
            ShareGatewayRelaySettings.saveConfig(
                ShareGatewayRelayConfig(
                    gatewayURLString: relay.gatewayURLString,
                    token: relay.token,
                    password: relay.password,
                    sessionKey: self.mainSessionKey,
                    deliveryChannel: self.shareDeliveryChannel,
                    deliveryTo: self.shareDeliveryTo))
        }
    }

    func setGlobalWakeWords(_ words: [String]) async {
        let sanitized = VoiceWakePreferences.sanitizeTriggerWords(words)

        struct Payload: Codable {
            var triggers: [String]
        }
        let payload = Payload(triggers: sanitized)
        guard let data = try? JSONEncoder().encode(payload),
              let json = String(data: data, encoding: .utf8)
        else { return }

        do {
            _ = try await self.operatorGateway.request(method: "voicewake.set", paramsJSON: json, timeoutSeconds: 12)
        } catch {
            // Best-effort only.
        }
    }

    private func startVoiceWakeSync() async {
        self.voiceWakeSyncTask?.cancel()
        self.voiceWakeSyncTask = Task { [weak self] in
            guard let self else { return }

            if !(await self.isGatewayHealthMonitorDisabled()) {
                await self.refreshWakeWordsFromGateway()
            }

            let stream = await self.operatorGateway.subscribeServerEvents(bufferingNewest: 200)
            for await evt in stream {
                if Task.isCancelled { return }
                guard let payload = evt.payload else { continue }
                switch evt.event {
                case "voicewake.changed":
                    struct Payload: Decodable { var triggers: [String] }
                    guard let decoded = try? GatewayPayloadDecoding.decode(payload, as: Payload.self) else { continue }
                    let triggers = VoiceWakePreferences.sanitizeTriggerWords(decoded.triggers)
                    VoiceWakePreferences.saveTriggerWords(triggers)
                case "talk.mode":
                    struct Payload: Decodable {
                        var enabled: Bool
                        var phase: String?
                    }
                    guard let decoded = try? GatewayPayloadDecoding.decode(payload, as: Payload.self) else { continue }
                    self.applyTalkModeSync(enabled: decoded.enabled, phase: decoded.phase)
                default:
                    continue
                }
            }
        }
    }

    private func applyTalkModeSync(enabled: Bool, phase: String?) {
        _ = phase
        guard self.talkMode.isEnabled != enabled else { return }
        self.setTalkEnabled(enabled)
    }

    private func pushTalkModeToGateway(enabled: Bool, phase: String?) async {
        guard await self.isOperatorConnected() else { return }
        struct TalkModePayload: Encodable {
            var enabled: Bool
            var phase: String?
        }
        let payload = TalkModePayload(enabled: enabled, phase: phase)
        guard let data = try? JSONEncoder().encode(payload),
              let json = String(data: data, encoding: .utf8)
        else { return }
        _ = try? await self.operatorGateway.request(
            method: "talk.mode",
            paramsJSON: json,
            timeoutSeconds: 8)
    }

    private func startGatewayHealthMonitor() {
        self.gatewayHealthMonitorDisabled = false
        self.gatewayHealthMonitor.start(
            check: { [weak self] in
                guard let self else { return false }
                if await self.isGatewayHealthMonitorDisabled() { return true }
                do {
                    let data = try await self.operatorGateway.request(method: "health", paramsJSON: nil, timeoutSeconds: 6)
                    guard let decoded = try? JSONDecoder().decode(OpenClawGatewayHealthOK.self, from: data) else {
                        return false
                    }
                    return decoded.ok ?? false
                } catch {
                    if let gatewayError = error as? GatewayResponseError {
                        let lower = gatewayError.message.lowercased()
                        if lower.contains("unauthorized role") {
                            await self.setGatewayHealthMonitorDisabled(true)
                            return true
                        }
                    }
                    return false
                }
            },
            onFailure: { [weak self] _ in
                guard let self else { return }
                await self.operatorGateway.disconnect()
                await self.nodeGateway.disconnect()
                await MainActor.run {
                    self.operatorConnected = false
                    self.gatewayConnected = false
                    self.gatewayStatusText = "Reconnecting…"
                    self.talkMode.updateGatewayConnected(false)
                }
            })
    }

    private func stopGatewayHealthMonitor() {
        self.gatewayHealthMonitor.stop()
    }

    private func refreshWakeWordsFromGateway() async {
        do {
            let data = try await self.operatorGateway.request(method: "voicewake.get", paramsJSON: "{}", timeoutSeconds: 8)
            guard let triggers = VoiceWakePreferences.decodeGatewayTriggers(from: data) else { return }
            VoiceWakePreferences.saveTriggerWords(triggers)
        } catch {
            if let gatewayError = error as? GatewayResponseError {
                let lower = gatewayError.message.lowercased()
                if lower.contains("unauthorized role") {
                    await self.setGatewayHealthMonitorDisabled(true)
                    return
                }
            }
            // Best-effort only.
        }
    }

    private func isGatewayHealthMonitorDisabled() -> Bool {
        self.gatewayHealthMonitorDisabled
    }

    private func setGatewayHealthMonitorDisabled(_ disabled: Bool) {
        self.gatewayHealthMonitorDisabled = disabled
    }

    func sendVoiceTranscript(text: String, sessionKey: String?) async throws {
        if await !self.isGatewayConnected() {
            throw NSError(domain: "Gateway", code: 10, userInfo: [
                NSLocalizedDescriptionKey: "Gateway not connected",
            ])
        }
        struct Payload: Codable {
            var text: String
            var sessionKey: String?
        }
        let payload = Payload(text: text, sessionKey: sessionKey)
        let data = try JSONEncoder().encode(payload)
        guard let json = String(bytes: data, encoding: .utf8) else {
            throw NSError(domain: "NodeAppModel", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Failed to encode voice transcript payload as UTF-8",
            ])
        }
        await self.nodeGateway.sendEvent(event: "voice.transcript", payloadJSON: json)
    }

    func handleDeepLink(url: URL) async {
        guard let route = DeepLinkParser.parse(url) else { return }

        switch route {
        case let .agent(link):
            await self.handleAgentDeepLink(link, originalURL: url)
        case .gateway:
            break
        }
    }

    private func handleAgentDeepLink(_ link: AgentDeepLink, originalURL: URL) async {
        let message = link.message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else { return }
        self.deepLinkLogger.info(
            "agent deep link received messageChars=\(message.count) url=\(originalURL.absoluteString, privacy: .public)"
        )

        if message.count > 20000 {
            self.screen.errorText = "Deep link too large (message exceeds 20,000 characters)."
            self.recordShareEvent("Rejected: message too large (\(message.count) chars).")
            return
        }

        guard await self.isGatewayConnected() else {
            self.screen.errorText = "Gateway not connected (cannot forward deep link)."
            self.recordShareEvent("Failed: gateway not connected.")
            self.deepLinkLogger.error("agent deep link rejected: gateway not connected")
            return
        }

        do {
            try await self.sendAgentRequest(link: link)
            self.screen.errorText = nil
            self.recordShareEvent("Sent to gateway (\(message.count) chars).")
            self.deepLinkLogger.info("agent deep link forwarded to gateway")
            self.openChatRequestID &+= 1
        } catch {
            self.screen.errorText = "Agent request failed: \(error.localizedDescription)"
            self.recordShareEvent("Failed: \(error.localizedDescription)")
            self.deepLinkLogger.error("agent deep link send failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func sendAgentRequest(link: AgentDeepLink) async throws {
        if link.message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw NSError(domain: "DeepLink", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "invalid agent message",
            ])
        }

        // iOS gateway forwards to the gateway; no local auth prompts here.
        // (Key-based unattended auth is handled on macOS for openclaw:// links.)
        let data = try JSONEncoder().encode(link)
        guard let json = String(bytes: data, encoding: .utf8) else {
            throw NSError(domain: "NodeAppModel", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "Failed to encode agent request payload as UTF-8",
            ])
        }
        await self.nodeGateway.sendEvent(event: "agent.request", payloadJSON: json)
    }

    private func isGatewayConnected() async -> Bool {
        self.gatewayConnected
    }

    private func handleInvoke(_ req: BridgeInvokeRequest) async -> BridgeInvokeResponse {
        let command = req.command

        if self.isBackgrounded, self.isBackgroundRestricted(command) {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(
                    code: .backgroundUnavailable,
                    message: "NODE_BACKGROUND_UNAVAILABLE: canvas/camera/screen commands require foreground"))
        }

        if command.hasPrefix("camera."), !self.isCameraEnabled() {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(
                    code: .unavailable,
                    message: "CAMERA_DISABLED: enable Camera in iOS Settings → Camera → Allow Camera"))
        }

        do {
            return try await self.capabilityRouter.handle(req)
        } catch let error as NodeCapabilityRouter.RouterError {
            switch error {
            case .unknownCommand:
                return BridgeInvokeResponse(
                    id: req.id,
                    ok: false,
                    error: OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown command"))
            case .handlerUnavailable:
                return BridgeInvokeResponse(
                    id: req.id,
                    ok: false,
                    error: OpenClawNodeError(code: .unavailable, message: "node handler unavailable"))
            }
        } catch {
            if command.hasPrefix("camera.") {
                let text = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                self.showCameraHUD(text: text, kind: .error, autoHideSeconds: 2.2)
            }
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .unavailable, message: error.localizedDescription))
        }
    }

    private func isBackgroundRestricted(_ command: String) -> Bool {
        command.hasPrefix("canvas.") || command.hasPrefix("camera.") || command.hasPrefix("screen.") ||
            command.hasPrefix("talk.")
    }

    private func handleLocationInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        let mode = self.locationMode()
        guard mode != .off else {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(
                    code: .unavailable,
                    message: "LOCATION_DISABLED: enable Location in Settings"))
        }
        if self.isBackgrounded, mode != .always {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(
                    code: .backgroundUnavailable,
                    message: "LOCATION_BACKGROUND_UNAVAILABLE: background location requires Always"))
        }
        let params = (try? Self.decodeParams(OpenClawLocationGetParams.self, from: req.paramsJSON)) ??
            OpenClawLocationGetParams()
        let desired = params.desiredAccuracy ??
            (self.isLocationPreciseEnabled() ? .precise : .balanced)
        let status = self.locationService.authorizationStatus()
        if status != .authorizedAlways, status != .authorizedWhenInUse {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(
                    code: .unavailable,
                    message: "LOCATION_PERMISSION_REQUIRED: grant Location permission"))
        }
        if self.isBackgrounded, status != .authorizedAlways {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(
                    code: .unavailable,
                    message: "LOCATION_PERMISSION_REQUIRED: enable Always for background access"))
        }
        let location = try await self.locationService.currentLocation(
            params: params,
            desiredAccuracy: desired,
            maxAgeMs: params.maxAgeMs,
            timeoutMs: params.timeoutMs)
        let isPrecise = self.locationService.accuracyAuthorization() == .fullAccuracy
        let payload = OpenClawLocationPayload(
            lat: location.coordinate.latitude,
            lon: location.coordinate.longitude,
            accuracyMeters: location.horizontalAccuracy,
            altitudeMeters: location.verticalAccuracy >= 0 ? location.altitude : nil,
            speedMps: location.speed >= 0 ? location.speed : nil,
            headingDeg: location.course >= 0 ? location.course : nil,
            timestamp: ISO8601DateFormatter().string(from: location.timestamp),
            isPrecise: isPrecise,
            source: nil)
        let json = try Self.encodePayload(payload)
        return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
    }

    private func handleCanvasInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        switch req.command {
        case OpenClawCanvasCommand.present.rawValue:
            // iOS ignores placement hints; canvas always fills the screen.
            let params = (try? Self.decodeParams(OpenClawCanvasPresentParams.self, from: req.paramsJSON)) ??
                OpenClawCanvasPresentParams()
            let url = params.url?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if url.isEmpty {
                self.screen.showDefaultCanvas()
            } else {
                self.screen.navigate(to: url)
            }
            return BridgeInvokeResponse(id: req.id, ok: true)
        case OpenClawCanvasCommand.hide.rawValue:
            self.screen.showDefaultCanvas()
            return BridgeInvokeResponse(id: req.id, ok: true)
        case OpenClawCanvasCommand.navigate.rawValue:
            let params = try Self.decodeParams(OpenClawCanvasNavigateParams.self, from: req.paramsJSON)
            self.screen.navigate(to: params.url)
            return BridgeInvokeResponse(id: req.id, ok: true)
        case OpenClawCanvasCommand.evalJS.rawValue:
            let params = try Self.decodeParams(OpenClawCanvasEvalParams.self, from: req.paramsJSON)
            let result = try await self.screen.eval(javaScript: params.javaScript)
            let payload = try Self.encodePayload(["result": result])
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
        case OpenClawCanvasCommand.snapshot.rawValue:
            let params = try? Self.decodeParams(OpenClawCanvasSnapshotParams.self, from: req.paramsJSON)
            let format = params?.format ?? .jpeg
            let maxWidth: CGFloat? = {
                if let raw = params?.maxWidth, raw > 0 { return CGFloat(raw) }
                // Keep default snapshots comfortably below the gateway client's maxPayload.
                // For full-res, clients should explicitly request a larger maxWidth.
                return switch format {
                case .png: 900
                case .jpeg: 1600
                }
            }()
            let base64 = try await self.screen.snapshotBase64(
                maxWidth: maxWidth,
                format: format,
                quality: params?.quality)
            let payload = try Self.encodePayload([
                "format": format == .jpeg ? "jpeg" : "png",
                "base64": base64,
            ])
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
        default:
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown command"))
        }
    }

    private func handleCanvasA2UIInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        let command = req.command
        switch command {
        case OpenClawCanvasA2UICommand.reset.rawValue:
            guard let a2uiUrl = await self.resolveA2UIHostURL() else {
                return BridgeInvokeResponse(
                    id: req.id,
                    ok: false,
                    error: OpenClawNodeError(
                        code: .unavailable,
                        message: "A2UI_HOST_NOT_CONFIGURED: gateway did not advertise canvas host"))
            }
            self.screen.navigate(to: a2uiUrl)
            if await !self.screen.waitForA2UIReady(timeoutMs: 5000) {
                return BridgeInvokeResponse(
                    id: req.id,
                    ok: false,
                    error: OpenClawNodeError(
                        code: .unavailable,
                        message: "A2UI_HOST_UNAVAILABLE: A2UI host not reachable"))
            }

            let json = try await self.screen.eval(javaScript: """
            (() => {
              const host = globalThis.openclawA2UI;
              if (!host) return JSON.stringify({ ok: false, error: "missing openclawA2UI" });
              return JSON.stringify(host.reset());
            })()
            """)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        case OpenClawCanvasA2UICommand.push.rawValue, OpenClawCanvasA2UICommand.pushJSONL.rawValue:
            let messages: [OpenClawKit.AnyCodable]
            if command == OpenClawCanvasA2UICommand.pushJSONL.rawValue {
                let params = try Self.decodeParams(OpenClawCanvasA2UIPushJSONLParams.self, from: req.paramsJSON)
                messages = try OpenClawCanvasA2UIJSONL.decodeMessagesFromJSONL(params.jsonl)
            } else {
                do {
                    let params = try Self.decodeParams(OpenClawCanvasA2UIPushParams.self, from: req.paramsJSON)
                    messages = params.messages
                } catch {
                    // Be forgiving: some clients still send JSONL payloads to `canvas.a2ui.push`.
                    let params = try Self.decodeParams(OpenClawCanvasA2UIPushJSONLParams.self, from: req.paramsJSON)
                    messages = try OpenClawCanvasA2UIJSONL.decodeMessagesFromJSONL(params.jsonl)
                }
            }

            guard let a2uiUrl = await self.resolveA2UIHostURL() else {
                return BridgeInvokeResponse(
                    id: req.id,
                    ok: false,
                    error: OpenClawNodeError(
                        code: .unavailable,
                        message: "A2UI_HOST_NOT_CONFIGURED: gateway did not advertise canvas host"))
            }
            self.screen.navigate(to: a2uiUrl)
            if await !self.screen.waitForA2UIReady(timeoutMs: 5000) {
                return BridgeInvokeResponse(
                    id: req.id,
                    ok: false,
                    error: OpenClawNodeError(
                        code: .unavailable,
                        message: "A2UI_HOST_UNAVAILABLE: A2UI host not reachable"))
            }

            let messagesJSON = try OpenClawCanvasA2UIJSONL.encodeMessagesJSONArray(messages)
            let js = """
            (() => {
              try {
                const host = globalThis.openclawA2UI;
                if (!host) return JSON.stringify({ ok: false, error: "missing openclawA2UI" });
                const messages = \(messagesJSON);
                return JSON.stringify(host.applyMessages(messages));
              } catch (e) {
                return JSON.stringify({ ok: false, error: String(e?.message ?? e) });
              }
            })()
            """
            let resultJSON = try await self.screen.eval(javaScript: js)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: resultJSON)
        default:
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown command"))
        }
    }

    private func handleCameraInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        switch req.command {
        case OpenClawCameraCommand.list.rawValue:
            let devices = await self.camera.listDevices()
            struct Payload: Codable {
                var devices: [CameraController.CameraDeviceInfo]
            }
            let payload = try Self.encodePayload(Payload(devices: devices))
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
        case OpenClawCameraCommand.snap.rawValue:
            self.showCameraHUD(text: "Taking photo…", kind: .photo)
            self.triggerCameraFlash()
            let params = (try? Self.decodeParams(OpenClawCameraSnapParams.self, from: req.paramsJSON)) ??
                OpenClawCameraSnapParams()
            let res = try await self.camera.snap(params: params)

            struct Payload: Codable {
                var format: String
                var base64: String
                var width: Int
                var height: Int
            }
            let payload = try Self.encodePayload(Payload(
                format: res.format,
                base64: res.base64,
                width: res.width,
                height: res.height))
            self.showCameraHUD(text: "Photo captured", kind: .success, autoHideSeconds: 1.6)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
        case OpenClawCameraCommand.clip.rawValue:
            let params = (try? Self.decodeParams(OpenClawCameraClipParams.self, from: req.paramsJSON)) ??
                OpenClawCameraClipParams()

            let suspended = (params.includeAudio ?? true) ? self.voiceWake.suspendForExternalAudioCapture() : false
            defer { self.voiceWake.resumeAfterExternalAudioCapture(wasSuspended: suspended) }

            self.showCameraHUD(text: "Recording…", kind: .recording)
            let res = try await self.camera.clip(params: params)

            struct Payload: Codable {
                var format: String
                var base64: String
                var durationMs: Int
                var hasAudio: Bool
            }
            let payload = try Self.encodePayload(Payload(
                format: res.format,
                base64: res.base64,
                durationMs: res.durationMs,
                hasAudio: res.hasAudio))
            self.showCameraHUD(text: "Clip captured", kind: .success, autoHideSeconds: 1.8)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
        default:
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown command"))
        }
    }

    private func handleScreenRecordInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        let params = (try? Self.decodeParams(OpenClawScreenRecordParams.self, from: req.paramsJSON)) ??
            OpenClawScreenRecordParams()
        if let format = params.format, format.lowercased() != "mp4" {
            throw NSError(domain: "Screen", code: 30, userInfo: [
                NSLocalizedDescriptionKey: "INVALID_REQUEST: screen format must be mp4",
            ])
        }
        // Status pill mirrors screen recording state so it stays visible without overlay stacking.
        self.screenRecordActive = true
        defer { self.screenRecordActive = false }
        let path = try await self.screenRecorder.record(
            screenIndex: params.screenIndex,
            durationMs: params.durationMs,
            fps: params.fps,
            includeAudio: params.includeAudio,
            outPath: nil)
        defer { try? FileManager().removeItem(atPath: path) }
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        struct Payload: Codable {
            var format: String
            var base64: String
            var durationMs: Int?
            var fps: Double?
            var screenIndex: Int?
            var hasAudio: Bool
        }
        let payload = try Self.encodePayload(Payload(
            format: "mp4",
            base64: data.base64EncodedString(),
            durationMs: params.durationMs,
            fps: params.fps,
            screenIndex: params.screenIndex,
            hasAudio: params.includeAudio ?? true))
        return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
    }

    private func handleSystemNotify(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        let params = try Self.decodeParams(OpenClawSystemNotifyParams.self, from: req.paramsJSON)
        let title = params.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = params.body.trimmingCharacters(in: .whitespacesAndNewlines)
        if title.isEmpty, body.isEmpty {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: empty notification"))
        }

        let finalStatus = await self.requestNotificationAuthorizationIfNeeded()
        guard finalStatus == .authorized || finalStatus == .provisional || finalStatus == .ephemeral else {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .unavailable, message: "NOT_AUTHORIZED: notifications"))
        }

        let addResult = await self.runNotificationCall(timeoutSeconds: 2.0) { [notificationCenter] in
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            if #available(iOS 15.0, *) {
                switch params.priority ?? .active {
                case .passive:
                    content.interruptionLevel = .passive
                case .timeSensitive:
                    content.interruptionLevel = .timeSensitive
                case .active:
                    content.interruptionLevel = .active
                }
            }
            let soundValue = params.sound?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if let soundValue, ["none", "silent", "off", "false", "0"].contains(soundValue) {
                content.sound = nil
            } else {
                content.sound = .default
            }
            let request = UNNotificationRequest(
                identifier: UUID().uuidString,
                content: content,
                trigger: nil)
            try await notificationCenter.add(request)
        }
        if case let .failure(error) = addResult {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .unavailable, message: "NOTIFICATION_FAILED: \(error.message)"))
        }
        return BridgeInvokeResponse(id: req.id, ok: true)
    }

    private func handleChatPushInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        let params = try Self.decodeParams(OpenClawChatPushParams.self, from: req.paramsJSON)
        let text = params.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: empty chat.push text"))
        }

        let finalStatus = await self.requestNotificationAuthorizationIfNeeded()
        let messageId = UUID().uuidString
        if finalStatus == .authorized || finalStatus == .provisional || finalStatus == .ephemeral {
            let addResult = await self.runNotificationCall(timeoutSeconds: 2.0) { [notificationCenter] in
                let content = UNMutableNotificationContent()
                content.title = "OpenClaw"
                content.body = text
                content.sound = .default
                content.userInfo = ["messageId": messageId]
                let request = UNNotificationRequest(
                    identifier: messageId,
                    content: content,
                    trigger: nil)
                try await notificationCenter.add(request)
            }
            if case let .failure(error) = addResult {
                return BridgeInvokeResponse(
                    id: req.id,
                    ok: false,
                    error: OpenClawNodeError(code: .unavailable, message: "NOTIFICATION_FAILED: \(error.message)"))
            }
        }

        if params.speak ?? true {
            let toSpeak = text
            Task { @MainActor in
                try? await TalkSystemSpeechSynthesizer.shared.speak(text: toSpeak)
            }
        }

        let payload = OpenClawChatPushPayload(messageId: messageId)
        let json = try Self.encodePayload(payload)
        return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
    }

    private func requestNotificationAuthorizationIfNeeded() async -> NotificationAuthorizationStatus {
        let status = await self.notificationAuthorizationStatus()
        guard status == .notDetermined else { return status }

        // Avoid hanging invoke requests if the permission prompt is never answered.
        _ = await self.runNotificationCall(timeoutSeconds: 2.0) { [notificationCenter] in
            _ = try await notificationCenter.requestAuthorization(options: [.alert, .sound, .badge])
        }

        return await self.notificationAuthorizationStatus()
    }

    private func notificationAuthorizationStatus() async -> NotificationAuthorizationStatus {
        let result = await self.runNotificationCall(timeoutSeconds: 1.5) { [notificationCenter] in
            await notificationCenter.authorizationStatus()
        }
        switch result {
        case let .success(status):
            return status
        case .failure:
            return .denied
        }
    }

    private func runNotificationCall<T: Sendable>(
        timeoutSeconds: Double,
        operation: @escaping @Sendable () async throws -> T
    ) async -> Result<T, NotificationCallError> {
        let latch = NotificationInvokeLatch<T>()
        var opTask: Task<Void, Never>?
        var timeoutTask: Task<Void, Never>?
        defer {
            opTask?.cancel()
            timeoutTask?.cancel()
        }
        let clamped = max(0.0, timeoutSeconds)
        return await withCheckedContinuation { (cont: CheckedContinuation<Result<T, NotificationCallError>, Never>) in
            latch.setContinuation(cont)
            opTask = Task { @MainActor in
                do {
                    let value = try await operation()
                    latch.resume(.success(value))
                } catch {
                    latch.resume(.failure(NotificationCallError(message: error.localizedDescription)))
                }
            }
            timeoutTask = Task.detached {
                if clamped > 0 {
                    try? await Task.sleep(nanoseconds: UInt64(clamped * 1_000_000_000))
                }
                latch.resume(.failure(NotificationCallError(message: "notification request timed out")))
            }
        }
    }

    private func handleDeviceInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        switch req.command {
        case OpenClawDeviceCommand.status.rawValue:
            let payload = try await self.deviceStatusService.status()
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        case OpenClawDeviceCommand.info.rawValue:
            let payload = self.deviceStatusService.info()
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        default:
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown command"))
        }
    }

    private func handlePhotosInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        let params = (try? Self.decodeParams(OpenClawPhotosLatestParams.self, from: req.paramsJSON)) ??
            OpenClawPhotosLatestParams()
        let payload = try await self.photosService.latest(params: params)
        let json = try Self.encodePayload(payload)
        return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
    }

    private func handleContactsInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        switch req.command {
        case OpenClawContactsCommand.search.rawValue:
            let params = (try? Self.decodeParams(OpenClawContactsSearchParams.self, from: req.paramsJSON)) ??
                OpenClawContactsSearchParams()
            let payload = try await self.contactsService.search(params: params)
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        case OpenClawContactsCommand.add.rawValue:
            let params = try Self.decodeParams(OpenClawContactsAddParams.self, from: req.paramsJSON)
            let payload = try await self.contactsService.add(params: params)
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        default:
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown command"))
        }
    }

    private func handleCalendarInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        switch req.command {
        case OpenClawCalendarCommand.events.rawValue:
            let params = (try? Self.decodeParams(OpenClawCalendarEventsParams.self, from: req.paramsJSON)) ??
                OpenClawCalendarEventsParams()
            let payload = try await self.calendarService.events(params: params)
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        case OpenClawCalendarCommand.add.rawValue:
            let params = try Self.decodeParams(OpenClawCalendarAddParams.self, from: req.paramsJSON)
            let payload = try await self.calendarService.add(params: params)
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        default:
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown command"))
        }
    }

    private func handleRemindersInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        switch req.command {
        case OpenClawRemindersCommand.list.rawValue:
            let params = (try? Self.decodeParams(OpenClawRemindersListParams.self, from: req.paramsJSON)) ??
                OpenClawRemindersListParams()
            let payload = try await self.remindersService.list(params: params)
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        case OpenClawRemindersCommand.add.rawValue:
            let params = try Self.decodeParams(OpenClawRemindersAddParams.self, from: req.paramsJSON)
            let payload = try await self.remindersService.add(params: params)
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        default:
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown command"))
        }
    }

    private func handleMotionInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        switch req.command {
        case OpenClawMotionCommand.activity.rawValue:
            let params = (try? Self.decodeParams(OpenClawMotionActivityParams.self, from: req.paramsJSON)) ??
                OpenClawMotionActivityParams()
            let payload = try await self.motionService.activities(params: params)
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        case OpenClawMotionCommand.pedometer.rawValue:
            let params = (try? Self.decodeParams(OpenClawPedometerParams.self, from: req.paramsJSON)) ??
                OpenClawPedometerParams()
            let payload = try await self.motionService.pedometer(params: params)
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        default:
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown command"))
        }
    }

    private func handleTalkInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        switch req.command {
        case OpenClawTalkCommand.pttStart.rawValue:
            self.pttVoiceWakeSuspended = self.voiceWake.suspendForExternalAudioCapture()
            let payload = try await self.talkMode.beginPushToTalk()
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        case OpenClawTalkCommand.pttStop.rawValue:
            let payload = await self.talkMode.endPushToTalk()
            self.voiceWake.resumeAfterExternalAudioCapture(wasSuspended: self.pttVoiceWakeSuspended)
            self.pttVoiceWakeSuspended = false
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        case OpenClawTalkCommand.pttCancel.rawValue:
            let payload = await self.talkMode.cancelPushToTalk()
            self.voiceWake.resumeAfterExternalAudioCapture(wasSuspended: self.pttVoiceWakeSuspended)
            self.pttVoiceWakeSuspended = false
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        case OpenClawTalkCommand.pttOnce.rawValue:
            self.pttVoiceWakeSuspended = self.voiceWake.suspendForExternalAudioCapture()
            defer {
                self.voiceWake.resumeAfterExternalAudioCapture(wasSuspended: self.pttVoiceWakeSuspended)
                self.pttVoiceWakeSuspended = false
            }
            let payload = try await self.talkMode.runPushToTalkOnce()
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        default:
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown command"))
        }
    }

}

private extension NodeAppModel {
    // Central registry for node invoke routing to keep commands in one place.
    func buildCapabilityRouter() -> NodeCapabilityRouter {
        var handlers: [String: NodeCapabilityRouter.Handler] = [:]

        func register(_ commands: [String], handler: @escaping NodeCapabilityRouter.Handler) {
            for command in commands {
                handlers[command] = handler
            }
        }

        register([OpenClawLocationCommand.get.rawValue]) { [weak self] req in
            guard let self else { throw NodeCapabilityRouter.RouterError.handlerUnavailable }
            return try await self.handleLocationInvoke(req)
        }

        register([
            OpenClawCanvasCommand.present.rawValue,
            OpenClawCanvasCommand.hide.rawValue,
            OpenClawCanvasCommand.navigate.rawValue,
            OpenClawCanvasCommand.evalJS.rawValue,
            OpenClawCanvasCommand.snapshot.rawValue,
        ]) { [weak self] req in
            guard let self else { throw NodeCapabilityRouter.RouterError.handlerUnavailable }
            return try await self.handleCanvasInvoke(req)
        }

        register([
            OpenClawCanvasA2UICommand.reset.rawValue,
            OpenClawCanvasA2UICommand.push.rawValue,
            OpenClawCanvasA2UICommand.pushJSONL.rawValue,
        ]) { [weak self] req in
            guard let self else { throw NodeCapabilityRouter.RouterError.handlerUnavailable }
            return try await self.handleCanvasA2UIInvoke(req)
        }

        register([
            OpenClawCameraCommand.list.rawValue,
            OpenClawCameraCommand.snap.rawValue,
            OpenClawCameraCommand.clip.rawValue,
        ]) { [weak self] req in
            guard let self else { throw NodeCapabilityRouter.RouterError.handlerUnavailable }
            return try await self.handleCameraInvoke(req)
        }

        register([OpenClawScreenCommand.record.rawValue]) { [weak self] req in
            guard let self else { throw NodeCapabilityRouter.RouterError.handlerUnavailable }
            return try await self.handleScreenRecordInvoke(req)
        }

        register([OpenClawSystemCommand.notify.rawValue]) { [weak self] req in
            guard let self else { throw NodeCapabilityRouter.RouterError.handlerUnavailable }
            return try await self.handleSystemNotify(req)
        }

        register([OpenClawChatCommand.push.rawValue]) { [weak self] req in
            guard let self else { throw NodeCapabilityRouter.RouterError.handlerUnavailable }
            return try await self.handleChatPushInvoke(req)
        }

        register([
            OpenClawDeviceCommand.status.rawValue,
            OpenClawDeviceCommand.info.rawValue,
        ]) { [weak self] req in
            guard let self else { throw NodeCapabilityRouter.RouterError.handlerUnavailable }
            return try await self.handleDeviceInvoke(req)
        }

        register([
            OpenClawWatchCommand.status.rawValue,
            OpenClawWatchCommand.notify.rawValue,
        ]) { [weak self] req in
            guard let self else { throw NodeCapabilityRouter.RouterError.handlerUnavailable }
            return try await self.handleWatchInvoke(req)
        }

        register([OpenClawPhotosCommand.latest.rawValue]) { [weak self] req in
            guard let self else { throw NodeCapabilityRouter.RouterError.handlerUnavailable }
            return try await self.handlePhotosInvoke(req)
        }

        register([
            OpenClawContactsCommand.search.rawValue,
            OpenClawContactsCommand.add.rawValue,
        ]) { [weak self] req in
            guard let self else { throw NodeCapabilityRouter.RouterError.handlerUnavailable }
            return try await self.handleContactsInvoke(req)
        }

        register([
            OpenClawCalendarCommand.events.rawValue,
            OpenClawCalendarCommand.add.rawValue,
        ]) { [weak self] req in
            guard let self else { throw NodeCapabilityRouter.RouterError.handlerUnavailable }
            return try await self.handleCalendarInvoke(req)
        }

        register([
            OpenClawRemindersCommand.list.rawValue,
            OpenClawRemindersCommand.add.rawValue,
        ]) { [weak self] req in
            guard let self else { throw NodeCapabilityRouter.RouterError.handlerUnavailable }
            return try await self.handleRemindersInvoke(req)
        }

        register([
            OpenClawMotionCommand.activity.rawValue,
            OpenClawMotionCommand.pedometer.rawValue,
        ]) { [weak self] req in
            guard let self else { throw NodeCapabilityRouter.RouterError.handlerUnavailable }
            return try await self.handleMotionInvoke(req)
        }

        register([
            OpenClawTalkCommand.pttStart.rawValue,
            OpenClawTalkCommand.pttStop.rawValue,
            OpenClawTalkCommand.pttCancel.rawValue,
            OpenClawTalkCommand.pttOnce.rawValue,
        ]) { [weak self] req in
            guard let self else { throw NodeCapabilityRouter.RouterError.handlerUnavailable }
            return try await self.handleTalkInvoke(req)
        }

        return NodeCapabilityRouter(handlers: handlers)
    }

    func handleWatchInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        switch req.command {
        case OpenClawWatchCommand.status.rawValue:
            let status = await self.watchMessagingService.status()
            let payload = OpenClawWatchStatusPayload(
                supported: status.supported,
                paired: status.paired,
                appInstalled: status.appInstalled,
                reachable: status.reachable,
                activationState: status.activationState)
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        case OpenClawWatchCommand.notify.rawValue:
            let params = try Self.decodeParams(OpenClawWatchNotifyParams.self, from: req.paramsJSON)
            let title = params.title.trimmingCharacters(in: .whitespacesAndNewlines)
            let body = params.body.trimmingCharacters(in: .whitespacesAndNewlines)
            if title.isEmpty && body.isEmpty {
                return BridgeInvokeResponse(
                    id: req.id,
                    ok: false,
                    error: OpenClawNodeError(
                        code: .invalidRequest,
                        message: "INVALID_REQUEST: empty watch notification"))
            }
            do {
                let result = try await self.watchMessagingService.sendNotification(
                    id: req.id,
                    title: title,
                    body: body,
                    priority: params.priority)
                let payload = OpenClawWatchNotifyPayload(
                    deliveredImmediately: result.deliveredImmediately,
                    queuedForDelivery: result.queuedForDelivery,
                    transport: result.transport)
                let json = try Self.encodePayload(payload)
                return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
            } catch {
                return BridgeInvokeResponse(
                    id: req.id,
                    ok: false,
                    error: OpenClawNodeError(
                        code: .unavailable,
                        message: error.localizedDescription))
            }
        default:
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown command"))
        }
    }

    func locationMode() -> OpenClawLocationMode {
        let raw = UserDefaults.standard.string(forKey: "location.enabledMode") ?? "off"
        return OpenClawLocationMode(rawValue: raw) ?? .off
    }

    func isLocationPreciseEnabled() -> Bool {
        // iOS settings now expose a single location mode control.
        // Default location tool precision stays high unless a command explicitly requests balanced.
        true
    }

    static func decodeParams<T: Decodable>(_ type: T.Type, from json: String?) throws -> T {
        guard let json, let data = json.data(using: .utf8) else {
            throw NSError(domain: "Gateway", code: 20, userInfo: [
                NSLocalizedDescriptionKey: "INVALID_REQUEST: paramsJSON required",
            ])
        }
        return try JSONDecoder().decode(type, from: data)
    }

    static func encodePayload(_ obj: some Encodable) throws -> String {
        let data = try JSONEncoder().encode(obj)
        guard let json = String(bytes: data, encoding: .utf8) else {
            throw NSError(domain: "NodeAppModel", code: 21, userInfo: [
                NSLocalizedDescriptionKey: "Failed to encode payload as UTF-8",
            ])
        }
        return json
    }

    func isCameraEnabled() -> Bool {
        // Default-on: if the key doesn't exist yet, treat it as enabled.
        if UserDefaults.standard.object(forKey: "camera.enabled") == nil { return true }
        return UserDefaults.standard.bool(forKey: "camera.enabled")
    }

    func triggerCameraFlash() {
        self.cameraFlashNonce &+= 1
    }

    func showCameraHUD(text: String, kind: CameraHUDKind, autoHideSeconds: Double? = nil) {
        self.cameraHUDDismissTask?.cancel()

        withAnimation(.spring(response: 0.25, dampingFraction: 0.85)) {
            self.cameraHUDText = text
            self.cameraHUDKind = kind
        }

        guard let autoHideSeconds else { return }
        self.cameraHUDDismissTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(autoHideSeconds * 1_000_000_000))
            withAnimation(.easeOut(duration: 0.25)) {
                self.cameraHUDText = nil
                self.cameraHUDKind = nil
            }
        }
    }
}

extension NodeAppModel {
    var mainSessionKey: String {
        let base = SessionKey.normalizeMainKey(self.mainSessionBaseKey)
        let agentId = (self.selectedAgentId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let defaultId = (self.gatewayDefaultAgentId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if agentId.isEmpty || (!defaultId.isEmpty && agentId == defaultId) { return base }
        return SessionKey.makeAgentSessionKey(agentId: agentId, baseKey: base)
    }

    var activeAgentName: String {
        let agentId = (self.selectedAgentId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let defaultId = (self.gatewayDefaultAgentId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedId = agentId.isEmpty ? defaultId : agentId
        if resolvedId.isEmpty { return "Main" }
        if let match = self.gatewayAgents.first(where: { $0.id == resolvedId }) {
            let name = (match.name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return name.isEmpty ? match.id : name
        }
        return resolvedId
    }

    func connectToGateway(
        url: URL,
        gatewayStableID: String,
        tls: GatewayTLSParams?,
        token: String?,
        password: String?,
        connectOptions: GatewayConnectOptions)
    {
        let stableID = gatewayStableID.trimmingCharacters(in: .whitespacesAndNewlines)
        let effectiveStableID = stableID.isEmpty ? url.absoluteString : stableID
        let sessionBox = tls.map { WebSocketSessionBox(session: GatewayTLSPinningSession(params: $0)) }

        self.activeGatewayConnectConfig = GatewayConnectConfig(
            url: url,
            stableID: stableID,
            tls: tls,
            token: token,
            password: password,
            nodeOptions: connectOptions)
        self.prepareForGatewayConnect(url: url, stableID: effectiveStableID)
        self.startOperatorGatewayLoop(
            url: url,
            stableID: effectiveStableID,
            token: token,
            password: password,
            nodeOptions: connectOptions,
            sessionBox: sessionBox)
        self.startNodeGatewayLoop(
            url: url,
            stableID: effectiveStableID,
            token: token,
            password: password,
            nodeOptions: connectOptions,
            sessionBox: sessionBox)
    }

    /// Preferred entry-point: apply a single config object and start both sessions.
    func applyGatewayConnectConfig(_ cfg: GatewayConnectConfig) {
        self.activeGatewayConnectConfig = cfg
        self.connectToGateway(
            url: cfg.url,
            // Preserve the caller-provided stableID (may be empty) and let connectToGateway
            // derive the effective stable id consistently for persistence keys.
            gatewayStableID: cfg.stableID,
            tls: cfg.tls,
            token: cfg.token,
            password: cfg.password,
            connectOptions: cfg.nodeOptions)
    }

    func disconnectGateway() {
        self.gatewayAutoReconnectEnabled = false
        self.gatewayPairingPaused = false
        self.gatewayPairingRequestId = nil
        self.nodeGatewayTask?.cancel()
        self.nodeGatewayTask = nil
        self.operatorGatewayTask?.cancel()
        self.operatorGatewayTask = nil
        self.voiceWakeSyncTask?.cancel()
        self.voiceWakeSyncTask = nil
        self.gatewayHealthMonitor.stop()
        Task {
            await self.operatorGateway.disconnect()
            await self.nodeGateway.disconnect()
        }
        self.gatewayStatusText = "Offline"
        self.gatewayServerName = nil
        self.gatewayRemoteAddress = nil
        self.connectedGatewayID = nil
        self.activeGatewayConnectConfig = nil
        self.gatewayConnected = false
        self.operatorConnected = false
        self.talkMode.updateGatewayConnected(false)
        self.seamColorHex = nil
        self.mainSessionBaseKey = "main"
        self.talkMode.updateMainSessionKey(self.mainSessionKey)
        ShareGatewayRelaySettings.clearConfig()
        self.showLocalCanvasOnDisconnect()
    }
}

private extension NodeAppModel {
    func prepareForGatewayConnect(url: URL, stableID: String) {
        self.gatewayAutoReconnectEnabled = true
        self.gatewayPairingPaused = false
        self.gatewayPairingRequestId = nil
        self.nodeGatewayTask?.cancel()
        self.operatorGatewayTask?.cancel()
        self.gatewayHealthMonitor.stop()
        self.gatewayServerName = nil
        self.gatewayRemoteAddress = nil
        self.connectedGatewayID = stableID
        self.gatewayConnected = false
        self.operatorConnected = false
        self.voiceWakeSyncTask?.cancel()
        self.voiceWakeSyncTask = nil
        self.gatewayDefaultAgentId = nil
        self.gatewayAgents = []
        self.selectedAgentId = GatewaySettingsStore.loadGatewaySelectedAgentId(stableID: stableID)
        self.apnsLastRegisteredTokenHex = nil
    }

    func startOperatorGatewayLoop(
        url: URL,
        stableID: String,
        token: String?,
        password: String?,
        nodeOptions: GatewayConnectOptions,
        sessionBox: WebSocketSessionBox?)
    {
        // Operator session reconnects independently (chat/talk/config/voicewake), but we tie its
        // lifecycle to the current gateway config so it doesn't keep running across Disconnect.
        self.operatorGatewayTask = Task { [weak self] in
            guard let self else { return }
            var attempt = 0
            while !Task.isCancelled {
                if self.gatewayPairingPaused {
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                    continue
                }
                if !self.gatewayAutoReconnectEnabled {
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                    continue
                }
                if await self.isOperatorConnected() {
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                    continue
                }

                let effectiveClientId =
                    GatewaySettingsStore.loadGatewayClientIdOverride(stableID: stableID) ?? nodeOptions.clientId
                let operatorOptions = self.makeOperatorConnectOptions(
                    clientId: effectiveClientId,
                    displayName: nodeOptions.clientDisplayName)

                do {
                    try await self.operatorGateway.connect(
                        url: url,
                        token: token,
                        password: password,
                        connectOptions: operatorOptions,
                        sessionBox: sessionBox,
                        onConnected: { [weak self] in
                            guard let self else { return }
                            await MainActor.run {
                                self.operatorConnected = true
                                self.talkMode.updateGatewayConnected(true)
                            }
                            GatewayDiagnostics.log(
                                "operator gateway connected host=\(url.host ?? "?") scheme=\(url.scheme ?? "?")")
                            await self.refreshBrandingFromGateway()
                            await self.refreshAgentsFromGateway()
                            await self.refreshShareRouteFromGateway()
                            await self.startVoiceWakeSync()
                            await MainActor.run { self.startGatewayHealthMonitor() }
                        },
                        onDisconnected: { [weak self] reason in
                            guard let self else { return }
                            await MainActor.run {
                                self.operatorConnected = false
                                self.talkMode.updateGatewayConnected(false)
                            }
                            GatewayDiagnostics.log("operator gateway disconnected reason=\(reason)")
                            await MainActor.run { self.stopGatewayHealthMonitor() }
                        },
                        onInvoke: { req in
                            // Operator session should not handle node.invoke requests.
                            BridgeInvokeResponse(
                                id: req.id,
                                ok: false,
                                error: OpenClawNodeError(
                                    code: .invalidRequest,
                                    message: "INVALID_REQUEST: operator session cannot invoke node commands"))
                        })

                    attempt = 0
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                } catch {
                    attempt += 1
                    GatewayDiagnostics.log("operator gateway connect error: \(error.localizedDescription)")
                    let sleepSeconds = min(8.0, 0.5 * pow(1.7, Double(attempt)))
                    try? await Task.sleep(nanoseconds: UInt64(sleepSeconds * 1_000_000_000))
                }
            }
        }
    }

    func startNodeGatewayLoop(
        url: URL,
        stableID: String,
        token: String?,
        password: String?,
        nodeOptions: GatewayConnectOptions,
        sessionBox: WebSocketSessionBox?)
    {
        self.nodeGatewayTask = Task { [weak self] in
            guard let self else { return }
            var attempt = 0
            var currentOptions = nodeOptions
            var didFallbackClientId = false
            var pausedForPairingApproval = false

            while !Task.isCancelled {
                if self.gatewayPairingPaused {
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                    continue
                }
                if !self.gatewayAutoReconnectEnabled {
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                    continue
                }
                if await self.isGatewayConnected() {
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                    continue
                }
                await MainActor.run {
                    self.gatewayStatusText = (attempt == 0) ? "Connecting…" : "Reconnecting…"
                    self.gatewayServerName = nil
                    self.gatewayRemoteAddress = nil
                }

                do {
                    let epochMs = Int(Date().timeIntervalSince1970 * 1000)
                    GatewayDiagnostics.log("connect attempt epochMs=\(epochMs) url=\(url.absoluteString)")
                    try await self.nodeGateway.connect(
                        url: url,
                        token: token,
                        password: password,
                        connectOptions: currentOptions,
                        sessionBox: sessionBox,
                        onConnected: { [weak self] in
                            guard let self else { return }
                            await MainActor.run {
                                self.gatewayStatusText = "Connected"
                                self.gatewayServerName = url.host ?? "gateway"
                                self.gatewayConnected = true
                                self.screen.errorText = nil
                                UserDefaults.standard.set(true, forKey: "gateway.autoconnect")
                            }
                            let relayData = await MainActor.run {
                                (
                                    sessionKey: self.mainSessionKey,
                                    deliveryChannel: self.shareDeliveryChannel,
                                    deliveryTo: self.shareDeliveryTo
                                )
                            }
                            ShareGatewayRelaySettings.saveConfig(
                                ShareGatewayRelayConfig(
                                    gatewayURLString: url.absoluteString,
                                    token: token,
                                    password: password,
                                    sessionKey: relayData.sessionKey,
                                    deliveryChannel: relayData.deliveryChannel,
                                    deliveryTo: relayData.deliveryTo))
                            GatewayDiagnostics.log("gateway connected host=\(url.host ?? "?") scheme=\(url.scheme ?? "?")")
                            if let addr = await self.nodeGateway.currentRemoteAddress() {
                                await MainActor.run { self.gatewayRemoteAddress = addr }
                            }
                            await self.showA2UIOnConnectIfNeeded()
                            await self.onNodeGatewayConnected()
                            await MainActor.run { SignificantLocationMonitor.startIfNeeded(locationService: self.locationService, locationMode: self.locationMode(), gateway: self.nodeGateway) }
                        },
                        onDisconnected: { [weak self] reason in
                            guard let self else { return }
                            await MainActor.run {
                                self.gatewayStatusText = "Disconnected: \(reason)"
                                self.gatewayServerName = nil
                                self.gatewayRemoteAddress = nil
                                self.gatewayConnected = false
                                self.showLocalCanvasOnDisconnect()
                            }
                            GatewayDiagnostics.log("gateway disconnected reason: \(reason)")
                        },
                        onInvoke: { [weak self] req in
                            guard let self else {
                                return BridgeInvokeResponse(
                                    id: req.id,
                                    ok: false,
                                    error: OpenClawNodeError(
                                        code: .unavailable,
                                        message: "UNAVAILABLE: node not ready"))
                            }
                            return await self.handleInvoke(req)
                        })

                    attempt = 0
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                } catch {
                    if Task.isCancelled { break }
                    if !didFallbackClientId,
                       let fallbackClientId = self.legacyClientIdFallback(
                        currentClientId: currentOptions.clientId,
                        error: error)
                    {
                        didFallbackClientId = true
                        currentOptions.clientId = fallbackClientId
                        GatewaySettingsStore.saveGatewayClientIdOverride(
                            stableID: stableID,
                            clientId: fallbackClientId)
                        await MainActor.run { self.gatewayStatusText = "Gateway rejected client id. Retrying…" }
                        continue
                    }

                    attempt += 1
                    await MainActor.run {
                        self.gatewayStatusText = "Gateway error: \(error.localizedDescription)"
                        self.gatewayServerName = nil
                        self.gatewayRemoteAddress = nil
                        self.gatewayConnected = false
                        self.showLocalCanvasOnDisconnect()
                    }
                    GatewayDiagnostics.log("gateway connect error: \(error.localizedDescription)")

                    // If auth is missing/rejected, pause reconnect churn until the user intervenes.
                    // Reconnect loops only spam the same failing handshake and make onboarding noisy.
                    let lower = error.localizedDescription.lowercased()
                    if lower.contains("unauthorized") || lower.contains("gateway token missing") {
                        await MainActor.run {
                            self.gatewayAutoReconnectEnabled = false
                        }
                    }

                    // If pairing is required, stop reconnect churn. The user must approve the request
                    // on the gateway before another connect attempt will succeed, and retry loops can
                    // generate multiple pending requests.
                    if lower.contains("not_paired") || lower.contains("pairing required") {
                        let requestId: String? = {
                            // GatewayResponseError for connect decorates the message with `(requestId: ...)`.
                            // Keep this resilient since other layers may wrap the text.
                            let text = error.localizedDescription
                            guard let start = text.range(of: "(requestId: ")?.upperBound else { return nil }
                            guard let end = text[start...].firstIndex(of: ")") else { return nil }
                            let raw = String(text[start..<end]).trimmingCharacters(in: .whitespacesAndNewlines)
                            return raw.isEmpty ? nil : raw
                        }()
                        await MainActor.run {
                            self.gatewayAutoReconnectEnabled = false
                            self.gatewayPairingPaused = true
                            self.gatewayPairingRequestId = requestId
                            if let requestId, !requestId.isEmpty {
                                self.gatewayStatusText =
                                    "Pairing required (requestId: \(requestId)). Approve on gateway and return to OpenClaw."
                            } else {
                                self.gatewayStatusText = "Pairing required. Approve on gateway and return to OpenClaw."
                            }
                        }
                        // Hard stop the underlying WebSocket watchdog reconnects so the UI stays stable and
                        // we don't generate multiple pending requests while waiting for approval.
                        pausedForPairingApproval = true
                        self.operatorGatewayTask?.cancel()
                        self.operatorGatewayTask = nil
                        await self.operatorGateway.disconnect()
                        await self.nodeGateway.disconnect()
                        break
                    }

                    let sleepSeconds = min(8.0, 0.5 * pow(1.7, Double(attempt)))
                    try? await Task.sleep(nanoseconds: UInt64(sleepSeconds * 1_000_000_000))
                }
            }

            if pausedForPairingApproval {
                // Leave the status text + request id intact so onboarding can guide the user.
                return
            }

            await MainActor.run {
                self.gatewayStatusText = "Offline"
                self.gatewayServerName = nil
                self.gatewayRemoteAddress = nil
                self.connectedGatewayID = nil
                self.gatewayConnected = false
                self.operatorConnected = false
                self.talkMode.updateGatewayConnected(false)
                self.seamColorHex = nil
                self.mainSessionBaseKey = "main"
                self.talkMode.updateMainSessionKey(self.mainSessionKey)
                self.showLocalCanvasOnDisconnect()
            }
        }
    }

    func makeOperatorConnectOptions(clientId: String, displayName: String?) -> GatewayConnectOptions {
        GatewayConnectOptions(
            role: "operator",
            scopes: ["operator.read", "operator.write", "operator.talk.secrets"],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: clientId,
            clientMode: "ui",
            clientDisplayName: displayName,
            // Operator traffic should authenticate via shared gateway auth only.
            // Including device identity here can trigger duplicate pairing flows.
            includeDeviceIdentity: false)
    }

    func legacyClientIdFallback(currentClientId: String, error: Error) -> String? {
        let normalizedClientId = currentClientId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard normalizedClientId == "openclaw-ios" else { return nil }
        let message = error.localizedDescription.lowercased()
        guard message.contains("invalid connect params"), message.contains("/client/id") else {
            return nil
        }
        return "moltbot-ios"
    }

    func isOperatorConnected() async -> Bool {
        self.operatorConnected
    }
}

extension NodeAppModel {
    private func refreshShareRouteFromGateway() async {
        struct Params: Codable {
            var includeGlobal: Bool
            var includeUnknown: Bool
            var limit: Int
        }
        struct SessionRow: Decodable {
            var key: String
            var updatedAt: Double?
            var lastChannel: String?
            var lastTo: String?
        }
        struct SessionsListResult: Decodable {
            var sessions: [SessionRow]
        }

        let normalize: (String?) -> String? = { raw in
            let value = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return value.isEmpty ? nil : value
        }

        do {
            let data = try JSONEncoder().encode(
                Params(includeGlobal: true, includeUnknown: false, limit: 80))
            guard let json = String(data: data, encoding: .utf8) else { return }
            let response = try await self.operatorGateway.request(
                method: "sessions.list",
                paramsJSON: json,
                timeoutSeconds: 10)
            let decoded = try JSONDecoder().decode(SessionsListResult.self, from: response)
            let currentKey = self.mainSessionKey
            let sorted = decoded.sessions.sorted { ($0.updatedAt ?? 0) > ($1.updatedAt ?? 0) }
            let exactMatch = sorted.first { row in
                row.key == currentKey && normalize(row.lastChannel) != nil && normalize(row.lastTo) != nil
            }
            let selected = exactMatch
            let channel = normalize(selected?.lastChannel)
            let to = normalize(selected?.lastTo)

            await MainActor.run {
                self.shareDeliveryChannel = channel
                self.shareDeliveryTo = to
                if let relay = ShareGatewayRelaySettings.loadConfig() {
                    ShareGatewayRelaySettings.saveConfig(
                        ShareGatewayRelayConfig(
                            gatewayURLString: relay.gatewayURLString,
                            token: relay.token,
                            password: relay.password,
                            sessionKey: self.mainSessionKey,
                            deliveryChannel: channel,
                            deliveryTo: to))
                }
            }
        } catch {
            // Best-effort only.
        }
    }

    func runSharePipelineSelfTest() async {
        self.recordShareEvent("Share self-test running…")

        let payload = SharedContentPayload(
            title: "OpenClaw Share Self-Test",
            url: URL(string: "https://openclaw.ai/share-self-test"),
            text: "Validate iOS share->deep-link->gateway forwarding.")
        guard let deepLink = ShareToAgentDeepLink.buildURL(
            from: payload,
            instruction: "Reply with: SHARE SELF-TEST OK")
        else {
            self.recordShareEvent("Self-test failed: could not build deep link.")
            return
        }

        await self.handleDeepLink(url: deepLink)
    }

    func refreshLastShareEventFromRelay() {
        if let event = ShareGatewayRelaySettings.loadLastEvent() {
            self.lastShareEventText = event
        }
    }

    func recordShareEvent(_ text: String) {
        ShareGatewayRelaySettings.saveLastEvent(text)
        self.refreshLastShareEventFromRelay()
    }

    func reloadTalkConfig() {
        Task { [weak self] in
            await self?.talkMode.reloadConfig()
        }
    }

    /// Back-compat hook retained for older gateway-connect flows.
    func onNodeGatewayConnected() async {
        await self.registerAPNsTokenIfNeeded()
    }

    func handleSilentPushWake(_ userInfo: [AnyHashable: Any]) async -> Bool {
        guard Self.isSilentPushPayload(userInfo) else {
            self.pushWakeLogger.info("Ignored APNs payload: not silent push")
            return false
        }
        self.pushWakeLogger.info("Silent push received; attempting reconnect if needed")
        return await self.reconnectGatewaySessionsForSilentPushIfNeeded()
    }

    func updateAPNsDeviceToken(_ tokenData: Data) {
        let tokenHex = tokenData.map { String(format: "%02x", $0) }.joined()
        let trimmed = tokenHex.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        self.apnsDeviceTokenHex = trimmed
        UserDefaults.standard.set(trimmed, forKey: Self.apnsDeviceTokenUserDefaultsKey)
        Task { [weak self] in
            await self?.registerAPNsTokenIfNeeded()
        }
    }

    private func registerAPNsTokenIfNeeded() async {
        guard self.gatewayConnected else { return }
        guard let token = self.apnsDeviceTokenHex?.trimmingCharacters(in: .whitespacesAndNewlines),
              !token.isEmpty
        else {
            return
        }
        if token == self.apnsLastRegisteredTokenHex {
            return
        }
        guard let topic = Bundle.main.bundleIdentifier?.trimmingCharacters(in: .whitespacesAndNewlines),
              !topic.isEmpty
        else {
            return
        }

        struct PushRegistrationPayload: Codable {
            var token: String
            var topic: String
            var environment: String
        }

        let payload = PushRegistrationPayload(
            token: token,
            topic: topic,
            environment: Self.apnsEnvironment)
        do {
            let json = try Self.encodePayload(payload)
            await self.nodeGateway.sendEvent(event: "push.apns.register", payloadJSON: json)
            self.apnsLastRegisteredTokenHex = token
        } catch {
            // Best-effort only.
        }
    }

    private static func isSilentPushPayload(_ userInfo: [AnyHashable: Any]) -> Bool {
        guard let apsAny = userInfo["aps"] else { return false }
        if let aps = apsAny as? [AnyHashable: Any] {
            return Self.hasContentAvailable(aps["content-available"])
        }
        if let aps = apsAny as? [String: Any] {
            return Self.hasContentAvailable(aps["content-available"])
        }
        return false
    }

    private static func hasContentAvailable(_ value: Any?) -> Bool {
        if let number = value as? NSNumber {
            return number.intValue == 1
        }
        if let text = value as? String {
            return text.trimmingCharacters(in: .whitespacesAndNewlines) == "1"
        }
        return false
    }

    private func reconnectGatewaySessionsForSilentPushIfNeeded() async -> Bool {
        guard self.isBackgrounded else {
            self.pushWakeLogger.info("Wake no-op: app not backgrounded")
            return false
        }
        guard self.gatewayAutoReconnectEnabled else {
            self.pushWakeLogger.info("Wake no-op: auto reconnect disabled")
            return false
        }
        guard self.activeGatewayConnectConfig != nil else {
            self.pushWakeLogger.info("Wake no-op: no active gateway config")
            return false
        }

        await self.operatorGateway.disconnect()
        await self.nodeGateway.disconnect()
        self.operatorConnected = false
        self.gatewayConnected = false
        self.gatewayStatusText = "Reconnecting…"
        self.talkMode.updateGatewayConnected(false)
        self.pushWakeLogger.info("Wake reconnect trigger applied")
        return true
    }
}

#if DEBUG
extension NodeAppModel {
    func _test_handleInvoke(_ req: BridgeInvokeRequest) async -> BridgeInvokeResponse {
        await self.handleInvoke(req)
    }

    static func _test_decodeParams<T: Decodable>(_ type: T.Type, from json: String?) throws -> T {
        try self.decodeParams(type, from: json)
    }

    static func _test_encodePayload(_ obj: some Encodable) throws -> String {
        try self.encodePayload(obj)
    }

    func _test_isCameraEnabled() -> Bool {
        self.isCameraEnabled()
    }

    func _test_triggerCameraFlash() {
        self.triggerCameraFlash()
    }

    func _test_showCameraHUD(text: String, kind: CameraHUDKind, autoHideSeconds: Double? = nil) {
        self.showCameraHUD(text: text, kind: kind, autoHideSeconds: autoHideSeconds)
    }

    func _test_handleCanvasA2UIAction(body: [String: Any]) async {
        await self.handleCanvasA2UIAction(body: body)
    }

    func _test_showLocalCanvasOnDisconnect() {
        self.showLocalCanvasOnDisconnect()
    }

    func _test_applyTalkModeSync(enabled: Bool, phase: String? = nil) {
        self.applyTalkModeSync(enabled: enabled, phase: phase)
    }
}
#endif
