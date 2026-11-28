import Observation
import SwiftUI

/// Pulling the sidebar list down past its top opens search. The list's own scroll view does the
/// pulling, so its rubber band, the drawer's horizontal pan and the scroll anchor stay as they are:
/// the drawer pan only takes horizontal drags, and the anchor never corrects a list at its top.
struct RootSidebarPullToSearch: Equatable {
    /// How far past the top the list must be pulled, in points of on-screen travel.
    static let threshold: CGFloat = 96
    static let topTolerance: CGFloat = 1

    /// A drag that began with the list at its top; only it can open search.
    private(set) var isTracking = false
    /// After an early release, the circle follows the list as it bounces back.
    private(set) var isSettling = false
    private(set) var distance: CGFloat = 0

    var progress: CGFloat {
        guard self.isTracking || self.isSettling else { return 0 }
        return min(max(self.distance / Self.threshold, 0), 1)
    }

    var hasReachedThreshold: Bool {
        self.isTracking && self.distance >= Self.threshold
    }

    /// `offset` is how far the list sits below its top; it is negative while pulled past it.
    mutating func dragBegan(offset: CGFloat) {
        self.isSettling = false
        self.isTracking = offset <= Self.topTolerance
        self.distance = self.isTracking ? max(0, -offset) : 0
    }

    mutating func scrolled(offset: CGFloat) {
        guard self.isTracking || self.isSettling else { return }
        self.distance = max(0, -offset)
        if self.isSettling, self.distance == 0 {
            self.isSettling = false
        }
    }

    /// Whether this release opens search.
    mutating func dragEnded() -> Bool {
        guard self.isTracking else { return false }
        let opens = self.distance >= Self.threshold
        self.isTracking = false
        self.isSettling = !opens && self.distance > 0
        if opens {
            self.distance = 0
        }
        return opens
    }
}

/// Holds the pull so that only the search circle redraws while the list moves.
@MainActor @Observable
final class RootSidebarPullTracker {
    private(set) var state = RootSidebarPullToSearch()

    func update(_ change: (inout RootSidebarPullToSearch) -> Void) {
        var next = self.state
        change(&next)
        if next != self.state {
            self.state = next
        }
    }
}

/// Feeds the tracker from the list's scroll position and its drag phase.
struct RootSidebarPullToSearchTracking: ViewModifier {
    let tracker: RootSidebarPullTracker
    let openSearch: () -> Void

    func body(content: Content) -> some View {
        content
            .onScrollGeometryChange(for: CGFloat.self) { geometry in
                geometry.contentOffset.y + geometry.contentInsets.top
            } action: { _, offset in
                self.tracker.update { $0.scrolled(offset: offset) }
            }
            .onScrollPhaseChange { old, new, context in
                if new == .interacting, old != .interacting {
                    let offset = context.geometry.contentOffset.y + context.geometry.contentInsets.top
                    self.tracker.update { $0.dragBegan(offset: offset) }
                } else if old == .interacting, new != .interacting {
                    var opens = false
                    self.tracker.update { opens = $0.dragEnded() }
                    if opens {
                        self.openSearch()
                    }
                }
            }
    }
}

/// The search circle answers the pull: a ring fills and the circle grows with the distance,
/// with one tick when the pull reaches the point where releasing opens search.
/// Reduce Motion keeps the circle's size; the ring, the threshold and the tick stay.
struct RootSidebarPullIndicator: ViewModifier {
    let tracker: RootSidebarPullTracker
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        let state = self.tracker.state
        let progress = state.progress
        content
            .overlay {
                if progress > 0 {
                    ZStack {
                        Circle()
                            .fill(OpenClawSidebarPalette.text.opacity(0.14 * progress))
                        Circle()
                            .trim(from: 0, to: progress)
                            .stroke(OpenClawSidebarPalette.accent, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                            .rotationEffect(.degrees(-90))
                            .padding(1)
                    }
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                }
            }
            .scaleEffect(self.reduceMotion ? 1 : 1 + 0.2 * progress)
            .sensoryFeedback(.impact(weight: .medium), trigger: state.hasReachedThreshold) { old, new in
                !old && new
            }
    }
}
