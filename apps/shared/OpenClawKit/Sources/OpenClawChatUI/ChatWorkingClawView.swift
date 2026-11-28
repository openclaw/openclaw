import Foundation
import SwiftUI

struct ChatWorkingClawPose {
    let bodyRotation: CGFloat
    let jawRotation: CGFloat

    static let resting = Self(bodyRotation: 0, jawRotation: -10)
    static let parked = Self(bodyRotation: 8, jawRotation: -4)
}

enum ChatWorkingClawMotion {
    /// Two snips, followed by a pause in the slightly open resting pose.
    private static let keyframes: [(progress: Double, body: CGFloat, jaw: CGFloat)] = [
        (0, 0, -10), (0.06, 0, -10), (0.10, -4, -26), (0.16, 3, 4),
        (0.22, -4, -24), (0.26, -4, -24), (0.32, 3, 4), (0.42, 0, -10),
    ]

    static func pose(elapsed: TimeInterval) -> ChatWorkingClawPose {
        let duration: TimeInterval = 2.4
        let progress = max(0, elapsed).truncatingRemainder(dividingBy: duration) / duration
        for (start, end) in zip(self.keyframes, self.keyframes.dropFirst()) where progress <= end.progress {
            let linear = (progress - start.progress) / (end.progress - start.progress)
            let eased = CGFloat(1 - pow(1 - linear, 3))
            return ChatWorkingClawPose(
                bodyRotation: start.body + (end.body - start.body) * eased,
                jawRotation: start.jaw + (end.jaw - start.jaw) * eased)
        }
        return .resting
    }
}

struct ChatWorkingClawView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var animationStartedAt = Date()

    var parked = false
    var tint: Color?

    let artworkSize: CGFloat

    init(parked: Bool = false, tint: Color? = nil, artworkSize: CGFloat = 18) {
        self.artworkSize = artworkSize
        self.parked = parked
        self.tint = tint
    }

    var body: some View {
        Group {
            if self.parked {
                self.artwork(pose: .parked)
            } else {
                TimelineView(.animation(
                    minimumInterval: 1 / 30,
                    paused: self.reduceMotion || self.scenePhase != .active))
                { context in
                    let pose = self.reduceMotion || self.scenePhase != .active
                        ? .resting
                        : ChatWorkingClawMotion.pose(
                            elapsed: context.date.timeIntervalSince(self.animationStartedAt))
                    self.artwork(pose: pose)
                }
            }
        }
        .frame(width: 28, height: 24)
        .accessibilityHidden(true)
        .onChange(of: self.scenePhase) { _, phase in
            if phase == .active {
                self.animationStartedAt = Date()
            }
        }
        .onChange(of: self.reduceMotion) { _, isReduced in
            if !isReduced {
                self.animationStartedAt = Date()
            }
        }
    }

    private func artwork(pose: ChatWorkingClawPose) -> some View {
        ZStack {
            ChatWorkingClawBodyShape()
                .fill(self.tint ?? OpenClawChatTheme.accent)
            ChatWorkingClawJawShape()
                .fill(self.tint ?? OpenClawChatTheme.accent)
                .rotationEffect(.degrees(pose.jawRotation), anchor: UnitPoint(x: 8.6 / 24, y: 11 / 24))
        }
        .frame(width: self.artworkSize, height: self.artworkSize)
        .rotationEffect(.degrees(pose.bodyRotation))
    }
}

private struct ChatWorkingClawBodyShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.addEllipse(in: CGRect(x: 3, y: 10, width: 10.4, height: 10.4))
        path.move(to: CGPoint(x: 10.2, y: 20))
        path.addCurve(
            to: CGPoint(x: 22.3, y: 13.2),
            control1: CGPoint(x: 14.5, y: 20.8),
            control2: CGPoint(x: 19, y: 18.6))
        path.addCurve(
            to: CGPoint(x: 18.4, y: 12.8),
            control1: CGPoint(x: 21, y: 12.9),
            control2: CGPoint(x: 19.7, y: 12.7))
        path.addLine(to: CGPoint(x: 17.5, y: 14.6))
        path.addLine(to: CGPoint(x: 16, y: 12.9))
        path.addLine(to: CGPoint(x: 14.3, y: 14.5))
        path.addLine(to: CGPoint(x: 13.5, y: 13))
        path.addLine(to: CGPoint(x: 11.5, y: 14.2))
        path.closeSubpath()
        return path.applying(chatWorkingClawTransform(for: rect))
    }
}

