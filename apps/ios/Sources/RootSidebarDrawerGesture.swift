import OpenClawChatUI
import SwiftUI
import UIKit.UIGestureRecognizerSubclass

/// Decides what a drawer pan may do. Opening follows Apple's convention for
/// edge-owned navigation (interactive pop): only a pan that starts at the
/// leading screen edge opens the drawer. A horizontal swipe that starts
/// anywhere else stays with the content's own pan, which scrolls only by its
/// vertical component, exactly as a vertical pan would. Closing accepts a
/// leftward pan that starts anywhere while the drawer covers the content.
struct SidebarDrawerGesturePolicy: Equatable {
    enum Intent: Equatable {
        case open
        case close
    }

    enum Action: Equatable {
        case open
        case close
        case ignore
    }

    static let edgeWidth: CGFloat = 44
    /// Keeps the navigation bar row (back, sidebar, title controls) out of the open gesture.
    static let topExclusion: CGFloat = 44
    static let settleDistance: CGFloat = 80
    /// How long release velocity keeps carrying the card when projecting a flick's landing point.
    static let projectionDuration: CGFloat = 0.2

    var layoutMode: RootTabs.SidebarLayoutMode
    var isPresented: Bool
    var canOpenFromEdge: Bool
    var reduceMotion: Bool

    /// A disabled recognizer never sees touches, so content pans never wait on it.
    func isEnabled(for intent: Intent) -> Bool {
        guard self.layoutMode == .drawer, !self.reduceMotion else { return false }
        switch intent {
        case .open:
            return !self.isPresented && self.canOpenFromEdge
        case .close:
            return self.isPresented
        }
    }

    /// Whether a touch landing at `start` may become this pan. A rejected touch fails the
    /// recognizer on touch-down, so content pans never wait on it. `start` is measured from
    /// the leading screen edge and from the top of the safe area.
    func acceptsStart(_ start: CGPoint, for intent: Intent) -> Bool {
        guard self.isEnabled(for: intent) else { return false }
        switch intent {
        case .open:
            return start.x <= Self.edgeWidth && start.y > Self.topExclusion
        case .close:
            return true
        }
    }

    /// The intent a pan may begin with, or nil when the content keeps the touch.
    /// `translation` is positive toward the trailing edge and downward.
    func intent(start: CGPoint, translation: CGSize) -> Intent? {
        let vertical = abs(translation.height)
        if self.acceptsStart(start, for: .close) {
            return -translation.width > vertical ? .close : nil
        }
        guard self.acceptsStart(start, for: .open), translation.width > vertical else { return nil }
        return .open
    }

    /// Card displacement while a pan is tracking, relative to its resting position.
    static func trackingOffset(for intent: Intent, translation: CGFloat, sidebarWidth: CGFloat) -> CGFloat {
        switch intent {
        case .open:
            max(0, min(sidebarWidth, translation))
        case .close:
            max(-sidebarWidth, min(0, translation))
        }
    }

    /// Where the card settles when the pan ends; a flick back toward the start cancels.
    static func action(for intent: Intent, translation: CGFloat, velocity: CGFloat) -> Action {
        let direction: CGFloat = intent == .open ? 1 : -1
        let projected = direction * (translation + velocity * self.projectionDuration)
        guard projected > self.settleDistance else { return .ignore }
        return intent == .open ? .open : .close
    }
}

/// The drawer's only gesture owner: one UIKit pan opens from the leading edge, one closes.
/// Scroll views underneath wait for the drawer pan to fail, so a drawer swipe never also
/// scrolls the transcript; a touch outside the edge zone fails it on touch-down, so
/// ordinary scrolling never waits.
///
/// Not `UIScreenEdgePanGestureRecognizer`: the system decides its edge zone, and it never
/// opened the drawer for the behavior harness's edge drag (4 pt in), which the SwiftUI drag
/// it replaced did. This pan applies the same 44 pt zone itself, in window space.
struct SidebarDrawerPanGesture: UIGestureRecognizerRepresentable {
    let intent: SidebarDrawerGesturePolicy.Intent
    let policy: SidebarDrawerGesturePolicy
    let sidebarWidth: CGFloat
    let onChanged: (CGFloat) -> Void
    let onEnded: (SidebarDrawerGesturePolicy.Action) -> Void

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator {
        Coordinator(intent: self.intent, policy: self.policy)
    }

    func makeUIGestureRecognizer(context: Context) -> SidebarDrawerPanRecognizer {
        let recognizer = SidebarDrawerPanRecognizer()
        recognizer.maximumNumberOfTouches = 1
        recognizer.delegate = context.coordinator
        let coordinator = context.coordinator
        recognizer.acceptsStart = { [weak coordinator] start in
            guard let coordinator else { return false }
            let accepted = coordinator.policy.acceptsStart(start, for: coordinator.intent)
            Self.mark(coordinator.intent, accepted ? "touch" : "failed-start")
            return accepted
        }
        self.updateUIGestureRecognizer(recognizer, context: context)
        return recognizer
    }

