import AppKit
import ClawdisIPC
import Foundation

@MainActor
final class CanvasManager {
    static let shared = CanvasManager()

    private var panelController: CanvasWindowController?
    private var panelSessionKey: String?

    /// Optional anchor provider (e.g. menu bar status item). If nil, Canvas anchors to the mouse cursor.
    var defaultAnchorProvider: (() -> NSRect?)?

    private nonisolated static let canvasRoot: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return base.appendingPathComponent("Clawdis/canvas", isDirectory: true)
    }()

    func show(sessionKey: String, path: String? = nil, placement: CanvasPlacement? = nil) throws -> String {
        let anchorProvider = self.defaultAnchorProvider ?? Self.mouseAnchorProvider
        let session = sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        if let controller = self.panelController, self.panelSessionKey == session {
            controller.presentAnchoredPanel(anchorProvider: anchorProvider)
            controller.applyPreferredPlacement(placement)
            controller.goto(path: path ?? "/")
            return controller.directoryPath
        }

        self.panelController?.close()
        self.panelController = nil
        self.panelSessionKey = nil

        try FileManager.default.createDirectory(at: Self.canvasRoot, withIntermediateDirectories: true)
        let controller = try CanvasWindowController(
            sessionKey: session,
            root: Self.canvasRoot,
            presentation: .panel(anchorProvider: anchorProvider))
        self.panelController = controller
        self.panelSessionKey = session
        controller.applyPreferredPlacement(placement)
        controller.showCanvas(path: path ?? "/")
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

    func goto(sessionKey: String, path: String, placement: CanvasPlacement? = nil) throws {
        _ = try self.show(sessionKey: sessionKey, path: path, placement: placement)
    }

    func eval(sessionKey: String, javaScript: String) async throws -> String {
        _ = try self.show(sessionKey: sessionKey, path: nil)
        guard let controller = self.panelController else { return "" }
        return await controller.eval(javaScript: javaScript)
    }

    func snapshot(sessionKey: String, outPath: String?) async throws -> String {
        _ = try self.show(sessionKey: sessionKey, path: nil)
        guard let controller = self.panelController else {
            throw NSError(domain: "Canvas", code: 21, userInfo: [NSLocalizedDescriptionKey: "canvas not available"])
        }
        return try await controller.snapshot(to: outPath)
    }

    // MARK: - Anchoring

    private static func mouseAnchorProvider() -> NSRect? {
        let pt = NSEvent.mouseLocation
        return NSRect(x: pt.x, y: pt.y, width: 1, height: 1)
    }

    // placement interpretation is handled by the window controller.
}
