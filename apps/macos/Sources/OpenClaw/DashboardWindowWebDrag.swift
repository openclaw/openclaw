import AppKit

/// What a page-initiated window drag may do, kept free of AppKit state so the
/// gesture and lifecycle tests can drive every branch without a physical mouse.
enum DashboardWindowDragPolicy {
    /// A web-driven drag may only do what AppKit's own titlebar drag could do:
    /// a fixed window stays put, and a full-screen window has no frame to move.
    static func allowsManualMove(isMovable: Bool, isFullScreen: Bool) -> Bool {
        isMovable && !isFullScreen
    }

    @MainActor
    static func allowsManualMove(_ window: NSWindow) -> Bool {
        self.allowsManualMove(
            isMovable: window.isMovable,
            isFullScreen: window.styleMask.contains(.fullScreen))
    }

    /// Pointer delta in screen space, anchored on the press that started the
    /// gesture rather than on wherever the pointer is when the request lands.
    static func targetOrigin(startOrigin: NSPoint, pressPointer: NSPoint, pointer: NSPoint) -> NSPoint {
        NSPoint(
            x: startOrigin.x + (pointer.x - pressPointer.x),
            y: startOrigin.y + (pointer.y - pressPointer.y))
    }
}

/// Moves a dashboard window for a press the hosted page already surrendered.
///
/// The page can only hand a press over after WebKit delivered it, which is past
/// the point where `performDrag(with:)` starts a Window Server drag. Moving the
/// window for the rest of that gesture is the part that still works.
///
/// A page message alone is never enough to move anything: the bridge acts only
/// on a left-button press the native event stream recorded for the same window,
/// which page script cannot forge, and it consumes that press exactly once.
@MainActor
final class DashboardWindowWebDragBridge: NSObject {
    /// A press older than this no longer belongs to the gesture that posted the
    /// request. WebKit delivery costs a run-loop hop, not half a second.
    static let pressLifetime: TimeInterval = 0.5

    /// One physical left-button press, as the native event stream saw it.
    private struct Press {
        var clickCount: Int
        var timestamp: TimeInterval
        var screenPointer: NSPoint
        var windowOrigin: NSPoint
    }

    private final class Session {
        weak var window: NSWindow?
        let startOrigin: NSPoint
        let pressPointer: NSPoint

        init(press: Press, window: NSWindow) {
            self.window = window
            self.startOrigin = press.windowOrigin
            self.pressPointer = press.screenPointer
        }
    }

    private let trackedWindow: () -> NSWindow?
    private let pressClock: () -> TimeInterval
    private let primaryButtonIsDown: () -> Bool
    private var press: Press?
    private var session: Session?
    private var monitor: Any?

    /// - Parameters:
    ///   - window: The window this bridge may move; resolved per event so a
    ///     document that is being reparented cannot leave a stale window here.
    ///   - time: Monotonic clock for press age, matching `NSEvent.timestamp`.
    ///   - primaryButtonIsDown: Physical left-button state. Injected so tests
    ///     can sequence gestures that a test process cannot hold down.
    init(
        window: @escaping () -> NSWindow?,
        time: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
        primaryButtonIsDown: @escaping () -> Bool = { NSEvent.pressedMouseButtons & 0x1 != 0 })
    {
        self.trackedWindow = window
        self.pressClock = time
        self.primaryButtonIsDown = primaryButtonIsDown
        super.init()
        // Local monitors run on the main thread. The press itself keeps its
        // ordinary page and native path; only a drag the page already handed
        // over is held back from the page.
        self.monitor = NSEvent.addLocalMonitorForEvents(
            matching: [.leftMouseDown, .leftMouseDragged, .leftMouseUp])
        { [weak self] event in
            let dispatch = MainActor.assumeIsolated { self?.handle(event) ?? true }
            return dispatch ? event : nil
        }
    }

    isolated deinit {
        if let monitor {
            NSEvent.removeMonitor(monitor)
        }
        NotificationCenter.default.removeObserver(self)
    }

    /// True while a web-driven drag is following the pointer.
    var isDragging: Bool {
        self.session != nil
    }

    /// True while a native press is waiting for a page request to claim it.
    var hasPendingPress: Bool {
        self.press != nil
    }

    /// True while the native event stream is being observed for the next press.
    var isObservingNativePresses: Bool {
        self.monitor != nil
    }

