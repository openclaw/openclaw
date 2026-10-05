#if os(iOS)
import SwiftUI
import UIKit

/// Adjusts the actual viewport in the same layout pass as a fully measured prepend.
@MainActor
final class ChatNativePrependViewport: NSObject {
    private weak var scrollView: UIScrollView?
    private var sizeObservation: NSKeyValueObservation?
    private var baseline: (height: CGFloat, offset: CGFloat)?
    private var ready = false
    private var completionFrame: CADisplayLink?
    private var waitsForFirstLayout = false

    func attach(to scrollView: UIScrollView) {
        guard self.scrollView !== scrollView else { return }
        self.cancel()
        self.scrollView = scrollView
        self.sizeObservation = scrollView.observe(\.contentSize, options: [.new]) { [weak self] _, _ in
            MainActor.assumeIsolated { self?.applyIfReady() }
        }
    }

    func capture() {
        guard let scrollView else { return }
        self.cancel()
        self.baseline = (scrollView.contentSize.height, scrollView.contentOffset.y)
    }

    func pageArrived() -> Bool {
        guard self.baseline != nil, self.scrollView?.window != nil else {
            self.cancel()
            return false
        }
        self.ready = true
        self.waitsForFirstLayout = true
        self.applyIfReady()
        return true
    }

    func cancel() {
        self.baseline = nil
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
        guard self.ready, let baseline, let scrollView else { return }
        if scrollView.contentSize.height != baseline.height { self.waitsForFirstLayout = false }
        let offset = baseline.offset + scrollView.contentSize.height - baseline.height
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
        self.cancel()
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
