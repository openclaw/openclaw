import AppKit
import Foundation
import OpenClawKit
import OSLog

private let dashboardManagerLogger = Logger(subsystem: "ai.openclaw", category: "DashboardManager")

@MainActor
final class DashboardManager {
    static let shared = DashboardManager()

    private var controller: DashboardWindowController?
    private static let failureURL = URL(string: "about:blank")!

    private init() {}

    @discardableResult
    func showConfiguredWindowIfPossible() async -> Bool {
        let mode = AppStateStore.shared.connectionMode
        guard let config = self.immediateDashboardConfig(mode: mode) else {
            return false
        }
        let token = await GatewayConnection.shared.controlUiAutoAuthToken(config: config)
        guard let presentation = try? Self.makeDashboardPresentation(
            config: config,
            mode: mode,
            authToken: token),
            presentation.auth.hasCredential
        else {
            return false
        }
        self.show(presentation: presentation)
        Task { _ = try? await ControlChannel.shared.health(timeout: 3) }
        return true
    }

    private func show(presentation: (url: URL, auth: DashboardWindowAuth)) {
        if let controller {
            controller.show(url: presentation.url, auth: presentation.auth)
        } else {
            let controller = DashboardWindowController(url: presentation.url, auth: presentation.auth)
            self.controller = controller
            controller.show(url: presentation.url, auth: presentation.auth)
        }
    }

    func show() async throws {
        let mode = AppStateStore.shared.connectionMode
        dashboardManagerLogger.info("dashboard show requested mode=\(String(describing: mode), privacy: .public)")
        let config = try await self.dashboardConfig(mode: mode)
        dashboardManagerLogger.info("dashboard config url=\(config.url.absoluteString, privacy: .public)")
        let token = await GatewayConnection.shared.controlUiAutoAuthToken(config: config)
        let presentation = try Self.makeDashboardPresentation(config: config, mode: mode, authToken: token)

        if let controller {
            dashboardManagerLogger.info("dashboard reuse window url=\(presentation.url.absoluteString, privacy: .public)")
            controller.show(url: presentation.url, auth: presentation.auth)
            return
        }

        dashboardManagerLogger.info("dashboard create window url=\(presentation.url.absoluteString, privacy: .public)")
        let controller = DashboardWindowController(url: presentation.url, auth: presentation.auth)
        self.controller = controller
        controller.show(url: presentation.url, auth: presentation.auth)

        // Refresh the cached hello payload without blocking window creation.
        Task { _ = try? await ControlChannel.shared.health(timeout: 3) }
    }

    func showFailure(_ error: Error) {
        let message = (error as NSError).localizedDescription
        dashboardManagerLogger.error("dashboard setup failed error=\(message, privacy: .public)")
        let controller = self.controller ?? DashboardWindowController(
            url: Self.failureURL,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil))
        self.controller = controller
        controller.showFailure(
            title: "Dashboard unavailable",
            message: message,
            detail: "Check Settings → Connection or use Debug → Reset Remote Tunnel, then try again.")
    }

    func close() {
        self.controller?.closeDashboard()
    }

    private static func websocketURLString(for dashboardURL: URL) -> String {
        guard var components = URLComponents(url: dashboardURL, resolvingAgainstBaseURL: false) else {
            return dashboardURL.absoluteString
        }
        switch components.scheme?.lowercased() {
        case "https":
            components.scheme = "wss"
        default:
            components.scheme = "ws"
        }
        components.queryItems = nil
        components.fragment = nil
        return components.url?.absoluteString ?? dashboardURL.absoluteString
    }

    static func makeDashboardPresentation(
        config: GatewayConnection.Config,
        mode: AppState.ConnectionMode,
        authToken: String?,
        localBasePath: String? = nil) throws -> (url: URL, auth: DashboardWindowAuth)
    {
        let url = try GatewayEndpointStore.dashboardURL(
            for: config,
            mode: mode,
            localBasePath: localBasePath,
            authToken: authToken)
        return (
            url,
            DashboardWindowAuth(
                gatewayUrl: Self.websocketURLString(for: url),
                token: authToken,
                password: config.password?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty))
    }

    private func dashboardConfig(mode: AppState.ConnectionMode) async throws -> GatewayConnection.Config {
        if let config = self.immediateDashboardConfig(mode: mode) {
            return config
        }

        return try await Task.detached(priority: .userInitiated) {
            await GatewayEndpointStore.shared.refresh()
            return try await GatewayEndpointStore.shared.requireConfig()
        }.value
    }

    private func immediateDashboardConfig(mode: AppState.ConnectionMode) -> GatewayConnection.Config? {
        let root = OpenClawConfigFile.loadDict()
        let resolution = GatewayRemoteConfig.resolveTransportResolution(root: root)
        if mode == .remote,
           resolution.transport == .direct,
           let url = resolution.directURL
        {
            return (
                url,
                GatewayRemoteConfig.resolveTokenString(root: root),
                GatewayRemoteConfig.resolvePasswordString(root: root))
        }

        if mode == .local {
            return GatewayEndpointStore.localConfig()
        }

        return nil
    }
}
