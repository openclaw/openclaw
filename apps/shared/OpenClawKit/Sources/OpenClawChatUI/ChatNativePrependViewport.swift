#if os(iOS)
import SwiftUI
import UIKit

/// Holds the reader's row in place while an older page lands above it.
/// The correction follows that row's own position: rows that finish sizing after the page lands are
/// followed, and a first size change that was not the prepend (a live row below) is undone once the
/// row is seen not to have moved.
@MainActor
final class ChatNativePrependViewport: NSObject {
    private weak var scrollView: UIScrollView?
    /// Its marker is the reader's row's current one: SwiftUI can rebuild the row's views while the page lands.
    weak var anchorSource: ChatHistoryScrollGeometry?
    private var sizeObservation: NSKeyValueObservation?
    /// From the page request until its landing settles. A user scroll does not end it:
    /// the correction moves the offset by the anchor's movement only, so a scroll is kept.
    private(set) var isPending = false
    private var landing: Landing?
    private var frameLink: CADisplayLink?

    private struct Landing {
        weak var anchor: UIView?
        /// The followed row; a rebuilt marker is taken up only for this row.
        let rowID: UUID?
        let start: CFTimeInterval
        var lastSize: CGFloat
        /// The anchor's content y that the current offset already accounts for.
        var heldAnchorY: CGFloat
        /// The anchor's y before the page. SwiftUI sets the content size before it moves the rows,
        /// and the row's old view can stay at this y for a frame; the row cannot return there.
        var staleAnchorY: CGFloat?
        var awaitsPrepend = true
        var stableSince: CFTimeInterval
        var lastTick: CFTimeInterval
        /// Frames the row has read at its pre-page position since the size correction.
        var staleFrames = 0
        let landed: ((_ atTop: Bool) -> Void)?

        func isStale(_ anchorY: CGFloat) -> Bool {
            self.staleAnchorY.map { abs(anchorY - $0) <= 0.25 } ?? false
        }
    }

    func attach(to scrollView: UIScrollView) {
        guard self.scrollView !== scrollView else { return }
        self.cancel()
        self.scrollView = scrollView
        self.sizeObservation = scrollView.observe(\.contentSize, options: [.new]) { [weak self] _, _ in
            MainActor.assumeIsolated { self?.sizeChanged() }
        }
    }

    func capture() {
        self.cancel()
        self.isPending = self.scrollView != nil
    }

