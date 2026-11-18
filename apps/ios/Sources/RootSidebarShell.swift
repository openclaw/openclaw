import SwiftUI

private enum RootSidebarShellMetric {
    static let edgeGestureWidth: CGFloat = 44
    static let topGestureExclusion: CGFloat = 44
    static let settleTranslation: CGFloat = 80
    static let settlePredictedTranslation: CGFloat = 160
    static let topLeadingRadius: CGFloat = 8
    static let cornerRadius: CGFloat = 28
}

/// Sidebar visibility. Only small leaf views and modifiers read it, so a toggle does not
/// re-evaluate the shell or RootTabs, which would re-run the sidebar and destination views.
@Observable
final class RootSidebarPresentation {
    /// Animated card position.
    var isPresented: Bool
    /// Follows `isPresented` once the toggle animation settles. Content that pauses or
    /// restyles behind the drawer reads this, so its work never delays the animation.
    var isSettledPresented: Bool

    init(isPresented: Bool) {
        self.isPresented = isPresented
        self.isSettledPresented = isPresented
    }
}

struct RootSidebarShell<Sidebar: View, Detail: View>: View {
    enum DragDisposition: Equatable {
        case opening
        case closing
        case rejected
    }

    private struct DragState: Equatable {
        var disposition: DragDisposition?
        var translationWidth: CGFloat = 0
    }

    private final class DragSession {
        var disposition: DragDisposition?
    }

    @Environment(\.displayScale) private var displayScale

    let sidebarWidth: CGFloat
    let isDrawerLayout: Bool
    let presentation: RootSidebarPresentation
    let canOpenFromEdge: Bool
    let reduceMotion: Bool
    let animation: Animation?
    let onShow: () -> Void
    let onHide: () -> Void
    let sidebar: Sidebar
    let detail: Detail
    let contentSafeAreaInsets: EdgeInsets

    @State private var dragSession = DragSession()
    @State private var scrollCanceller = RootSidebarScrollCanceller()
    @GestureState(resetTransaction: Transaction(animation: .spring(response: 0.35, dampingFraction: 0.86)))
    private var dragState = DragState()

    var body: some View {
        ZStack(alignment: .leading) {
            // The body never reads `presentation`: re-evaluating it would make SwiftUI
            // re-check `sidebar` and `detail`, which re-runs any with stateful properties.
            self.sidebarLayer
                .modifier(RootSidebarLayerPresentation(
                    presentation: self.presentation,
                    isDrawerLayout: self.isDrawerLayout,
                    reduceMotion: self.reduceMotion,
                    animation: self.animation))

            self.detail
                .modifier(RootSidebarContentCard(
                    presentation: self.presentation,
                    dragOffset: self.dragState.translationWidth,
                    sidebarWidth: self.sidebarWidth,
                    isDrawerLayout: self.isDrawerLayout,
                    reduceMotion: self.reduceMotion,
                    animation: self.animation,
                    contentSafeAreaInsets: self.contentSafeAreaInsets))
                .zIndex(1)

            RootSidebarDismissalLayer(
                presentation: self.presentation,
                isDrawerLayout: self.isDrawerLayout,
                sidebarWidth: self.sidebarWidth,
                onHide: self.onHide)
                .zIndex(2)
        }
        .background(RootSidebarScrollCancellerAnchor(canceller: self.scrollCanceller))
        // Gesture state stays inside this stable shell. The destination tree does
        // not own per-frame drag state, and the moving card never owns its recognizer.
        .simultaneousGesture(
            self.drawerGesture,
            // Keep the recognizer attached while pushed content owns the edge.
            // It rejects that touch once, so the same back-swipe cannot open the drawer after popping.
            isEnabled: self.isDrawerLayout && !self.reduceMotion)
        .background(OpenClawProBackground())
    }

    private var sidebarLayer: some View {
        self.sidebar
            .frame(width: self.sidebarWidth, alignment: .topLeading)
            .frame(maxHeight: .infinity, alignment: .topLeading)
            .background(OpenClawSidebarPalette.background)
            .overlay(alignment: .trailing) {
                Rectangle()
                    .fill(OpenClawSidebarPalette.hairline)
                    .frame(width: 1 / self.displayScale)
                    .opacity(self.isDrawerLayout ? 0 : 1)
            }
            .ignoresSafeArea(.container, edges: self.isDrawerLayout ? .vertical : [])
    }

