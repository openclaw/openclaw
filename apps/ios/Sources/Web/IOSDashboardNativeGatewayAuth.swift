import Foundation
import OpenClawKit

@MainActor
struct IOSDashboardNativeGatewayAuthReply {
    let json: Data
    let isCurrent: @MainActor () async -> Bool
}

/// Adapts the live operator session to the Dashboard challenge contract.
/// Credentials remain owned by GatewayNodeSession/GatewayChannelActor.
@MainActor
final class IOSDashboardNativeGatewayAuthProvider {
    private weak var appModel: NodeAppModel?
    private let session: GatewayNodeSession
    private let config: GatewayConnectConfig
    private let accessPrincipal: CloudflareAccessPrincipal?

    init?(appModel: NodeAppModel, config: GatewayConnectConfig?) {
        guard let config else { return nil }
        self.appModel = appModel
        self.session = appModel.operatorSession
        self.config = config
        self.accessPrincipal = config.ingressAuthorization?.principal
    }

    var controlUIRootURL: URL? {
        AuthenticatedControlUI.pageURL(config: self.config, path: "", queryItems: [])
    }

    func legacyCredentials() async -> [String: String]? {
        guard let authorityGeneration = self.appModel?.operatorAuthorityGeneration,
              let route = await self.currentRoute(authorityGeneration: authorityGeneration)
        else { return nil }
        guard await self.session.currentOperatorScopes(ifCurrentRoute: route) != nil else { return nil }
        let credentials = await self.session.controlUIDashboardLegacyCredentials(ifCurrentRoute: route)
        guard await self.session.currentRoute() == route,
              self.isCurrent(authorityGeneration: authorityGeneration) else { return nil }
        return credentials
    }

    func widgetSandboxTLS(
        sessionKey: String,
        agentID: String?,
        host: String,
        port: Int) async -> DashboardWidgetTLSAdmission?
    {
        guard let root = self.controlUIRootURL, root.scheme == "https",
              let gateway = GatewayTLSAuthority(url: root), (1...65535).contains(port), port != gateway.port,
              var candidate = URLComponents(url: root, resolvingAgainstBaseURL: false)
        else { return nil }
        candidate.port = port
        var params = ["sessionKey": AnyCodable(sessionKey)]
        if let agentID { params["agentId"] = AnyCodable(agentID) }
        guard let candidateURL = candidate.url,
              GatewayTLSAuthority(url: candidateURL)?.matches(host: host, port: port) == true,
              let tls = self.config.tls,
              let fingerprint = tls.expectedFingerprint ?? tls.storeKey.flatMap({
                  GatewayTLSStore.loadFingerprint(stableID: $0)
              }),
              let generation = self.appModel?.operatorAuthorityGeneration,
              let route = await self.currentRoute(authorityGeneration: generation),
              let data = try? await self.session.request(
                  method: "board.get",
                  params: params,
                  timeoutMs: 5000,
                  ifCurrentRoute: route),
              await self.session.currentRoute() == route,
              self.isCurrent(authorityGeneration: generation),
              let snapshot = try? JSONDecoder().decode(DashboardWidgetSandboxSnapshot.self, from: data),
              let parameters = snapshot.pinnedParameters(
                  sessionKey: sessionKey,
                  agentID: agentID,
                  gatewayURL: root,
                  fingerprint: fingerprint,
                  host: host,
                  port: port)
        else { return nil }
        return DashboardWidgetTLSAdmission(parameters: parameters) { [weak self] in
            self?.isCurrent(authorityGeneration: generation) == true
        }
    }

    func authorize(nonce: String, signedAt: Int64) async throws -> IOSDashboardNativeGatewayAuthReply {
        // Retire in-flight challenges while allowing fresh requests after a same-route reconnect.
        guard let authorityGeneration = self.appModel?.operatorAuthorityGeneration,
              let route = await self.currentRoute(authorityGeneration: authorityGeneration),
              await self.session.currentOperatorScopes(ifCurrentRoute: route) != nil
        else { throw CancellationError() }
        let json = try await self.session.controlUIDashboardAuthorization(
            ifCurrentRoute: route,
            nonce: nonce,
            signedAtMs: signedAt)
        guard await self.session.currentRoute() == route, self.isCurrent(authorityGeneration: authorityGeneration),
              let object = try? JSONSerialization.jsonObject(with: json) as? [String: Any],
              let auth = object["auth"] as? [String: String]
        else { throw CancellationError() }
        let deviceToken = auth["deviceToken"]
        if let deviceToken, self.accessPrincipal != nil,
           !Self.accessBindingAllowsDeviceToken(
               deviceToken,
               principal: self.accessPrincipal,
               gatewayID: self.config.nodeOptions.deviceAuthGatewayID ?? self.config.effectiveStableID,
               profile: self.config.nodeOptions.deviceIdentityProfile)
        {
            throw CancellationError()
        }
        return IOSDashboardNativeGatewayAuthReply(json: json) { [weak self] in
            guard let self, await self.session.currentRoute() == route,
                  self.isCurrent(authorityGeneration: authorityGeneration) else { return false }
            guard let deviceToken, self.accessPrincipal != nil else { return true }
            return Self.accessBindingAllowsDeviceToken(
                deviceToken,
                principal: self.accessPrincipal,
                gatewayID: self.config.nodeOptions.deviceAuthGatewayID ?? self.config.effectiveStableID,
                profile: self.config.nodeOptions.deviceIdentityProfile)
        }
    }

    func isCurrent(authorityGeneration: UInt64? = nil) -> Bool {
        guard let appModel = self.appModel,
              appModel.isOperatorGatewayConnected,
              !appModel.isAppleReviewDemoModeEnabled, !appModel.isScreenshotFixtureModeEnabled,
              let current = appModel.activeGatewayConnectConfig,
              current.hasSameControlUIInputs(as: self.config),
              current.ingressAuthorization?.principal == self.accessPrincipal,
              self.config.ingressAuthorization?.isCurrent() ?? true
        else { return false }
        return authorityGeneration.map { $0 == appModel.operatorAuthorityGeneration } ?? true
    }

    static func accessBindingAllowsDeviceToken(
        _ token: String,
        principal: CloudflareAccessPrincipal?,
        gatewayID: String?,
        profile: GatewayDeviceIdentityProfile,
        store: GatewayAccessDeviceAuthBindingStore = .shared) -> Bool
    {
        guard let principal else { return true }
        let stored = store.storedDeviceAuth(role: "operator", gatewayID: gatewayID, profile: profile)
        return stored?.entry.token == token && store.allowsStoredDeviceAuth(
            entry: stored,
            principal: principal,
            gatewayID: gatewayID,
            role: "operator",
            profile: profile,
            fallbackAllowed: true)
    }

    private func currentRoute(authorityGeneration: UInt64) async -> GatewayNodeSessionRoute? {
        guard self.isCurrent(authorityGeneration: authorityGeneration) else { return nil }
        let gatewayID = self.config.nodeOptions.deviceAuthGatewayID ?? self.config.effectiveStableID
        let route = await self.session.currentRoute(ifGatewayID: gatewayID)
        guard await self.session.currentRoute() == route,
              self.isCurrent(authorityGeneration: authorityGeneration) else { return nil }
        return route
    }
}