    /// Starts following `anchor`, the reader's row, through the page's layout.
    /// `landed` runs when the landing settles on its own, not when it is cancelled, with whether the
    /// reader is at the top of the content.
    func pageArrived(anchor: UIView?, landed: ((_ atTop: Bool) -> Void)? = nil) -> Bool {
        guard self.isPending, let scrollView, scrollView.window != nil else {
            self.cancel()
            return false
        }
        let now = CACurrentMediaTime()
        let height = scrollView.contentSize.height
        // Without a connected row, content growth cannot distinguish a prepend from a reply below.
        // Let the caller use its interaction-fenced row restoration instead of guessing from size.
        guard let anchorY = self.contentY(of: anchor) else {
            self.cancel()
            return false
        }
        self.landing = Landing(
            anchor: anchor,
            rowID: (anchor as? ChatPrependAnchorMarker.MarkerView)?.rowID,
            start: now,
            lastSize: height,
            heldAnchorY: anchorY,
            stableSince: now,
            lastTick: now,
            landed: landed)
        let link = CADisplayLink(target: self, selector: #selector(self.frameTick))
        self.frameLink = link
        link.add(to: .main, forMode: .common)
        return true
    }

    func cancel() {
        self.isPending = false
        self.landing = nil
        self.frameLink?.invalidate()
        self.frameLink = nil
    }

    func detach() {
        self.cancel()
        self.sizeObservation = nil
        self.scrollView = nil
    }

    private func contentY(of view: UIView?) -> CGFloat? {
        guard let view, let scrollView, view.window != nil, view.isDescendant(of: scrollView) else { return nil }
        return view.convert(CGPoint.zero, to: scrollView).y
    }

    private func shift(by delta: CGFloat) {
        guard let scrollView, abs(delta) > 0.25 else { return }
        // Past the top edge the rubber band is transient: UIKit springs it back. Once the page gives
        // it content to land on, that spring is gone and the overscroll would stay, so finish it here.
        let overscroll = -scrollView.adjustedContentInset.top - scrollView.contentOffset.y
        UIView.performWithoutAnimation {
            scrollView.contentOffset.y += delta
        }
        if overscroll > 0.5, !scrollView.isDragging {
            scrollView.setContentOffset(
                CGPoint(x: scrollView.contentOffset.x, y: scrollView.contentOffset.y + overscroll), animated: true)
        }
    }

    /// The page's own layout pass. Correct before that frame is drawn: by the anchor if its
    /// position is already updated, else once by the size change, which the next frame checks.
    private func sizeChanged() {
        guard var landing = self.landing, let scrollView else { return }
        let height = scrollView.contentSize.height
        let sizeDelta = height - landing.lastSize
        landing.lastSize = height
        self.landing = landing
        if let anchorY = self.contentY(of: landing.anchor), abs(anchorY - landing.heldAnchorY) > 0.25,
           !landing.isStale(anchorY)
        {
            self.shift(by: anchorY - landing.heldAnchorY)
            self.landing?.heldAnchorY = anchorY
            self.landing?.awaitsPrepend = false
        } else if landing.awaitsPrepend, sizeDelta != 0 {
            self.shift(by: sizeDelta)
            self.landing?.heldAnchorY = landing.heldAnchorY + sizeDelta
            self.landing?.staleAnchorY = landing.heldAnchorY
            self.landing?.awaitsPrepend = false
        }
    }

    @objc private func frameTick() {
        guard var landing = self.landing, let scrollView else {
            self.cancel()
            return
        }
        let now = CACurrentMediaTime()
        let age = now - landing.start
        // Stability needs observed frames: after a main-thread stall, rows can still be about to grow.
        if now - landing.lastTick > 0.1 { landing.stableSince = now }
        landing.lastTick = now
        let held = landing.heldAnchorY
        let current = self.contentY(of: landing.anchor)
        if current.map(landing.isStale) ?? true, let marker = self.anchorSource?.anchorMarker,
           marker !== landing.anchor, landing.rowID != nil,
           (marker as? ChatPrependAnchorMarker.MarkerView)?.rowID == landing.rowID,
           let markerY = self.contentY(of: marker), !landing.isStale(markerY)
        {
            // A rebuilt row: its new marker has been through layout by this frame.
            landing.anchor = marker
        }
        guard let anchorY = self.contentY(of: landing.anchor) else {
            self.finish()
            return
        }
        if landing.isStale(anchorY) {
            // The old view usually reads its pre-page position for a frame before it moves or is replaced.
            // Still there after three frames, the row has not moved: the size change was not the prepend.
            landing.staleFrames += 1
            guard landing.staleFrames >= 3 else {
                self.landing = landing
                return
            }
            landing.staleAnchorY = nil
        }
        if abs(anchorY - held) > 0.25 {
            self.shift(by: anchorY - held)
            landing.awaitsPrepend = false
            landing.stableSince = now
        }
        landing.heldAnchorY = anchorY
        self.landing = landing
        let visible = scrollView.bounds.insetBy(dx: 0, dy: -scrollView.bounds.height)
        let offscreen = !landing.awaitsPrepend && !visible.contains(CGPoint(x: visible.midX, y: anchorY))
        let stable = !landing.awaitsPrepend && age > 0.6 && now - landing.stableSince > 0.3
        if offscreen || stable || age > 3 { self.finish() }
    }

    private func finish() {
        let landed = self.landing?.landed
        let atTop = self.scrollView.map { $0.contentOffset.y <= -$0.adjustedContentInset.top + 1 } ?? false
        self.cancel()
        landed?(atTop)
    }
}

struct ChatNativePrependProbe: UIViewRepresentable {
    let geometry: ChatHistoryScrollGeometry