    private var drawerGesture: some Gesture {
        let isDrawerLayout = self.isDrawerLayout
        let sidebarWidth = self.sidebarWidth
        let presentation = self.presentation
        let canOpenFromEdge = self.canOpenFromEdge
        let onShow = self.onShow
        let onHide = self.onHide
        let dragSession = self.dragSession
        let scrollCanceller = self.scrollCanceller
        return DragGesture(minimumDistance: 8)
            .updating(self.$dragState) { value, state, _ in
                guard isDrawerLayout else { return }
                let disposition = Self.dragDisposition(
                    startLocation: value.startLocation,
                    translation: value.translation,
                    isPresented: presentation.isPresented,
                    canOpenFromEdge: canOpenFromEdge,
                    latchedDisposition: state.disposition)
                if state.disposition == nil, disposition == .opening || disposition == .closing {
                    scrollCanceller.cancelScrolling(at: value.startLocation)
                }
                state.disposition = disposition
                dragSession.disposition = disposition
                switch disposition {
                case .opening:
                    state.translationWidth = max(0, min(sidebarWidth, value.translation.width))
                case .closing:
                    state.translationWidth = max(-sidebarWidth, min(0, value.translation.width))
                case .rejected, nil:
                    break
                }
            }
            .onEnded { value in
                let disposition = dragSession.disposition
                dragSession.disposition = nil
                guard isDrawerLayout else { return }
                switch disposition {
                case .opening:
                    if Self.shouldSettle(
                        translation: value.translation.width,
                        predictedTranslation: value.predictedEndTranslation.width)
                    {
                        onShow()
                    }
                case .closing:
                    if Self.shouldSettle(
                        translation: -value.translation.width,
                        predictedTranslation: -value.predictedEndTranslation.width)
                    {
                        onHide()
                    }
                case .rejected, nil:
                    break
                }
            }
    }

    static func dragDisposition(
        startLocation: CGPoint,
        translation: CGSize,
        isPresented: Bool,
        canOpenFromEdge: Bool,
        latchedDisposition: DragDisposition?) -> DragDisposition?
    {
        if let latchedDisposition { return latchedDisposition }
        if !isPresented {
            // Opening is an edge gesture; closing may start anywhere on the content card.
            guard canOpenFromEdge,
                  startLocation.x <= RootSidebarShellMetric.edgeGestureWidth,
                  startLocation.y > RootSidebarShellMetric.topGestureExclusion
            else { return .rejected }
        }
        let horizontal = isPresented ? -translation.width : translation.width
        let vertical = abs(translation.height)
        // Leave marginal diagonals undecided without moving the card; once vertical
        // scrolling wins, latch rejection so a later thumb arc cannot open the drawer.
        guard horizontal >= vertical else { return .rejected }
        guard horizontal >= 16, horizontal > 2 * vertical else { return nil }
        return isPresented ? .closing : .opening
    }

    private static func shouldSettle(
        translation: CGFloat,
        predictedTranslation: CGFloat) -> Bool
    {
        translation > RootSidebarShellMetric.settleTranslation ||
            predictedTranslation > RootSidebarShellMetric.settlePredictedTranslation
    }
}

private struct RootSidebarLayerPresentation: ViewModifier {
    let presentation: RootSidebarPresentation
    let isDrawerLayout: Bool
    let reduceMotion: Bool
    let animation: Animation?

    func body(content: Content) -> some View {
        let isPresented = self.presentation.isPresented
        content
            .opacity(!isPresented && (!self.isDrawerLayout || self.reduceMotion) ? 0 : 1)
            .accessibilityHidden(!isPresented)
            .allowsHitTesting(isPresented)
            .animation(self.animation, value: isPresented)
    }
}

private struct RootSidebarContentCard: ViewModifier {
    let presentation: RootSidebarPresentation
    let dragOffset: CGFloat
    let sidebarWidth: CGFloat
    let isDrawerLayout: Bool
    let reduceMotion: Bool
    let animation: Animation?
    let contentSafeAreaInsets: EdgeInsets

    func body(content: Content) -> some View {
        let isPresented = self.presentation.isPresented
        let offset = self.isDrawerLayout
            ? RootTabs.sidebarContentOffset(
                sidebarWidth: self.sidebarWidth,
                isVisible: isPresented,
                dragOffset: self.dragOffset,
                reduceMotion: self.reduceMotion)
            : 0
        let progress = self.sidebarWidth > 0 ? offset / self.sidebarWidth : 0
        let shape = RootSidebarContentClipShape.cardShape(progress: progress)
        return content
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            // RootTabs always supplies its shared NavigationStack here. Expanding
            // that stack paints destination backgrounds through the rounded safe
            // areas while navigation chrome keeps destination content inset.
            .background(OpenClawProBackground())
            .ignoresSafeArea(.container, edges: self.isDrawerLayout ? .vertical : [])
            .allowsHitTesting(!self.isDrawerLayout || !isPresented)
            // Native bars can paint outside the content bounds into the system
            // safe area. Keep them inside the card's mask without moving content.
            .clipShape(RootSidebarContentClipShape(
                progress: progress,
                safeAreaInsets: self.contentSafeAreaInsets))
            .overlay {
                shape.strokeBorder(
                    OpenClawSidebarPalette.hairline.opacity(Double(progress)),
                    lineWidth: 1)
            }
            .offset(x: offset)
            // Change only geometry, never the detail's structural identity, when
            // crossing the breakpoint or toggling a persistent sidebar.
            .padding(.leading, !self.isDrawerLayout && isPresented ? self.sidebarWidth : 0)
            .opacity(self.isDrawerLayout && self.reduceMotion && isPresented ? 0 : 1)
            .accessibilityHidden(self.isDrawerLayout && isPresented)
            .animation(self.animation, value: isPresented)
    }
}

