import AppKit
import Observation
import OSLog
import SwiftUI

@MainActor
@Observable
final class TalkOverlayController {
    static let shared = TalkOverlayController()
    static let overlaySize: CGFloat = 260

    private let logger = Logger(subsystem: "com.steipete.clawdis", category: "talk.overlay")

    struct Model {
        var isVisible: Bool = false
        var phase: TalkModePhase = .idle
        var level: Double = 0
    }

    var model = Model()
    private var window: NSPanel?
    private var hostingView: NSHostingView<TalkOverlayView>?
    private let padding: CGFloat = 8

    func present() {
        self.ensureWindow()
        self.hostingView?.rootView = TalkOverlayView(controller: self)
        let target = self.targetFrame()

        guard let window else { return }
        if !self.model.isVisible {
            self.model.isVisible = true
            let start = target.offsetBy(dx: 0, dy: -6)
            window.setFrame(start, display: true)
            window.alphaValue = 0
            window.orderFrontRegardless()
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.18
                context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                window.animator().setFrame(target, display: true)
                window.animator().alphaValue = 1
            }
        } else {
            window.setFrame(target, display: true)
            window.orderFrontRegardless()
        }
    }

    func dismiss() {
        guard let window else {
            self.model.isVisible = false
            return
        }

        let target = window.frame.offsetBy(dx: 6, dy: 6)
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.16
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            window.animator().setFrame(target, display: true)
            window.animator().alphaValue = 0
        } completionHandler: {
            Task { @MainActor in
                window.orderOut(nil)
                self.model.isVisible = false
            }
        }
    }

    func updatePhase(_ phase: TalkModePhase) {
        guard self.model.phase != phase else { return }
        self.logger.info("talk overlay phase=\(phase.rawValue, privacy: .public)")
        self.model.phase = phase
    }

    func updateLevel(_ level: Double) {
        guard self.model.isVisible else { return }
        self.model.level = max(0, min(1, level))
    }

    // MARK: - Private

    private func ensureWindow() {
        if self.window != nil { return }
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: Self.overlaySize, height: Self.overlaySize),
            styleMask: [.nonactivatingPanel, .borderless],
            backing: .buffered,
            defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.popUpMenu.rawValue - 4)
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        panel.hidesOnDeactivate = false
        panel.isMovable = false
        panel.isFloatingPanel = true
        panel.becomesKeyOnlyIfNeeded = true
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true

        let host = NSHostingView(rootView: TalkOverlayView(controller: self))
        host.translatesAutoresizingMaskIntoConstraints = false
        panel.contentView = host
        self.hostingView = host
        self.window = panel
    }

    private func targetFrame() -> NSRect {
        guard let screen = NSScreen.main else { return .zero }
        let size = NSSize(width: Self.overlaySize, height: Self.overlaySize)
        let visible = screen.visibleFrame
        let origin = CGPoint(
            x: visible.maxX - size.width - self.padding,
            y: visible.maxY - size.height - self.padding)
        return NSRect(origin: origin, size: size)
    }
}
