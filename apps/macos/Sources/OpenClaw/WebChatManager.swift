import AppKit
import Foundation

/// A borderless panel that can still accept key focus (needed for typing).
final class WebChatPanel: NSPanel {
    override var canBecomeKey: Bool {
        true
    }

    override var canBecomeMain: Bool {
        true
    }
}

enum WebChatPresentation {
    case window
    case panel(anchorProvider: () -> NSRect?)

    var isPanel: Bool {
        if case .panel = self { return true }
        return false
    }
}

@MainActor
final class WebChatManager {
    static let shared = WebChatManager()

    private static let primaryGatewayKey = "__primary__"

    private var windowControllers: [String: WebChatSwiftUIWindowController] = [:]
    private var windowSessionKeys: [String: String] = [:]
    private var gatewayConnections: [String: GatewayConnection] = [:]
    private var panelController: WebChatSwiftUIWindowController?
    private var panelSessionKey: String?
    private var cachedPreferredSessionKeys: [String: String] = [:]

    var onPanelVisibilityChanged: ((Bool) -> Void)?

    var activeSessionKey: String? {
        self.panelSessionKey ?? self.windowSessionKeys.values.first
    }

    func show(sessionKey: String, gatewayProfile: GatewayProfile? = nil) {
        let gatewayKey = self.gatewayKey(for: gatewayProfile?.id)
        self.closePanel()
        if let controller = self.windowControllers[gatewayKey] {
            if self.windowSessionKeys[gatewayKey] == sessionKey {
                controller.show()
                return
            }

            controller.close()
            self.windowControllers[gatewayKey] = nil
            self.windowSessionKeys[gatewayKey] = nil
        }
        let transport = MacGatewayChatTransport(connection: self.connection(for: gatewayProfile))
        let controller = WebChatSwiftUIWindowController(
            sessionKey: sessionKey,
            presentation: .window,
            transport: transport)
        controller.onVisibilityChanged = { [weak self] visible in
            self?.onPanelVisibilityChanged?(visible)
        }
        self.windowControllers[gatewayKey] = controller
        self.windowSessionKeys[gatewayKey] = sessionKey
        controller.show()
    }

    func togglePanel(sessionKey: String, anchorProvider: @escaping () -> NSRect?) {
        if let controller = self.panelController {
            if self.panelSessionKey != sessionKey {
                controller.close()
                self.panelController = nil
                self.panelSessionKey = nil
            } else {
                if controller.isVisible {
                    controller.close()
                } else {
                    controller.presentAnchored(anchorProvider: anchorProvider)
                }
                return
            }
        }

        let controller = WebChatSwiftUIWindowController(
            sessionKey: sessionKey,
            presentation: .panel(anchorProvider: anchorProvider))
        controller.onClosed = { [weak self] in
            self?.panelHidden()
        }
        controller.onVisibilityChanged = { [weak self] visible in
            self?.onPanelVisibilityChanged?(visible)
        }
        self.panelController = controller
        self.panelSessionKey = sessionKey
        controller.presentAnchored(anchorProvider: anchorProvider)
    }

    func closePanel() {
        self.panelController?.close()
    }

    func preferredSessionKey(gatewayProfile: GatewayProfile? = nil) async -> String {
        let gatewayKey = self.gatewayKey(for: gatewayProfile?.id)
        if let cached = self.cachedPreferredSessionKeys[gatewayKey] { return cached }
        let key = await self.connection(for: gatewayProfile).mainSessionKey()
        self.cachedPreferredSessionKeys[gatewayKey] = key
        return key
    }

    func resetTunnels() {
        for (_, controller) in self.windowControllers {
            controller.close()
        }
        self.windowControllers.removeAll()
        self.windowSessionKeys.removeAll()
        self.panelController?.close()
        self.panelController = nil
        self.panelSessionKey = nil
        self.cachedPreferredSessionKeys.removeAll()
        for (_, connection) in self.gatewayConnections {
            Task {
                await connection.shutdown()
            }
        }
        self.gatewayConnections.removeAll()
    }

    func close() {
        self.resetTunnels()
    }

    private func panelHidden() {
        self.onPanelVisibilityChanged?(false)
        // Keep panel controller cached so reopening doesn't re-bootstrap.
    }

    private func gatewayKey(for profileID: String?) -> String {
        guard let profileID, !profileID.isEmpty else { return Self.primaryGatewayKey }
        return profileID
    }

    private func connection(for gatewayProfile: GatewayProfile?) -> GatewayConnection {
        let key = self.gatewayKey(for: gatewayProfile?.id)
        if let connection = self.gatewayConnections[key] {
            return connection
        }

        let connection: GatewayConnection
        if let gatewayProfile {
            let configProvider: @Sendable () async throws -> GatewayConnection.Config = {
                guard let url = gatewayProfile.websocketURL else {
                    throw NSError(
                        domain: "Gateway",
                        code: 0,
                        userInfo: [NSLocalizedDescriptionKey: "Invalid gateway URL for \(gatewayProfile.name)"])
                }
                return (url: url, token: gatewayProfile.accessToken, password: nil)
            }
            connection = GatewayConnection(configProvider: configProvider)
        } else {
            connection = GatewayConnection.shared
        }

        self.gatewayConnections[key] = connection
        return connection
    }
}