private struct RootSidebarDismissalLayer: View {
    let presentation: RootSidebarPresentation
    let isDrawerLayout: Bool
    let sidebarWidth: CGFloat
    let onHide: () -> Void

    var body: some View {
        if self.isDrawerLayout, self.presentation.isPresented {
            HStack(spacing: 0) {
                Color.clear
                    .frame(width: self.sidebarWidth)
                    .allowsHitTesting(false)
                Color.clear
                    .contentShape(Rectangle())
                    .accessibilityHidden(true)
                    .onTapGesture(perform: self.onHide)
            }
        }
    }
}

/// The drawer gesture runs alongside content gestures so taps and scrolls keep working,
/// which also lets a scroll view under the finger follow a drawer drag's vertical drift.
/// Once the drawer claims the drag, this cancels that scrolling. Drift before the claim,
/// at most a few points, still moves the content.
@MainActor
private final class RootSidebarScrollCanceller {
    weak var view: UIView?

    func cancelScrolling(at location: CGPoint) {
        guard let view, let window = view.window else { return }
        var candidate = window.hitTest(view.convert(location, to: window), with: nil)
        while let current = candidate {
            if let scroll = current as? UIScrollView, scroll.panGestureRecognizer.isEnabled {
                // Disabling a recognizer cancels its current touches; the next touch scrolls normally.
                scroll.panGestureRecognizer.isEnabled = false
                scroll.panGestureRecognizer.isEnabled = true
            }
            candidate = current.superview
        }
    }
}

/// Gives the canceller a view in the gesture's coordinate space.
private struct RootSidebarScrollCancellerAnchor: UIViewRepresentable {
    let canceller: RootSidebarScrollCanceller

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.isUserInteractionEnabled = false
        self.canceller.view = view
        return view
    }

    func updateUIView(_ view: UIView, context: Context) {
        self.canceller.view = view
    }
}

struct RootSidebarContentClipShape: Shape {
    var progress: CGFloat
    let safeAreaInsets: EdgeInsets

    var animatableData: CGFloat {
        get { self.progress }
        set { self.progress = newValue }
    }

    func path(in rect: CGRect) -> Path {
        let progress = min(1, max(0, self.progress))
        let expansion = 1 - progress
        let barBounds = CGRect(
            x: rect.minX - self.safeAreaInsets.leading * expansion,
            y: rect.minY - self.safeAreaInsets.top * expansion,
            width: rect.width + (self.safeAreaInsets.leading + self.safeAreaInsets.trailing) * expansion,
            height: rect.height + (self.safeAreaInsets.top + self.safeAreaInsets.bottom) * expansion)
        return Self.cardShape(progress: progress).path(in: barBounds)
    }

    static func cardShape(progress: CGFloat) -> UnevenRoundedRectangle {
        UnevenRoundedRectangle(
            topLeadingRadius: RootSidebarShellMetric.topLeadingRadius * progress,
            bottomLeadingRadius: RootSidebarShellMetric.cornerRadius * progress,
            bottomTrailingRadius: RootSidebarShellMetric.cornerRadius * progress,
            topTrailingRadius: RootSidebarShellMetric.cornerRadius * progress,
            style: .continuous)
    }
}

/// UIKit grants a navigation controller its system minimum layout margins only
/// while its view touches the screen edge. The sidebar shell slides the detail card away
/// from that edge, which zeroes the margins and pins native large titles flush
/// against the card. Owning the margins explicitly keeps them stable at any offset.
struct SidebarNavigationMarginAnchor: UIViewRepresentable {
    func makeUIView(context: Context) -> UIView {
        AnchorView()
    }

    func updateUIView(_ uiView: UIView, context: Context) {}

    private final class AnchorView: UIView {
        private var positionObservation: NSKeyValueObservation?

        /// UIKit recomputes the margins whenever the controller view moves, so the
        /// override follows the view's position instead of running once.
        override func didMoveToWindow() {
            super.didMoveToWindow()
            self.positionObservation = nil
            var responder: UIResponder? = self
            while let current = responder, !(current is UINavigationController) {
                responder = current.next
            }
            guard let navigation = responder as? UINavigationController else { return }
            Self.applyMargins(to: navigation)
            // Layer position only changes on the main thread, where UIKit drives layout.
            self.positionObservation = navigation.view.layer.observe(\.position) { [weak navigation] _, _ in
                MainActor.assumeIsolated {
                    guard let navigation else { return }
                    Self.applyMargins(to: navigation)
                }
            }
        }

        private static func applyMargins(to navigation: UINavigationController) {
            navigation.viewRespectsSystemMinimumLayoutMargins = false
            // The displaced controller reports zero; the window root sits at the edge.
            guard let margins = navigation.view.window?.rootViewController?.systemMinimumLayoutMargins
            else { return }
            guard navigation.view.directionalLayoutMargins != margins else { return }
            navigation.view.directionalLayoutMargins = margins
        }
    }
}
