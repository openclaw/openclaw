import AppKit
import SwiftUI

@MainActor
final class AmbientOverlayDisplayController {
    struct DisplaySnapshot: Equatable {
        var info: AmbientOverlayDisplayInfo
        var visibleFrame: CGRect

        var id: String { self.info.id }
        var frame: CGRect { self.info.frame }
    }

    struct DisplayPlan: Equatable {
        var ambientDisplays: [DisplaySnapshot]
        var workspaceDisplay: DisplaySnapshot?
    }

    private struct AmbientPanelSurface {
        var panel: NSPanel
        var hostingView: NSHostingView<AmbientOverlayView>
    }

    private var ambientPanels: [String: AmbientPanelSurface] = [:]
    private var workspacePanel: NSPanel?
    private var workspaceHostingView: NSHostingView<AmbientWorkspaceSheetView>?

    func showAmbient(intensity: Double, displayScope: AmbientOverlayDisplayScope) {
        let plan = Self.displayPlan(
            displays: Self.screenSnapshots(),
            mouseLocation: NSEvent.mouseLocation,
            scope: displayScope)
        let targetIDs = Set(plan.ambientDisplays.map(\.id))
        for id in self.ambientPanels.keys.filter({ !targetIDs.contains($0) }) {
            self.ambientPanels[id]?.panel.close()
            self.ambientPanels[id] = nil
        }

        for display in plan.ambientDisplays {
            let surface = self.ensureAmbientPanel(display: display, intensity: intensity)
            surface.panel.setFrame(display.frame, display: true)
            surface.panel.level = .screenSaver
            surface.panel.ignoresMouseEvents = true
            surface.hostingView.frame = NSRect(origin: .zero, size: display.frame.size)
            surface.hostingView.rootView = AmbientOverlayView(intensity: intensity)
            surface.panel.orderFrontRegardless()
        }
    }

    func updateIntensity(_ intensity: Double) {
        for surface in self.ambientPanels.values {
            surface.hostingView.rootView = AmbientOverlayView(intensity: intensity)
        }
    }

    func showWorkspace(onDismiss: @escaping () -> Void, displayScope: AmbientOverlayDisplayScope) {
        let plan = Self.displayPlan(
            displays: Self.screenSnapshots(),
            mouseLocation: NSEvent.mouseLocation,
            scope: displayScope)
        let frame = Self.workspaceFrame(for: plan.workspaceDisplay)
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
        for surface in self.ambientPanels.values {
            surface.panel.close()
        }
        self.workspacePanel?.close()
        self.ambientPanels = [:]
        self.workspacePanel = nil
        self.workspaceHostingView = nil
    }

    nonisolated static func displayPlan(
        displays: [DisplaySnapshot],
        mouseLocation: CGPoint,
        scope: AmbientOverlayDisplayScope) -> DisplayPlan
    {
        var displaysByID: [String: DisplaySnapshot] = [:]
        for display in displays {
            displaysByID[display.id] = display
        }

        let displayInfos = displays.map(\.info)
        let ambientInfos = AmbientOverlayDisplayResolver.targetDisplays(
            displays: displayInfos,
            mouseLocation: mouseLocation,
            scope: scope)
        let workspaceInfo = AmbientOverlayDisplayResolver.targetDisplays(
            displays: displayInfos,
            mouseLocation: mouseLocation,
            scope: .currentDisplay).first

        return DisplayPlan(
            ambientDisplays: ambientInfos.compactMap { displaysByID[$0.id] },
            workspaceDisplay: workspaceInfo.flatMap { displaysByID[$0.id] })
    }

    private func ensureAmbientPanel(display: DisplaySnapshot, intensity: Double) -> AmbientPanelSurface {
        if let surface = self.ambientPanels[display.id] {
            return surface
        }

        let frame = display.frame
        let panel = OverlayPanelFactory.makePanel(
            contentRect: frame,
            level: .screenSaver,
            hasShadow: false)
        panel.ignoresMouseEvents = true
        let host = NSHostingView(rootView: AmbientOverlayView(intensity: intensity))
        host.frame = NSRect(origin: .zero, size: frame.size)
        host.autoresizingMask = [.width, .height]
        panel.contentView = host
        let surface = AmbientPanelSurface(panel: panel, hostingView: host)
        self.ambientPanels[display.id] = surface
        return surface
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

    private static func screenSnapshots() -> [DisplaySnapshot] {
        let screens = NSScreen.screens
        guard !screens.isEmpty else {
            let frame = Self.screenFrame()
            return [
                DisplaySnapshot(
                    info: AmbientOverlayDisplayInfo(id: "fallback", frame: frame),
                    visibleFrame: frame),
            ]
        }

        return screens.enumerated().map { index, screen in
            DisplaySnapshot(
                info: AmbientOverlayDisplayInfo(
                    id: Self.screenID(for: screen, index: index),
                    frame: screen.frame),
                visibleFrame: screen.visibleFrame)
        }
    }

    private static func screenID(for screen: NSScreen, index: Int) -> String {
        let key = NSDeviceDescriptionKey("NSScreenNumber")
        if let screenNumber = screen.deviceDescription[key] as? NSNumber {
            return "display-\(screenNumber.uint32Value)"
        }
        return "display-\(index)"
    }

    private static func screenFrame() -> NSRect {
        NSScreen.main?.frame ?? NSRect(x: 0, y: 0, width: 1200, height: 800)
    }

    private static func workspaceFrame(for display: DisplaySnapshot?) -> NSRect {
        let screen = display?.visibleFrame ?? NSScreen.main?.visibleFrame ?? Self.screenFrame()
        let size = NSSize(width: 420, height: 86)
        let origin = CGPoint(
            x: screen.midX - size.width / 2,
            y: screen.minY + 28)
        return NSRect(origin: origin, size: size)
    }
}
