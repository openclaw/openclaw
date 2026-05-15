import AppKit
import SwiftUI

final class AmbientCommandDockPanel: NSPanel {
    override var canBecomeKey: Bool {
        true
    }

    override var canBecomeMain: Bool {
        true
    }
}

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

    nonisolated static let ambientWindowLevel = NSWindow.Level.statusBar
    nonisolated static let workspaceWindowLevel = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)

    private var ambientPanels: [String: AmbientPanelSurface] = [:]
    private var commandDockPanel: NSPanel?
    private var commandDockHostingView: NSHostingView<AmbientCommandDockView>?
    private var commandDockModel = AmbientCommandDockModel()

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
            surface.panel.level = Self.ambientWindowLevel
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
        let frame = Self.commandDockFrame(for: plan.workspaceDisplay)
        let panel = self.ensureCommandDockPanel(frame: frame, onDismiss: onDismiss)
        panel.setFrame(frame, display: true)
        panel.level = Self.workspaceWindowLevel
        panel.ignoresMouseEvents = false
        self.commandDockHostingView?.rootView = AmbientCommandDockView(
            model: self.commandDockModel,
            onDismiss: onDismiss)
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func hideWorkspace() {
        self.commandDockPanel?.orderOut(nil)
    }

    func close() {
        for surface in self.ambientPanels.values {
            surface.panel.close()
        }
        self.commandDockPanel?.close()
        self.ambientPanels = [:]
        self.commandDockPanel = nil
        self.commandDockHostingView = nil
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
            level: Self.ambientWindowLevel,
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

    private func ensureCommandDockPanel(frame: NSRect, onDismiss: @escaping () -> Void) -> NSPanel {
        if let commandDockPanel {
            return commandDockPanel
        }

        let panel = AmbientCommandDockPanel(
            contentRect: frame,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = Self.workspaceWindowLevel
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        panel.hidesOnDeactivate = false
        panel.isMovable = false
        panel.isFloatingPanel = true
        panel.becomesKeyOnlyIfNeeded = true
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.acceptsMouseMovedEvents = true
        panel.ignoresMouseEvents = false
        let host = NSHostingView(rootView: AmbientCommandDockView(
            model: self.commandDockModel,
            onDismiss: onDismiss))
        host.frame = NSRect(origin: .zero, size: frame.size)
        host.autoresizingMask = [.width, .height]
        panel.contentView = host
        self.commandDockHostingView = host
        self.commandDockPanel = panel
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

    nonisolated static func commandDockFrame(for display: DisplaySnapshot?) -> NSRect {
        let screen = display?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1200, height: 800)
        let width = min(CGFloat(868), max(CGFloat(520), screen.width - 56))
        let size = NSSize(width: width, height: 264)
        let origin = CGPoint(
            x: screen.midX - size.width / 2,
            y: screen.minY + 28)
        return NSRect(origin: origin, size: size)
    }
}
