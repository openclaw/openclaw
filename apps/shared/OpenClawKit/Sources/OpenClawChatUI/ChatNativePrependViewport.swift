#if os(iOS)
import SwiftUI
import UIKit

/// Adjusts the actual viewport in the same layout pass as a fully measured prepend.
@MainActor
final class ChatNativePrependViewport: NSObject {
    private weak var scrollView: UIScrollView?
    private var sizeObservation: NSKeyValueObservation?
    private var baseline: (row: ChatScrollRowGeometry, offset: CGFloat)?
    private var row: ChatScrollRowGeometry?
    private var ready = false
    private var completionFrame: CADisplayLink?
    private var waitsForFirstLayout = false
    private var afterLayout: (() -> Void)?

    func attach(to scrollView: UIScrollView) {
        guard self.scrollView !== scrollView else { return }
        self.cancel()
        self.scrollView = scrollView
        self.sizeObservation = scrollView.observe(\.contentSize, options: [.new]) { [weak self] _, _ in
            MainActor.assumeIsolated { self?.applyIfReady() }
        }
    }

    var isPreserving: Bool {
        self.baseline != nil
    }

    func capture(row: ChatScrollRowGeometry?) {
        self.cancel()
        guard let scrollView, let row else { return }
        self.baseline = (row, scrollView.contentOffset.y)
        self.row = row
    }

    func update(row: ChatScrollRowGeometry) {
        guard row.targetID == self.baseline?.row.targetID else { return }
        self.row = row
        self.applyIfReady()
    }

    func pageArrived(afterLayout: (() -> Void)? = nil) -> Bool {
        guard self.baseline != nil, self.scrollView?.window != nil else {
            self.cancel()
            return false
        }
        self.afterLayout = afterLayout
        self.ready = true
        self.waitsForFirstLayout = true
        self.applyIfReady()
        return true
    }

    func cancel() {
        self.afterLayout = nil
        self.baseline = nil
        self.row = nil
        self.ready = false
        self.waitsForFirstLayout = false
        self.completionFrame?.invalidate()
        self.completionFrame = nil
    }

    func detach() {
        self.cancel()
        self.sizeObservation = nil
        self.scrollView = nil
    }

    private func applyIfReady() {
        guard self.ready, let baseline, let row, let scrollView else { return }
        if row.contentMinY != baseline.row.contentMinY { self.waitsForFirstLayout = false }
        // Only this row's displacement belongs to the prepend; live output below it does not.
        let offset = baseline.offset + row.contentMinY - baseline.row.contentMinY
        if abs(scrollView.contentOffset.y - offset) > 0.25 {
            UIView.performWithoutAnimation {
                scrollView.setContentOffset(CGPoint(x: scrollView.contentOffset.x, y: offset), animated: false)
            }
        }
        if self.completionFrame == nil {
            let frame = CADisplayLink(target: self, selector: #selector(self.finishFrame))
            self.completionFrame = frame
            frame.add(to: .main, forMode: .common)
        }
    }

    @objc private func finishFrame() {
        self.applyIfReady()
        // An unchanged first sample can precede SwiftUI's page layout.
        // Give that layout its frame, then also release a true zero-height prepend.
        if self.waitsForFirstLayout {
            self.waitsForFirstLayout = false
            return
        }
        let afterLayout = self.afterLayout
        self.cancel()
        afterLayout?()
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
                    self.geometry?.nativeViewport = self.viewport
                    return
                }
                ancestor = view.superview
            }
        }
    }
}
#endif
