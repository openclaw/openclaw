import SwiftUI

/// A quarter arc turning once a second on a quiet track. The enclosing control names the activity.
public struct OpenClawRingSpinner: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let lineWidth: CGFloat

    public init(lineWidth: CGFloat) {
        self.lineWidth = lineWidth
    }

    public var body: some View {
        TimelineView(.animation(paused: self.reduceMotion)) { context in
            let turn = self.reduceMotion ? 0 : context.date.timeIntervalSinceReferenceDate
                .truncatingRemainder(dividingBy: 1)
            ZStack {
                Circle()
                    .stroke(lineWidth: self.lineWidth)
                    .opacity(0.3)
                Circle()
                    .trim(from: 0, to: 0.25)
                    .stroke(style: StrokeStyle(lineWidth: self.lineWidth, lineCap: .round))
                    .rotationEffect(.degrees(turn * 360))
            }
        }
        .accessibilityHidden(true)
    }
}