    func makeUIView(context: Context) -> ProbeView {
        let view = ProbeView()
        view.isUserInteractionEnabled = false
        view.geometry = self.geometry
        return view
    }

    func updateUIView(_ view: ProbeView, context: Context) {
        view.geometry = self.geometry
        view.attach()
    }

    static func dismantleUIView(_ view: ProbeView, coordinator: ()) {
        view.viewport.detach()
        view.geometry?.nativeViewport = nil
    }

    final class ProbeView: UIView {
        let viewport = ChatNativePrependViewport()
        var geometry: ChatHistoryScrollGeometry?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            self.attach()
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            self.attach()
        }

        func attach() {
            var ancestor = self.superview
            while let view = ancestor {
                if let scrollView = view as? UIScrollView {
                    self.viewport.attach(to: scrollView)
                    self.viewport.anchorSource = self.geometry
                    self.geometry?.nativeViewport = self.viewport
                    return
                }
                ancestor = view.superview
            }
        }
    }
}

/// Marks the top of the reader's row as a UIKit view, so a landing reads its position in the
/// same layout pass as the scroll view's content size.
struct ChatPrependAnchorMarker: UIViewRepresentable {
    let geometry: ChatHistoryScrollGeometry
    let rowID: UUID

    func makeUIView(context: Context) -> MarkerView {
        let view = MarkerView()
        view.isUserInteractionEnabled = false
        view.geometry = self.geometry
        view.rowID = self.rowID
        return view
    }

    func updateUIView(_ view: MarkerView, context: Context) {
        view.geometry = self.geometry
        view.rowID = self.rowID
        if view.window != nil { self.geometry.anchorMarker = view }
    }

    static func dismantleUIView(_ view: MarkerView, coordinator: ()) {
        if view.geometry?.anchorMarker === view { view.geometry?.anchorMarker = nil }
    }

    final class MarkerView: UIView {
        weak var geometry: ChatHistoryScrollGeometry?
        var rowID: UUID?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            if self.window != nil {
                self.geometry?.anchorMarker = self
            } else if self.geometry?.anchorMarker === self {
                self.geometry?.anchorMarker = nil
            }
        }
    }
}

#if DEBUG
/// UI-test fixtures for history landings. Inert without their launch arguments.
enum ChatPrependFixture {
    private static let arguments = ProcessInfo.processInfo.arguments
    static let landingStallMs = Self.arguments.contains("--openclaw-history-landing-stall-fixture") ? 2500 : 0
    static let lateGrowth = Self.arguments.contains("--openclaw-history-late-growth-fixture")
    static let tickingTail = Self.arguments.contains("--openclaw-history-ticking-tail-fixture")
    nonisolated(unsafe) static var pageLanded = false
}

/// Rows of a landed page grow 0.4 s after they appear, like an image or preview finishing.
struct ChatPrependFixtureLateGrowth: ViewModifier {
    @State private var grown = false

    func body(content: Content) -> some View {
        content
            .padding(.bottom, self.grown ? 60 : 0)
            .task {
                guard ChatPrependFixture.lateGrowth, ChatPrependFixture.pageLanded else { return }
                try? await Task.sleep(for: .milliseconds(400))
                self.grown = true
            }
    }
}

/// A row below the reader that keeps changing height, like a live working row.
struct ChatPrependFixtureTickingRow: View {
    var body: some View {
        if ChatPrependFixture.tickingTail {
            TimelineView(.periodic(from: .now, by: 0.5)) { context in
                let ticks = Int(context.date.timeIntervalSinceReferenceDate * 2)
                Color.gray.opacity(0.2)
                    .frame(height: 20 + CGFloat(ticks % 20 * 200))
                    .accessibilityHidden(true)
            }
        }
    }
}
#endif
#endif