private struct ChatWorkingClawJawShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: 5.6, y: 12.2))
        path.addCurve(
            to: CGPoint(x: 15.6, y: 2),
            control1: CGPoint(x: 5.2, y: 5.6),
            control2: CGPoint(x: 10.4, y: 1.4))
        path.addCurve(
            to: CGPoint(x: 22.6, y: 8.2),
            control1: CGPoint(x: 19.4, y: 2.6),
            control2: CGPoint(x: 21.8, y: 5.2))
        path.addCurve(
            to: CGPoint(x: 17.6, y: 7.9),
            control1: CGPoint(x: 20.9, y: 7.7),
            control2: CGPoint(x: 19.2, y: 7.6))
        path.addLine(to: CGPoint(x: 16.9, y: 6.3))
        path.addLine(to: CGPoint(x: 15.2, y: 8.5))
        path.addCurve(
            to: CGPoint(x: 11.6, y: 12.4),
            control1: CGPoint(x: 13.6, y: 9.4),
            control2: CGPoint(x: 12.2, y: 10.9))
        path.addLine(to: CGPoint(x: 6.8, y: 13))
        path.closeSubpath()
        return path.applying(chatWorkingClawTransform(for: rect))
    }
}

private func chatWorkingClawTransform(for rect: CGRect) -> CGAffineTransform {
    let scale = min(rect.width, rect.height) / 24
    return CGAffineTransform(
        a: scale,
        b: 0,
        c: 0,
        d: scale,
        tx: rect.midX - 12 * scale,
        ty: rect.midY - 12 * scale)
}

#if !os(iOS)
struct ChatWorkingStatusText: View {
    @Environment(\.scenePhase) private var scenePhase

    let startedAt: Date
    let seed: String
    let outputTokens: Int?
    /// The startup phase replaces the rotating phrase, but keeps the elapsed clock.
    var status: String?

    var body: some View {
        if self.scenePhase == .active {
            TimelineView(.periodic(from: self.startedAt, by: 1)) { context in
                self.label(at: context.date)
            }
        } else {
            self.label(at: Date())
        }
    }

    private func label(at date: Date) -> some View {
        let elapsedMilliseconds = max(1000, Int(date.timeIntervalSince(self.startedAt) * 1000))
        let duration = ChatWorkingDurationFormatter.compact(milliseconds: Double(elapsedMilliseconds))
        return HStack(alignment: .firstTextBaseline, spacing: 5) {
            if let status {
                Text(verbatim: status)
                    .font(OpenClawChatTypography.caption)
            }
            Text(duration)
                .font(OpenClawChatTypography.captionSemiBold)
                .monospacedDigit()
            if let tokensText = ChatTurnRecapText.tokens(self.outputTokens) {
                Text("·")
                    .font(OpenClawChatTypography.caption)
                    .accessibilityHidden(true)
                Text(tokensText)
                    .font(OpenClawChatTypography.caption)
                    .monospacedDigit()
            }
            if self.status == nil, let index = ChatWorkingPhrase.index(
                seed: self.seed,
                elapsedMilliseconds: elapsedMilliseconds)
            {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Text("·")
                        .font(OpenClawChatTypography.caption)
                    Text(ChatWorkingPhrase.resources[index] + "…")
                        .font(OpenClawChatTypography.caption)
                }
                .accessibilityHidden(true)
            }
        }
    }
}

struct ChatTurnRecapRow: View {
    let recap: ChatTurnRecap

    var body: some View {
        HStack(spacing: 7) {
            ChatWorkingClawView(parked: true)
            Text(ChatTurnRecapText.done(runtimeMs: self.recap.runtimeMs))
                .font(OpenClawChatTypography.caption)
            if let tokensText = ChatTurnRecapText.tokens(self.recap.outputTokens) {
                Text("·")
                    .font(OpenClawChatTypography.caption)
                    .accessibilityHidden(true)
                Text(tokensText)
                    .font(OpenClawChatTypography.caption)
            }
        }
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .combine)
    }
}
#endif
