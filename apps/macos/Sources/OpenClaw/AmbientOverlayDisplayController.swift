import AppKit
import SwiftUI

@MainActor
final class AmbientOverlayDisplayController {
    private var ambientPanel: NSPanel?
    private var workspacePanel: NSPanel?
    private var ambientHostingView: NSHostingView<AmbientOverlayView>?
    private var workspaceHostingView: NSHostingView<AmbientWorkspaceSheetView>?

    func showAmbient(intensity: Double) {
        let frame = Self.screenFrame()
        let panel = self.ensureAmbientPanel(frame: frame, intensity: intensity)
        panel.setFrame(frame, display: true)
        panel.level = .screenSaver
        panel.ignoresMouseEvents = true
        self.ambientHostingView?.rootView = AmbientOverlayView(intensity: intensity)
        panel.orderFrontRegardless()
    }

    func updateIntensity(_ intensity: Double) {
        self.ambientHostingView?.rootView = AmbientOverlayView(intensity: intensity)
    }

    func showWorkspace(onDismiss: @escaping () -> Void) {
        let frame = Self.workspaceFrame()
        let panel = self.ensureWorkspacePanel(frame: frame, onDismiss: onDismiss)
        panel.setFrame(frame, display: true)
        panel.level = .floating
        panel.ignoresMouseEvents = false
        self.workspaceHostingView?.rootView = AmbientWorkspaceSheetView(onClose: onDismiss)
        panel.orderFrontRegardless()
    }

    func hideWorkspace() {
        self.workspacePanel?.orderOut(nil)
    }

    func close() {
        self.ambientPanel?.close()
        self.workspacePanel?.close()
        self.ambientPanel = nil
        self.workspacePanel = nil
        self.ambientHostingView = nil
        self.workspaceHostingView = nil
    }

    private func ensureAmbientPanel(frame: NSRect, intensity: Double) -> NSPanel {
        if let ambientPanel {
            return ambientPanel
        }

        let panel = OverlayPanelFactory.makePanel(
            contentRect: frame,
            level: .screenSaver,
            hasShadow: false)
        panel.ignoresMouseEvents = true
        let host = NSHostingView(rootView: AmbientOverlayView(intensity: intensity))
        host.frame = NSRect(origin: .zero, size: frame.size)
        host.autoresizingMask = [.width, .height]
        panel.contentView = host
        self.ambientHostingView = host
        self.ambientPanel = panel
        return panel
    }

    private func ensureWorkspacePanel(frame: NSRect, onDismiss: @escaping () -> Void) -> NSPanel {
        if let workspacePanel {
            return workspacePanel
        }

        let panel = OverlayPanelFactory.makePanel(
            contentRect: frame,
            level: .floating,
            hasShadow: true,
            acceptsMouseMovedEvents: true)
        panel.ignoresMouseEvents = false
        let host = NSHostingView(rootView: AmbientWorkspaceSheetView(onClose: onDismiss))
        host.frame = NSRect(origin: .zero, size: frame.size)
        host.autoresizingMask = [.width, .height]
        panel.contentView = host
        self.workspaceHostingView = host
        self.workspacePanel = panel
        return panel
    }

    private static func screenFrame() -> NSRect {
        NSScreen.main?.frame ?? NSRect(x: 0, y: 0, width: 1200, height: 800)
    }

    private static func workspaceFrame() -> NSRect {
        let screen = NSScreen.main?.visibleFrame ?? Self.screenFrame()
        let size = NSSize(width: 420, height: 86)
        let origin = CGPoint(
            x: screen.midX - size.width / 2,
            y: screen.minY + 28)
        return NSRect(origin: origin, size: size)
    }
}
