import AppKit
import Foundation
import OpenClawIPC
import OpenClawKit
import OSLog

@MainActor
final class CanvasManager {
    static let shared = CanvasManager()

    private static let logger = Logger(subsystem: "ai.openclaw", category: "CanvasManager")

    private var panelController: CanvasWindowController?
    private var panelSessionKey: String?

    private init() {}

    var onPanelVisibilityChanged: ((Bool) -> Void)?

    /// Optional anchor provider (e.g. menu bar status item). If nil, Canvas anchors to the mouse cursor.
    var defaultAnchorProvider: (() -> NSRect?)?

    private nonisolated static let canvasRoot: URL = {
        let base = FileManager().urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return base.appendingPathComponent("OpenClaw/canvas", isDirectory: true)
    }()

    func show(
        sessionKey: String,
        path: String? = nil,
        placement: CanvasPlacement? = nil) throws -> String
    {
        Self.logger.debug(
            """
            show session=\(sessionKey, privacy: .public) \
            hasTarget=\(path != nil) \
            placement=\(placement != nil)
            """)
        let anchorProvider = self.defaultAnchorProvider ?? Self.mouseAnchorProvider
        let normalizedTarget = path?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nonEmpty
        let ensured = try ensureController(sessionKey: sessionKey)
        let controller = ensured.controller

        if !ensured.created {
            controller.presentAnchoredPanel(anchorProvider: anchorProvider)
            controller.applyPreferredPlacement(placement)

            // Existing session: only navigate when an explicit target was provided.
            if let normalizedTarget {
                controller.load(target: normalizedTarget)
            }

            self.refreshDebugStatus()
            return controller.directoryPath
        }

        controller.applyPreferredPlacement(placement)

        // New session: default to the local document root.
        controller.showCanvas(path: normalizedTarget ?? "/")
        self.refreshDebugStatus()

        return controller.directoryPath
    }

    func hide(sessionKey: String) {
        let session = sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard self.panelSessionKey == session else { return }
        self.panelController?.hideCanvas()
    }

    func hideAll() {
        self.panelController?.hideCanvas()
    }

    func refreshDebugStatus() {
        guard let controller = panelController else { return }
        let enabled = AppStateStore.shared.debugPaneEnabled
        let mode = AppStateStore.shared.connectionMode
        let title: String?
        let subtitle: String?
        switch mode {
        case .remote:
            title = "Remote control"
            switch ControlChannel.shared.state {
            case .connected:
                subtitle = "Connected"
            case .connecting:
                subtitle = "Connecting…"
            case .disconnected:
                subtitle = "Disconnected"
            case let .degraded(message):
                subtitle = message.isEmpty ? "Degraded" : message
            }
        case .local:
            title = GatewayProcessManager.shared.status.label
            subtitle = mode.rawValue
        case .unconfigured:
            title = "Unconfigured"
            subtitle = mode.rawValue
        }
        controller.updateDebugStatus(enabled: enabled, title: title, subtitle: subtitle)
    }

    // MARK: - Anchoring

    private static func mouseAnchorProvider() -> NSRect? {
        let pt = NSEvent.mouseLocation
        return NSRect(x: pt.x, y: pt.y, width: 1, height: 1)
    }

    // MARK: - Helpers

    /// A session switch keeps the single-panel model by replacing the previous panel.
    private func ensureController(sessionKey: String) throws -> (controller: CanvasWindowController, created: Bool) {
        let anchorProvider = self.defaultAnchorProvider ?? Self.mouseAnchorProvider
        let session = sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)

        if let controller = panelController, panelSessionKey == session {
            Self.logger.debug("ensureController reuse existing session=\(session, privacy: .public)")
            controller.onVisibilityChanged = { [weak self] visible in
                self?.onPanelVisibilityChanged?(visible)
            }
            return (controller, false)
        }

        Self.logger.debug("ensureController creating new session=\(session, privacy: .public)")
        self.panelController?.close()
        self.panelController = nil
        self.panelSessionKey = nil

        try FileManager().createDirectory(at: Self.canvasRoot, withIntermediateDirectories: true)
        let controller = try CanvasWindowController(
            sessionKey: session,
            root: Self.canvasRoot,
            presentation: .panel(anchorProvider: anchorProvider))
        controller.onVisibilityChanged = { [weak self] visible in
            self?.onPanelVisibilityChanged?(visible)
        }
        self.panelController = controller
        self.panelSessionKey = session
        return (controller, true)
    }
}
