#if os(iOS)
import SwiftUI
import UIKit

struct ChatMessageClock {
    let day: String?
    let time: String
    var spoken: String {
        [self.day, self.time].compactMap(\.self).joined(separator: ", ")
    }

    init?(timestamp: Double?, now: Date = .now, locale: Locale = .current, timeZone: TimeZone = .current) {
        guard let timestamp, timestamp.isFinite else { return nil }
        let date = Date(timeIntervalSince1970: timestamp / 1000)
        var calendar = locale.calendar
        calendar.timeZone = timeZone
        let style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: timeZone)
        self.time = date.formatted(style.hour().minute())
        self.day = calendar.isDate(date, inSameDayAs: now) ? nil : date.formatted(style.month(.abbreviated).day())
    }
}

/// Resolve the first text baseline in the cell itself, including Markdown and bubble padding.
/// UIKit's List recycles its cells. Only realized markers are read, once when the pan starts.
struct ChatClockAnchor: ViewModifier {
    let clock: ChatMessageClock?
    var isMediaOnly = false

    func body(content: Content) -> some View {
        content.overlay(alignment: Alignment(
            horizontal: .leading,
            vertical: self.isMediaOnly ? .center : .firstTextBaseline))
        {
            if let clock {
                Marker(clock: clock)
                    .frame(width: 1, height: 1)
                    .alignmentGuide(.firstTextBaseline) { _ in 0 }
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
    }

    fileprivate final class Baseline: UIView {
        var clock: ChatMessageClock?
    }

    private struct Marker: UIViewRepresentable {
        let clock: ChatMessageClock
        func makeUIView(context: Context) -> Baseline {
            Baseline()
        }

        func updateUIView(_ view: Baseline, context: Context) {
            view.clock = self.clock
        }
    }
}

struct ChatTranscriptTimeReveal: ViewModifier {
    let margin: CGFloat
    @ScaledMetric(relativeTo: .caption2) private var travel: CGFloat = 70
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var offset: CGFloat = 0
    @State private var stamps: [Stamp] = []

    fileprivate struct Stamp: Identifiable {
        let id: ObjectIdentifier
        let clock: ChatMessageClock
        let baseline: CGFloat
    }

    func body(content: Content) -> some View {
        content.overlay(alignment: .topTrailing) {
            ZStack(alignment: .topTrailing) {
                ForEach(self.stamps) { stamp in
                    VStack(alignment: .trailing, spacing: 0) {
                        if let day = stamp.clock.day { Text(verbatim: day) }
                        Text(verbatim: stamp.clock.time)
                    }
                    // A date belongs beside its own message, not in the preceding gap.
                    .alignmentGuide(.top) { dimensions in
                        if stamp.clock.day != nil { return dimensions[.firstTextBaseline] + dimensions.height / 4 }
                        return dimensions[.firstTextBaseline]
                    }
                    .offset(y: stamp.baseline)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                }
            }
            .font(OpenClawChatTypography.caption2)
            .monospacedDigit()
            .foregroundStyle(.secondary)
            .offset(x: max(self.travel, self.offset) - self.margin)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
        .offset(x: -self.offset)
        .gesture(ClockPan(
            began: { self.stamps = $0 },
            changed: { translation in
                let pull = max(0, translation)
                let extra = max(0, pull - self.travel)
                self.offset = min(pull, self.travel) + 9 * extra / (extra + 60)
            },
            ended: {
                withAnimation(self.reduceMotion ? nil : .interactiveSpring(duration: 0.32, extraBounce: 0)) {
                    self.offset = 0
                } completion: {
                    if self.offset == 0 { self.stamps.removeAll() }
                }
            }))
        // The thumb would slide sideways with the transcript; hide it until the chat settles back.
        .scrollIndicators(self.offset == 0 ? .automatic : .hidden, axes: .vertical)
    }

    private struct ClockPan: UIGestureRecognizerRepresentable {
        let began: ([Stamp]) -> Void
        let changed: (CGFloat) -> Void
        let ended: () -> Void

        func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator {
            Coordinator()
        }

        func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
            let pan = UIPanGestureRecognizer()
            pan.maximumNumberOfTouches = 1
            pan.delegate = context.coordinator
            return pan
        }

        func handleUIGestureRecognizerAction(_ pan: UIPanGestureRecognizer, context: Context) {
            switch pan.state {
            case .began:
                var stamps: [Stamp] = []
                if let list = context.coordinator.list, let window = list.window {
                    func collect(_ view: UIView) {
                        if let marker = view as? ChatClockAnchor.Baseline, let clock = marker.clock {
                            stamps.append(Stamp(
                                id: ObjectIdentifier(marker),
                                clock: clock,
                                baseline: context.converter.convert(globalPoint: marker.convert(.zero, to: window)).y))
                        } else {
                            view.subviews.forEach(collect)
                        }
                    }
                    list.visibleCells.forEach(collect)
                }
                self.began(stamps)
                self.changed(-pan.translation(in: nil).x)
            case .changed: self.changed(-pan.translation(in: nil).x)
            case .ended, .cancelled, .failed: self.ended()
            default: break
            }
        }

        final class Coordinator: NSObject, UIGestureRecognizerDelegate {
            weak var list: UICollectionView?

            func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
                var view = touch.view
                while let candidate = view {
                    if let text = candidate as? UITextView, text.isEditable || text.selectedRange.length > 0 {
                        return false
                    }
                    if let scroll = candidate as? UIScrollView, scroll.isScrollEnabled,
                       scroll.alwaysBounceHorizontal || scroll.contentSize.width > scroll.bounds.width + 1
                    { return false }
                    if let list = candidate as? UICollectionView {
                        self.list = list
                        return true
                    }
                    view = candidate.superview
                }
                return false
            }

            func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
                guard let pan = recognizer as? UIPanGestureRecognizer else { return false }
                let delta = pan.translation(in: nil)
                return -delta.x > abs(delta.y)
            }

            /// The drawer/back gestures own rightward drags. Only the transcript's vertical pan
            /// waits on this direction decision; nested scrollers and touch controls keep their gestures.
            func gestureRecognizer(
                _ recognizer: UIGestureRecognizer,
                shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool
            {
                other === self.list?.panGestureRecognizer
            }
        }
    }
}
#endif
