import OpenClawChatUI
import SwiftUI

private enum RootSidebarShellMetric {
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

    /// Card displacement of the pan in flight; the drawer's per-frame state lives only here.
    @State private var dragOffset: CGFloat = 0

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
                    dragOffset: self.dragOffset,
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
        // One gesture owner for the drawer. Each UIKit pan is disabled whenever it cannot
        // act (split layout, Reduce Motion, pushed content owning the edge), so a back-swipe
        // that pops to the root cannot open the drawer with the same touch.
        .modifier(RootSidebarDrawerGestures(
            presentation: self.presentation,
            sidebarWidth: self.sidebarWidth,
            isDrawerLayout: self.isDrawerLayout,
            canOpenFromEdge: self.canOpenFromEdge,
            reduceMotion: self.reduceMotion,
            onChanged: { self.dragOffset = $0 },
            onEnded: self.settleDrag))
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

    /// Releases the card from the finger and settles it in one animated transaction.
    private func settleDrag(_ action: SidebarDrawerGesturePolicy.Action) {
        withAnimation(self.animation) {
            self.dragOffset = 0
            switch action {
            case .open:
                self.onShow()
            case .close:
                self.onHide()
            case .ignore:
                break
            }
        }
    }
}

private struct RootSidebarDrawerGestures: ViewModifier {
    let presentation: RootSidebarPresentation
    let sidebarWidth: CGFloat
    let isDrawerLayout: Bool
    let canOpenFromEdge: Bool
    let reduceMotion: Bool
    let onChanged: (CGFloat) -> Void
    let onEnded: (SidebarDrawerGesturePolicy.Action) -> Void

    func body(content: Content) -> some View {
        let policy = SidebarDrawerGesturePolicy(
            layoutMode: self.isDrawerLayout ? .drawer : .split,
            isPresented: self.presentation.isPresented,
            canOpenFromEdge: self.canOpenFromEdge,
            reduceMotion: self.reduceMotion)
        content
            .gesture(self.pan(.open, policy: policy))
            .gesture(self.pan(.close, policy: policy))
    }

    private func pan(
        _ intent: SidebarDrawerGesturePolicy.Intent,
        policy: SidebarDrawerGesturePolicy) -> SidebarDrawerPanGesture
    {
        SidebarDrawerPanGesture(
            intent: intent,
            policy: policy,
            sidebarWidth: self.sidebarWidth,
            onChanged: self.onChanged,
            onEnded: self.onEnded)
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
            .transaction(value: isPresented, ChatScrollSignpost.sidebarDrawer)
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
