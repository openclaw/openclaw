import AppKit
import Foundation
import SwiftUI

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

    private var windowControllers: [String: WebChatSwiftUIWindowController] = [:]
    private var windowSessionKeys: [String: String] = [:]
    private var panelController: WebChatSwiftUIWindowController?
    private var panelSessionKey: String?
    private var cachedPreferredSessionKeys: [String: String] = [:]

    var onPanelVisibilityChanged: ((Bool) -> Void)?

    var activeSessionKey: String? {
        self.panelSessionKey ?? self.windowSessionKeys.values.first
    }

    func show(sessionKey: String, profile: GatewayProfile? = nil) async {
        self.closePanel()
        let profileID = profile?.id ?? "shared-default"
        if let controller = self.windowControllers[profileID] {
            if self.windowSessionKeys[profileID] == sessionKey {
                controller.show()
                return
            }

            controller.close()
            self.windowControllers.removeValue(forKey: profileID)
            self.windowSessionKeys.removeValue(forKey: profileID)
        }

        let controller: WebChatSwiftUIWindowController
        if let profile {
            let connection = await GatewayChatConnectionRegistry.shared.connection(for: profile)
            controller = WebChatSwiftUIWindowController(
                sessionKey: sessionKey,
                presentation: .window,
                profileName: profile.displayName,
                transport: MacGatewayChatTransport(connection: connection, profileName: profile.displayName))
        } else {
            controller = WebChatSwiftUIWindowController(sessionKey: sessionKey, presentation: .window)
        }
        controller.onVisibilityChanged = { [weak self] visible in
            self?.onPanelVisibilityChanged?(visible)
        }
        self.windowControllers[profileID] = controller
        self.windowSessionKeys[profileID] = sessionKey
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

    func preferredSessionKey(profile: GatewayProfile? = nil) async -> String {
        let profileID = profile?.id ?? "shared-default"
        if let cached = self.cachedPreferredSessionKeys[profileID] { return cached }
        let key: String
        if let profile {
            let connection = await GatewayChatConnectionRegistry.shared.connection(for: profile)
            key = await connection.mainSessionKey()
        } else {
            key = await GatewayConnection.shared.mainSessionKey()
        }
        self.cachedPreferredSessionKeys[profileID] = key
        return key
    }

    func resetTunnels() {
        for controller in self.windowControllers.values {
            controller.close()
        }
        self.windowControllers.removeAll()
        self.windowSessionKeys.removeAll()
        self.panelController?.close()
        self.panelController = nil
        self.panelSessionKey = nil
        self.cachedPreferredSessionKeys.removeAll()
    }

    func close() {
        self.resetTunnels()
    }

    private func panelHidden() {
        self.onPanelVisibilityChanged?(false)
        // Keep panel controller cached so reopening doesn't re-bootstrap.
    }
}
