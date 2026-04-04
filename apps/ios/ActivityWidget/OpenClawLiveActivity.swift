import ActivityKit
import SwiftUI
import WidgetKit

struct OpenClawLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: OpenClawActivityAttributes.self) { context in
            lockScreenView(context: context)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    statusDot(state: context.state)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.state.statusText)
                        .font(.subheadline)
                        .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    trailingView(state: context.state)
                }
            } compactLeading: {
                statusDot(state: context.state)
            } compactTrailing: {
                Text(context.state.statusText)
                    .font(.caption2)
                    .lineLimit(1)
                    .frame(maxWidth: 64)
            } minimal: {
                statusDot(state: context.state)
            }
        }
    }

    @ViewBuilder
    private func lockScreenView(context: ActivityViewContext<OpenClawActivityAttributes>) -> some View {
        HStack(spacing: 8) {
            statusDot(state: context.state)
                .frame(width: 10, height: 10)
            VStack(alignment: .leading, spacing: 2) {
                Text("VeriClaw")
                    .font(.subheadline.bold())
                Text(context.state.statusText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            trailingView(state: context.state)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
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

    @ViewBuilder
    private func statusDot(state: OpenClawActivityAttributes.ContentState) -> some View {
        Circle()
            .fill(dotColor(state: state))
            .frame(width: 6, height: 6)
    }

    private func dotColor(state: OpenClawActivityAttributes.ContentState) -> Color {
        if state.isDisconnected { return .red }
        if state.isConnecting { return .gray }
        if state.isIdle { return .green }
        return .blue
    }
}
