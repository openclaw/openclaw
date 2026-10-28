import SwiftUI
import UIKit

private enum RootSidebarShellMetric {
    static let edgeGestureWidth: CGFloat = 44
    static let topGestureExclusion: CGFloat = 44
    static let settleTranslation: CGFloat = 80
    static let settlePredictedTranslation: CGFloat = 160
    static let topLeadingRadius: CGFloat = 8
    static let cornerRadius: CGFloat = 28
    static let maximumDimmingOpacity: Double = 0.8
}

@MainActor
enum RootSidebarFeedback {
    static func settle(isDrawerLayout: Bool, reduceMotion: Bool) {
        guard isDrawerLayout, !reduceMotion else { return }
        let generator = UIImpactFeedbackGenerator(style: .light)
        generator.prepare()
        generator.impactOccurred()
    }
}

struct RootSidebarCardShape: InsettableShape {
    var offset: CGFloat
    let cornerRadii: RectangleCornerRadii
    private var insetAmount: CGFloat = 0

    init(offset: CGFloat, cornerRadii: RectangleCornerRadii) {
        self.offset = offset
        self.cornerRadii = cornerRadii
    }

    /// Animate the same displacement as the card, rather than its corner radii.
    /// Closing sets the model offset to zero before the card has reached it.
    var animatableData: CGFloat {
        get { self.offset }
        set { self.offset = newValue }
    }

    func path(in rect: CGRect) -> Path {
        let radii = self.offset == 0 ? RectangleCornerRadii() : self.cornerRadii
        return UnevenRoundedRectangle(cornerRadii: radii, style: .continuous)
            .inset(by: self.insetAmount)
            .path(in: rect)
    }

    func inset(by amount: CGFloat) -> Self {
        var shape = self
        shape.insetAmount += amount
        return shape
    }
}

struct RootSidebarShell<Sidebar: View, Detail: View>: View {
    enum DragDisposition: Equatable {
        case opening
        case closing
        case rejected
    }

    private struct DragState {
        var initialPresentation: Bool?
        var disposition: DragDisposition?
        var offset: CGFloat?
        var animation: Animation?
    }

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

