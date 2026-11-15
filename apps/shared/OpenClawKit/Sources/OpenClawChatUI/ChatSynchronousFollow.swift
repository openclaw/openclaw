#if os(iOS)
import SwiftUI
import UIKit

@MainActor
func chatTranscriptBottomOffset(_ scroll: UIScrollView) -> CGFloat {
    max(
        -scroll.adjustedContentInset.top,
        scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
}

/// Positions the live edge or requested turn in the layout transaction, without timers or queued correction.
struct ChatSynchronousFollowProbe: UIViewRepresentable {
    let scroll: ChatScrollFollowState
    var target: ScrollFollowTarget = .latest
    var anchor: UnitPoint = .bottom

    final class Probe: UIView {
        weak var scroller: UIScrollView?
        var observations: [NSKeyValueObservation] = []
        var followState: ChatScrollFollowState?
        var target: ScrollFollowTarget = .latest
        var anchor: UnitPoint = .bottom
        var reconciling = false
        var keyboardObservers: [NSObjectProtocol] = []

        override func didMoveToWindow() {
            super.didMoveToWindow()
            self.attach()
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            self.attach()
            self.reconcile()
        }

        func attach() {
            var parent = self.superview
            while let view = parent, !(view is UIScrollView) {
                parent = view.superview
            }
            guard let scroll = parent as? UIScrollView else { return }
            self.followState?.transcriptScroller = scroll
            guard scroll !== self.scroller else { return }
            self.observations.removeAll()
            self.scroller = scroll
            if self.keyboardObservers.isEmpty {
                for name in [
                    UIResponder.keyboardWillChangeFrameNotification,
                    UIResponder.keyboardDidChangeFrameNotification,
                ] {
                    self.keyboardObservers.append(NotificationCenter.default.addObserver(
                        forName: name,
                        object: nil,
                        queue: .main)
                    { [weak self] _ in
                        MainActor.assumeIsolated {
                            guard let self else { return }
                            self.reconcile()
                        }
                    })
                }
            }
            self.observations = [
                scroll.observe(\.contentSize, options: [.old, .new]) { [weak self] _, change in
                    guard change.oldValue != change.newValue else { return }
                    MainActor.assumeIsolated { self?.reconcile() }
                },
                scroll.observe(\.bounds, options: [.old, .new]) { [weak self] _, change in
                    // Origin-only changes are scrolling, not viewport geometry changes.
                    // Do not undo system navigation before SwiftUI reports its phase.
                    guard change.oldValue?.size != change.newValue?.size else { return }
                    MainActor.assumeIsolated { self?.reconcile() }
                },
                scroll.observe(\.contentInset, options: [.new]) { [weak self] _, _ in
                    MainActor.assumeIsolated { self?.reconcile() }
                },
            ]
            self.reconcile()
        }

        func reconcile() {
            guard !self.reconciling,
                  let state = self.followState,
                  state.followTarget == self.target, !state.isUserScrolling,
                  let scroll = self.scroller, scroll.window != nil,
                  !scroll.isTracking, !scroll.isDragging, !scroll.isDecelerating,
                  scroll.bounds.height > 0 else { return }
            let bottom = chatTranscriptBottomOffset(scroll)
            let y: CGFloat
            switch self.target {
            case .latest:
                y = bottom
            case .turn:
                guard ChatReaderRunAnchor.isPositioned(self, in: scroll) else { return }
                let frame = self.convert(self.bounds, to: scroll)
                let viewportHeight = scroll.bounds.height - scroll.adjustedContentInset.top -
                    scroll.adjustedContentInset.bottom
                let desired = frame.minY - (viewportHeight - frame.height) * self.anchor.y -
                    scroll.adjustedContentInset.top
                y = min(bottom, max(-scroll.adjustedContentInset.top, desired))
            }
            guard y.isFinite, abs(scroll.contentOffset.y - y) > 0.5 else { return }
            self.reconciling = true
            defer { self.reconciling = false }
            scroll.setContentOffset(CGPoint(x: scroll.contentOffset.x, y: y), animated: false)
        }
    }

    func makeUIView(context: Context) -> Probe {
        let probe = Probe()
        probe.followState = self.scroll
        probe.target = self.target
        probe.anchor = self.anchor
        probe.isUserInteractionEnabled = false
        return probe
    }

    func updateUIView(_ probe: Probe, context: Context) {
        probe.followState = self.scroll
        probe.target = self.target
        probe.anchor = self.anchor
        probe.attach()
        probe.reconcile()
    }

    static func dismantleUIView(_ probe: Probe, coordinator: ()) {
        for observer in probe.keyboardObservers {
            NotificationCenter.default.removeObserver(observer)
        }
        probe.keyboardObservers.removeAll()
        probe.observations.removeAll()
        probe.scroller = nil
        probe.followState = nil
    }
}

/// Only the locally admitted turn observes its follow target; message content stays independent.
struct ChatTurnFollowProbe: View {
    let scroll: ChatScrollFollowState
    let messageID: UUID?
    let anchor: UnitPoint

    var body: some View {
        if let messageID, self.scroll.followTarget == .turn(messageID) {
            ChatSynchronousFollowProbe(scroll: self.scroll, target: .turn(messageID), anchor: self.anchor)
        }
    }
}

extension ChatScrollFollowState {
    func jumpToAttachedTranscriptBottom(command: inout ChatScrollCommand) -> Bool {
        guard let scroller = self.transcriptScroller, scroller.window != nil else { return false }
        command.cancel()
        let offset = chatTranscriptBottomOffset(scroller)
        if offset.isFinite {
            scroller.setContentOffset(CGPoint(x: scroller.contentOffset.x, y: offset), animated: false)
        }
        return true
    }
}
#endif
