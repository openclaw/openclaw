import OpenClawChatUI
import SwiftUI

private enum RootSidebarShellMetric {
    static let topLeadingRadius: CGFloat = 8
    static let cornerRadius: CGFloat = 28
}

struct RootSidebarShell<Sidebar: View, Detail: View>: View {
    @Environment(\.displayScale) private var displayScale

    let sidebarWidth: CGFloat
    let isDrawerLayout: Bool
    let isPresented: Bool
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
            self.sidebarLayer
                .opacity(!self.isPresented && (!self.isDrawerLayout || self.reduceMotion) ? 0 : 1)
                .accessibilityHidden(!self.isPresented)
                .allowsHitTesting(self.isPresented)

            self.contentCard
                .opacity(self.isDrawerLayout && self.reduceMotion && self.isPresented ? 0 : 1)
                .accessibilityHidden(self.isDrawerLayout && self.isPresented)
                .zIndex(1)

            self.dismissalLayer
                .zIndex(2)
        }
        // One gesture owner for the drawer. Each UIKit pan is disabled whenever it cannot
        // act (split layout, Reduce Motion, pushed content owning the edge), so a back-swipe
        // that pops to the root cannot open the drawer with the same touch.
        .gesture(self.drawerPan(.open))
        .gesture(self.drawerPan(.close))
        .background(OpenClawProBackground())
        .transaction(value: self.isPresented, ChatScrollSignpost.sidebarDrawer)
        .animation(self.animation, value: self.isPresented)
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

    private var contentCard: some View {
        let offset = self.contentOffset
        let progress = self.sidebarWidth > 0 ? offset / self.sidebarWidth : 0
        let shape = RootSidebarContentClipShape.cardShape(progress: progress)
        return self.detail
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            // RootTabs always supplies its shared NavigationStack here. Expanding
            // that stack paints destination backgrounds through the rounded safe
            // areas while navigation chrome keeps destination content inset.
            .background(OpenClawProBackground())
            .ignoresSafeArea(.container, edges: self.isDrawerLayout ? .vertical : [])
            .allowsHitTesting(!self.isDrawerLayout || !self.isPresented)
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
            .padding(.leading, !self.isDrawerLayout && self.isPresented ? self.sidebarWidth : 0)
    }

    @ViewBuilder
    private var dismissalLayer: some View {
        if self.isDrawerLayout, self.isPresented {
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

    private var contentOffset: CGFloat {
        guard self.isDrawerLayout else { return 0 }
        return RootTabs.sidebarContentOffset(
            sidebarWidth: self.sidebarWidth,
            isVisible: self.isPresented,
            dragOffset: self.dragOffset,
            reduceMotion: self.reduceMotion)
    }

    private func drawerPan(_ intent: SidebarDrawerGesturePolicy.Intent) -> SidebarDrawerPanGesture {
        SidebarDrawerPanGesture(
            intent: intent,
            policy: SidebarDrawerGesturePolicy(
                layoutMode: self.isDrawerLayout ? .drawer : .split,
                isPresented: self.isPresented,
                canOpenFromEdge: self.canOpenFromEdge,
                reduceMotion: self.reduceMotion),
            sidebarWidth: self.sidebarWidth,
            onChanged: { self.dragOffset = $0 },
            onEnded: self.settleDrag)
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