    /// Fed by the native event stream only. Returns whether the event should
    /// still reach the window; a page-owned drag is kept from also running
    /// under the moving window.
    @discardableResult
    func handle(_ event: NSEvent) -> Bool {
        if event.type == .leftMouseUp {
            // A release ends the gesture wherever it lands, so a window that
            // slid away from the pointer cannot keep chasing it.
            self.press = nil
            self.finish()
            return true
        }
        guard let window = self.trackedWindow(), Self.isEvent(event, for: window) else {
            return true
        }

        switch event.type {
        case .leftMouseDown:
            // A new press replaces any gesture we never saw released.
            self.finish()
            self.press = Press(
                clickCount: event.clickCount,
                timestamp: event.timestamp,
                screenPointer: window.convertPoint(toScreen: event.locationInWindow),
                windowOrigin: window.frame.origin)
        case .leftMouseDragged:
            guard self.session != nil else { return true }
            self.move(to: event, in: window)
            // The page surrendered this gesture with `preventDefault`; it must
            // not also run its own drag handling beneath the moving window.
            return false
        default:
            break
        }
        return true
    }

    /// The page says its press belongs to the window. Act only on the press the
    /// native stream recorded for this window, once, while it is still live.
    func requestWindowDrag() {
        guard let window = self.trackedWindow(),
              let press = self.press,
              self.session == nil,
              self.isLive(press)
        else {
            return
        }

        // Consume before acting: a replayed or duplicated message must not move
        // the window a second time.
        self.press = nil

        // A titlebar double click zooms; the hosted page's titlebar band keeps
        // that native gesture instead of turning it into a drag.
        if press.clickCount == 2 {
            window.performZoom(nil)
            return
        }
        guard DashboardWindowDragPolicy.allowsManualMove(window) else { return }
        self.session = Session(press: press, window: window)
        self.observe(window)
    }

    /// Ends the drag and drops its observers. The recorded press stays until it
    /// is consumed or released.
    func finish() {
        guard self.session != nil else { return }
        self.session = nil
        NotificationCenter.default.removeObserver(
            self,
            name: NSWindow.willCloseNotification,
            object: nil)
        NotificationCenter.default.removeObserver(
            self,
            name: NSApplication.didResignActiveNotification,
            object: nil)
    }

    /// Releases the event monitor. Idempotent; the host calls this when its
    /// document goes away, and `deinit` repeats it as a backstop.
    func invalidate() {
        self.finish()
        self.press = nil
        if let monitor {
            NSEvent.removeMonitor(monitor)
            self.monitor = nil
        }
    }

    private func isLive(_ press: Press) -> Bool {
        let age = self.pressClock() - press.timestamp
        return age >= 0 && age <= Self.pressLifetime && self.primaryButtonIsDown()
    }

    private func move(to event: NSEvent, in window: NSWindow) {
        guard let session = self.session, session.window === window else {
            self.finish()
            return
        }
        var target = DashboardWindowDragPolicy.targetOrigin(
            startOrigin: session.startOrigin,
            pressPointer: session.pressPointer,
            pointer: window.convertPoint(toScreen: event.locationInWindow))
        // Keep a hand-dragged titlebar reachable rather than parking the window
        // off-screen, exactly as AppKit constrains its own frame changes.
        if let screen = window.screen ?? NSScreen.main {
            target = window.constrainFrameRect(
                NSRect(origin: target, size: window.frame.size),
                to: screen).origin
        }
        guard target != window.frame.origin else { return }
        window.setFrameOrigin(target)
    }

    private static func isEvent(_ event: NSEvent, for window: NSWindow) -> Bool {
        if let eventWindow = event.window {
            return eventWindow === window
        }
        return window.windowNumber != 0 && event.windowNumber == window.windowNumber
    }

    private func observe(_ window: NSWindow) {
        let center = NotificationCenter.default
        center.addObserver(
            self,
            selector: #selector(self.windowWillClose),
            name: NSWindow.willCloseNotification,
            object: window)
        center.addObserver(
            self,
            selector: #selector(self.applicationDidResignActive),
            name: NSApplication.didResignActiveNotification,
            object: nil)
    }

    /// A closing window must not leave a drag chasing a dead frame.
    @objc private func windowWillClose(_: Notification) {
        self.finish()
    }

    /// A release can happen outside this app; stop before the next activation
    /// turns a stale gesture into a jump.
    @objc private func applicationDidResignActive(_: Notification) {
        self.finish()
    }
}
