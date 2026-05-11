import ActivityKit
import SwiftUI
import WidgetKit

struct OpenClawLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: OpenClawActivityAttributes.self) { context in
            self.lockScreenView(context: context)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    self.liveOrb(state: context.state, size: 34)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(spacing: 2) {
                        Text("Thomas Control Room")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.secondary)
                        Text(context.state.statusText)
                            .font(.subheadline.weight(.bold))
                            .lineLimit(1)
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    self.trailingView(state: context.state)
                }
            } compactLeading: {
                self.statusDot(state: context.state)
            } compactTrailing: {
                Text(context.state.statusText)
                    .font(.caption2)
                    .lineLimit(1)
                    .frame(maxWidth: 64)
            } minimal: {
                self.statusDot(state: context.state)
            }
        }
    }

    private func lockScreenView(context: ActivityViewContext<OpenClawActivityAttributes>) -> some View {
        HStack(spacing: 12) {
            self.liveOrb(state: context.state, size: 42)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text("Thomas Control Room")
                        .font(.subheadline.weight(.black))
                    Text(self.stateLabel(state: context.state))
                        .font(.caption2.weight(.black))
                        .foregroundStyle(.black.opacity(0.72))
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(self.dotColor(state: context.state), in: Capsule())
                }
                Text(context.state.statusText)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            self.trailingView(state: context.state)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .activityBackgroundTint(Color(red: 0.05, green: 0.07, blue: 0.13))
        .activitySystemActionForegroundColor(self.dotColor(state: context.state))
    }

    @ViewBuilder
    private func trailingView(state: OpenClawActivityAttributes.ContentState) -> some View {
        if state.isConnecting {
            ProgressView().controlSize(.small)
        } else if state.isDisconnected {
            Image(systemName: "wifi.slash")
                .foregroundStyle(.red)
        } else if state.isIdle {
            Image(systemName: "antenna.radiowaves.left.and.right")
                .foregroundStyle(.green)
        } else {
            Text(state.startedAt, style: .timer)
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(.secondary)
        }
    }

    private func liveOrb(state: OpenClawActivityAttributes.ContentState, size: CGFloat) -> some View {
        ZStack {
            Circle()
                .fill(
                    AngularGradient(
                        colors: [.orange, self.dotColor(state: state), .cyan, .orange],
                        center: .center))
            Circle()
                .fill(Color(red: 0.96, green: 0.55, blue: 0.27))
                .padding(size * 0.18)
            Image(systemName: self.iconName(state: state))
                .font(.system(size: size * 0.28, weight: .black))
                .foregroundStyle(.black.opacity(0.7))
        }
        .frame(width: size, height: size)
        .shadow(color: self.dotColor(state: state).opacity(0.4), radius: 10, x: 0, y: 4)
    }

    private func iconName(state: OpenClawActivityAttributes.ContentState) -> String {
        if state.isDisconnected { return "wifi.slash" }
        if state.isConnecting { return "arrow.triangle.2.circlepath" }
        if state.isIdle { return "antenna.radiowaves.left.and.right" }
        return "sparkles"
    }

    private func stateLabel(state: OpenClawActivityAttributes.ContentState) -> String {
        if state.isDisconnected { return "OFF" }
        if state.isConnecting { return "SYNC" }
        if state.isIdle { return "IDLE" }
        return "LIVE"
    }

    private func statusDot(state: OpenClawActivityAttributes.ContentState) -> some View {
        Circle()
            .fill(self.dotColor(state: state))
            .frame(width: 6, height: 6)
    }

    private func dotColor(state: OpenClawActivityAttributes.ContentState) -> Color {
        if state.isDisconnected { return .red }
        if state.isConnecting { return .gray }
        if state.isIdle { return .green }
        return .blue
    }
}