    @State private var dragState = DragState()
    @State private var containerCornerRadii: RectangleCornerRadii?
    @GestureState private var isDragging = false

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
        // Gesture state stays inside this stable shell. The destination tree does
        // not own per-frame drag state, and the moving card never owns its recognizer.
        .simultaneousGesture(
            self.drawerGesture,
            // Keep the recognizer attached while pushed content owns the edge.
            // It rejects that touch once, so the same back-swipe cannot open the drawer after popping.
            isEnabled: self.isDrawerLayout && !self.reduceMotion)
        .background {
            if self.isDrawerLayout {
                OpenClawSidebarPalette.background.ignoresSafeArea()
            } else {
                OpenClawProBackground()
            }
        }
        .background {
            #if compiler(>=6.4)
            // Resolve corners at the stationary, full-window bounds before
            // translating the card. Its revealed corners retain that geometry.
            GeometryReader { geometry in
                if #available(iOS 27.0, *) {
                    Color.clear
                        .onChange(of: geometry.concentricCornerRadii, initial: true) { _, radii in
                            self.containerCornerRadii = radii
                        }
                }
            }
            .ignoresSafeArea(.container)
            #endif
        }
        .animation(self.animation, value: self.isPresented)
        .onChange(of: self.isPresented) { _, isPresented in
            // A navigation action supersedes a live gesture. Own releases clear
            // initialPresentation before asking the navigation owner to change.
            if self.dragState.initialPresentation != nil { self.dragState.disposition = .rejected }
            self.settle(to: isPresented)
        }
        .onChange(of: self.isDragging) { _, isDragging in
            // Cancellation does not call onEnded. Return to the navigation owner's
            // target without letting an automatic gesture reset move the card.
            guard !isDragging, self.dragState.initialPresentation != nil else { return }
            self.dragState.disposition = nil
            self.dragState.initialPresentation = nil
            self.settle(to: self.isPresented)
        }
        .onChange(of: self.sidebarWidth) { _, _ in self.resetDrag() }
        .onChange(of: self.isDrawerLayout) { _, _ in self.resetDrag() }
        .onChange(of: self.reduceMotion) { _, _ in self.resetDrag() }
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
        let shape = Self.contentShape(
            isDrawerLayout: self.isDrawerLayout,
            offset: offset,
            containerCornerRadii: self.containerCornerRadii)
        return self.detail
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(OpenClawProBackground())
            .allowsHitTesting(!self.isDrawerLayout || !self.isPresented)
            .overlay {
                OpenClawSidebarPalette.background
                    .opacity(self.isDrawerLayout ? RootSidebarShellMetric.maximumDimmingOpacity * Double(progress) : 0)
                    // Color is decorative. Explicitly hiding this overlay from
                    // accessibility can obscure native destination hit targets.
                    .allowsHitTesting(false)
            }
            .clipShape(shape)
            .overlay {
                shape.strokeBorder(
                    OpenClawSidebarPalette.hairline.opacity(Double(progress)),
                    lineWidth: 1)
            }
            // Expand outside the clip and border so both use the full-height
            // card bounds. Native navigation chrome still keeps content inset.
            .ignoresSafeArea(.container, edges: self.isDrawerLayout ? .vertical : [])
            .offset(x: offset)
            // Change only geometry, never the detail's structural identity, when
            // crossing the breakpoint or toggling a persistent sidebar.
            .padding(.leading, !self.isDrawerLayout && self.isPresented ? self.sidebarWidth : 0)
            // The release spring owns this displacement. The parent's visibility
            // animation must not replace its measured initial velocity.
            .animation(self.dragState.animation, value: self.dragState.offset)
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
        guard self.isDrawerLayout, !self.reduceMotion else { return 0 }
        return self.dragState.offset ?? RootTabs.sidebarContentOffset(
            sidebarWidth: self.sidebarWidth,
            isVisible: self.isPresented,
            dragOffset: 0,
            reduceMotion: self.reduceMotion)
    }

    private var drawerGesture: some Gesture {
        DragGesture(minimumDistance: 8)
            .updating(self.$isDragging) { _, isDragging, _ in isDragging = true }
            .onChanged { value in
                guard self.isDrawerLayout, !self.reduceMotion else { return }
                var state = self.dragState
                state.initialPresentation = state.initialPresentation ?? self.isPresented
                let disposition = Self.dragDisposition(
                    startLocation: value.startLocation,
                    translation: value.translation,
                    isPresented: self.isPresented,
                    initialPresentation: state.initialPresentation,
                    canOpenFromEdge: self.canOpenFromEdge,
                    latchedDisposition: state.disposition)
                state.disposition = disposition
                switch disposition {
                case .opening, .closing:
                    state.offset = RootTabs.sidebarContentOffset(
                        sidebarWidth: self.sidebarWidth,
                        isVisible: disposition == .closing,
                        dragOffset: value.translation.width,
                        reduceMotion: self.reduceMotion)
                    state.animation = nil
                case .rejected, nil:
                    break
                }
                // Release supplies an explicit velocity; do not accumulate a
                // second velocity from these unanimated, interactive changes.
                var transaction = Transaction(animation: nil)
                transaction.tracksVelocity = false
                withTransaction(transaction) { self.dragState = state }
            }
            .onEnded { value in
                let disposition = self.dragState.disposition
                let initialPresentation = self.dragState.initialPresentation
                self.dragState.disposition = nil
                self.dragState.initialPresentation = nil
                guard self.isDrawerLayout, !self.reduceMotion else { return }
                // The owner's update can reach this callback before onChange.
                guard initialPresentation == self.isPresented else {
                    self.settle(to: self.isPresented)
                    return
                }
                switch disposition {
                case .opening:
                    let opens = Self.shouldSettle(
                        translation: value.translation.width,
                        predictedTranslation: value.predictedEndTranslation.width)
                    self.settle(to: opens, velocity: value.velocity.width)
                    if opens {
                        self.onShow()
                    } else {
                        RootSidebarFeedback.settle(isDrawerLayout: self.isDrawerLayout, reduceMotion: self.reduceMotion)
                    }
                case .closing:
                    let closes = Self.shouldSettle(
                        translation: -value.translation.width,
                        predictedTranslation: -value.predictedEndTranslation.width)
                    self.settle(to: !closes, velocity: value.velocity.width)
                    if closes {
                        self.onHide()
                    } else {
                        RootSidebarFeedback.settle(isDrawerLayout: self.isDrawerLayout, reduceMotion: self.reduceMotion)
                    }
                case .rejected, nil:
                    break
                }
            }
    }

    private func settle(to isPresented: Bool, velocity: CGFloat? = nil) {
        guard let offset = self.dragState.offset else { return }
        let target = isPresented ? self.sidebarWidth : 0
        guard offset != target else { return }
        if let velocity {
            self.dragState.animation = .interpolatingSpring(
                duration: 0.35,
                bounce: 0,
                initialVelocity: Self.normalizedSpringVelocity(velocity, remainingOffset: target - offset))
        } else {
            self.dragState.animation = self.animation
        }
        self.dragState.offset = target
    }

    private func resetDrag() {
        self.dragState = DragState()
    }

    static func normalizedSpringVelocity(_ velocity: CGFloat, remainingOffset: CGFloat) -> Double {
        guard remainingOffset != 0 else { return 0 }
        // Normalize against the signed remaining displacement, including a
        // reversal before release. Bound fast flicks near the destination.
        return Double(max(-8, min(8, velocity / remainingOffset)))
    }

    static func dragDisposition(
        startLocation: CGPoint,
        translation: CGSize,
        isPresented: Bool,
        initialPresentation: Bool?,
        canOpenFromEdge: Bool,
        latchedDisposition: DragDisposition?) -> DragDisposition?
    {
        if let initialPresentation, initialPresentation != isPresented { return .rejected }
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

    private static func contentShape(
        isDrawerLayout: Bool,
        offset: CGFloat,
        containerCornerRadii: RectangleCornerRadii?) -> RootSidebarCardShape
    {
        // Resolve full corners once; the shape clips only while displaced.
        let radii = isDrawerLayout
            ? containerCornerRadii ?? RectangleCornerRadii(
                topLeading: RootSidebarShellMetric.topLeadingRadius,
                bottomLeading: RootSidebarShellMetric.cornerRadius,
                bottomTrailing: RootSidebarShellMetric.cornerRadius,
                topTrailing: RootSidebarShellMetric.cornerRadius)
            : RectangleCornerRadii()
        return RootSidebarCardShape(offset: offset, cornerRadii: radii)
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