    func updateUIGestureRecognizer(_ recognizer: SidebarDrawerPanRecognizer, context: Context) {
        context.coordinator.policy = self.policy
        recognizer.isEnabled = self.policy.isEnabled(for: self.intent)
    }

    func handleUIGestureRecognizerAction(_ recognizer: SidebarDrawerPanRecognizer, context: Context) {
        let translation = recognizer.drawerTranslation.width
        switch recognizer.state {
        case .began, .changed:
            if recognizer.state == .began { Self.mark(self.intent, "began") }
            self.onChanged(SidebarDrawerGesturePolicy.trackingOffset(
                for: self.intent,
                translation: translation,
                sidebarWidth: self.sidebarWidth))
        case .ended:
            let action = SidebarDrawerGesturePolicy.action(
                for: self.intent,
                translation: translation,
                velocity: recognizer.drawerVelocity)
            Self.mark(self.intent, "ended:\(action)")
            self.onEnded(action)
        case .cancelled, .failed:
            Self.mark(self.intent, "cancelled")
            self.onEnded(.ignore)
        default:
            break
        }
    }

    /// Behavior-probe marks (`drawer-pan:<intent>:<state>`) so a harness run shows where a
    /// drawer swipe stopped; a no-op unless a DEBUG build is recording the probe. `state` is an
    /// autoclosure so release builds never format it.
    private static func mark(_ intent: SidebarDrawerGesturePolicy.Intent, _ state: @autoclosure () -> String) {
        #if DEBUG
        ChatBehaviorProbe.mark("drawer-pan:\(intent):\(state())")
        #endif
    }

    @MainActor
    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        let intent: SidebarDrawerGesturePolicy.Intent
        var policy: SidebarDrawerGesturePolicy

        init(intent: SidebarDrawerGesturePolicy.Intent, policy: SidebarDrawerGesturePolicy) {
            self.intent = intent
            self.policy = policy
        }

        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard let pan = gestureRecognizer as? SidebarDrawerPanRecognizer else { return false }
            let begins = self.policy.intent(start: pan.start, translation: pan.drawerTranslation) == self.intent
            if !begins { SidebarDrawerPanGesture.mark(self.intent, "failed-direction") }
            return begins
        }

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldBeRequiredToFailBy otherGestureRecognizer: UIGestureRecognizer) -> Bool
        {
            Self.mustWaitForDrawer(otherGestureRecognizer)
        }

        /// A scroll view's pan (the transcript's included) begins only after the drawer pan fails.
        static func mustWaitForDrawer(_ other: UIGestureRecognizer) -> Bool {
            guard let scrollView = other.view as? UIScrollView else { return false }
            return other === scrollView.panGestureRecognizer
        }
    }
}

/// A pan measured in drawer space: x from the leading screen edge (positive toward the
/// trailing edge), y from the top of the window's safe area. It asks `acceptsStart` on
/// touch-down and fails at once when the touch cannot become a drawer pan.
final class SidebarDrawerPanRecognizer: UIPanGestureRecognizer {
    var acceptsStart: @MainActor (CGPoint) -> Bool = { _ in false }
    private(set) var start: CGPoint = .zero

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesBegan(touches, with: event)
        guard self.state == .possible, let touch = touches.first, let window = self.view?.window else { return }
        self.start = Self.drawerPoint(
            touch.location(in: window),
            windowWidth: window.bounds.width,
            safeAreaTop: window.safeAreaInsets.top,
            isRightToLeft: self.isRightToLeft)
        if !self.acceptsStart(self.start) {
            self.state = .failed
        }
    }

    var drawerTranslation: CGSize {
        let translation = self.translation(in: nil)
        return CGSize(width: self.isRightToLeft ? -translation.x : translation.x, height: translation.y)
    }

    var drawerVelocity: CGFloat {
        let velocity = self.velocity(in: nil).x
        return self.isRightToLeft ? -velocity : velocity
    }

    private var isRightToLeft: Bool {
        self.view?.effectiveUserInterfaceLayoutDirection == .rightToLeft
    }

    static func drawerPoint(
        _ windowPoint: CGPoint,
        windowWidth: CGFloat,
        safeAreaTop: CGFloat,
        isRightToLeft: Bool) -> CGPoint
    {
        CGPoint(
            x: isRightToLeft ? windowWidth - windowPoint.x : windowPoint.x,
            y: windowPoint.y - safeAreaTop)
    }
}
