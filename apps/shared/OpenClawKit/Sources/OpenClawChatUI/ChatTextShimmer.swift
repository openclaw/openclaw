import SwiftUI

/// The Control UI's running-label sweep (`.text-shimmer` in ui/src/styles/base.css): the text rests in the
/// secondary ink and a soft band of the primary ink crosses it, left to right, once every 2.4 s (ease-in-out).
/// Only the glyphs change color. With Reduce Motion, or while nothing runs, the text is still, in the
/// primary ink, as the web leaves it.
struct ChatTextShimmer: ViewModifier {
    let active: Bool
    var base: Color = OpenClawChatTheme.muted
    var highlight: Color = OpenClawChatTheme.assistantText
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// --text-shimmer-duration and --text-shimmer-sweep-width: the band is 30 % of a gradient twice the text's
    /// width, so 0.6 of the text's width from edge to edge.
    static let period = 2.4
    static let bandWidth = 0.6

    func body(content: Content) -> some View {
        if self.active, !self.reduceMotion {
            TimelineView(.animation) { context in
                let center = Self.bandCenter(at: context.date.timeIntervalSinceReferenceDate)
                content.foregroundStyle(LinearGradient(
                    stops: [
                        .init(color: self.base, location: 0),
                        .init(color: self.highlight, location: 0.5),
                        .init(color: self.base, location: 1),
                    ],
                    startPoint: UnitPoint(x: center - Self.bandWidth / 2, y: 0.5),
                    endPoint: UnitPoint(x: center + Self.bandWidth / 2, y: 0.5)))
            }
        } else {
            content.foregroundStyle(self.highlight)
        }
    }

    /// Where the band's middle is, in units of the text's width. The web slides a 200 %-wide repeating gradient
    /// from 100 % to -100 %: the band crosses the text in the first half of each eased cycle, and the
    /// repeat behind it enters from the left at the end.
    static func bandCenter(at time: TimeInterval) -> Double {
        let phase = time.truncatingRemainder(dividingBy: self.period) / self.period
        let travel = 2 * UnitCurve.easeInOut.value(at: phase)
        return travel < 1 + self.bandWidth ? travel : travel - 2
    }
}

extension View {
    func chatTextShimmer(_ active: Bool) -> some View {
        self.modifier(ChatTextShimmer(active: active))
    }
}
