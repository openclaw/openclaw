import SwiftUI
import UIKit

private let rootSidebarContentSpace = "RootSidebar.content"

/// Keeps what is on screen still when the list changes above it: the top visible session row holds its place.
@MainActor
final class RootSidebarScrollAnchor {
    weak var scrollView: UIScrollView?
    private var minY: [String: CGFloat] = [:]
    private var pass: (id: String, y: CGFloat)?
    private var passScheduled = false

    var isAtTop: Bool {
        (self.scrollView?.contentOffset.y ?? 0) <= 1
    }

    var isScrolling: Bool {
        self.scrollView.map { $0.isTracking || $0.isDecelerating } ?? false
    }

    func forget(_ id: String) {
        self.minY[id] = nil
    }

    // ponytail: an anchor row that is removed in the pass gets no correction; fall back to the next
    // row below it if that jump shows up in use.
    /// The rows of one layout pass report one by one, so the correction waits for all of them.
    func moved(_ id: String, to y: CGFloat) {
        if !self.passScheduled {
            var anchor: (id: String, y: CGFloat)?
            if let scrollView, !self.isAtTop, !self.isScrolling {
                let top = scrollView.contentOffset.y + scrollView.adjustedContentInset.top
                anchor = self.minY.filter { $0.value >= top }.min { $0.value < $1.value }.map { ($0.key, $0.value) }
            }
            self.pass = anchor
            self.passScheduled = true
            Task { @MainActor in self.finishPass() }
        }
        self.minY[id] = y
    }

    private func finishPass() {
        let anchor = self.pass
        self.pass = nil
        self.passScheduled = false
        if let anchor, let y = self.minY[anchor.id], let scrollView, !self.isScrolling {
            let delta = y - anchor.y
            if delta != 0 { scrollView.contentOffset.y = max(0, scrollView.contentOffset.y + delta) }
        }
    }
}

struct RootSidebarAnchoredRow: ViewModifier {
    let id: String
    let anchor: RootSidebarScrollAnchor

    func body(content: Content) -> some View {
        content
            .onGeometryChange(for: CGFloat.self) { $0.frame(in: .named(rootSidebarContentSpace)).minY } action: {
                self.anchor.moved(self.id, to: $0)
            }
            .onDisappear { self.anchor.forget(self.id) }
    }
}

struct RootSidebarAnchoredContent: ViewModifier {
    let anchor: RootSidebarScrollAnchor

    func body(content: Content) -> some View {
        content
            .coordinateSpace(.named(rootSidebarContentSpace))
            .background(RootSidebarScrollViewFinder(anchor: self.anchor))
    }
}

private struct RootSidebarScrollViewFinder: UIViewRepresentable {
    let anchor: RootSidebarScrollAnchor

    func makeUIView(context _: Context) -> UIView {
        let view = Probe()
        view.anchor = self.anchor
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_: UIView, context _: Context) {}

    final class Probe: UIView {
        var anchor: RootSidebarScrollAnchor?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            var view = self.superview
            while let current = view, !(current is UIScrollView) {
                view = current.superview
            }
            self.anchor?.scrollView = view as? UIScrollView
        }
    }
}
