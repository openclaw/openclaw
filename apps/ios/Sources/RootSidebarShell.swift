import SwiftUI

private enum RootSidebarShellMetric {
    static let edgeGestureWidth: CGFloat = 44
    static let topGestureExclusion: CGFloat = 44
    static let settleTranslation: CGFloat = 80
    static let settlePredictedTranslation: CGFloat = 160
    static let topLeadingRadius: CGFloat = 8
    static let cornerRadius: CGFloat = 28
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
    let isPresented: Bool
    let canOpenFromEdge: Bool
    let reduceMotion: Bool
    let animation: Animation?
    let onShow: () -> Void
    let onHide: () -> Void
    let sidebar: Sidebar
    let detail: Detail

    @State private var dragSession = DragSession()
    @GestureState(resetTransaction: Transaction(animation: .spring(response: 0.35, dampingFraction: 0.86)))
    private var dragState = DragState()

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
        .background(OpenClawProBackground())
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
        let shape = Self.contentShape(progress: progress)
        return self.detail
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            // RootTabs always supplies its shared NavigationStack here. Expanding
            // that stack paints destination backgrounds through the rounded safe
            // areas while navigation chrome keeps destination content inset.
            .background(OpenClawProBackground())
            .ignoresSafeArea(.container, edges: self.isDrawerLayout ? .vertical : [])
            .allowsHitTesting(!self.isDrawerLayout || !self.isPresented)
            .clipShape(shape)
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
            dragOffset: self.dragState.translationWidth,
            reduceMotion: self.reduceMotion)
    }

    private var drawerGesture: some Gesture {
        let isDrawerLayout = self.isDrawerLayout
        let sidebarWidth = self.sidebarWidth
        let isPresented = self.isPresented
        let canOpenFromEdge = self.canOpenFromEdge
        let onShow = self.onShow
        let onHide = self.onHide
        let dragSession = self.dragSession
        return DragGesture(minimumDistance: 8)
            .updating(self.$dragState) { value, state, _ in
                guard isDrawerLayout else { return }
                let disposition = Self.dragDisposition(
                    startLocation: value.startLocation,
                    translation: value.translation,
                    isPresented: isPresented,
                    canOpenFromEdge: canOpenFromEdge,
                    latchedDisposition: state.disposition)
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

    private static func contentShape(progress: CGFloat) -> UnevenRoundedRectangle {
        UnevenRoundedRectangle(
            topLeadingRadius: RootSidebarShellMetric.topLeadingRadius * progress,
            bottomLeadingRadius: RootSidebarShellMetric.cornerRadius * progress,
            bottomTrailingRadius: RootSidebarShellMetric.cornerRadius * progress,
            topTrailingRadius: RootSidebarShellMetric.cornerRadius * progress,
            style: .continuous)
    }
}
