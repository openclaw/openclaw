import ActivityKit
import SwiftUI
import WidgetKit

struct OpenClawLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: OpenClawActivityAttributes.self) { context in
            LockScreenView(context: context)
        } dynamicIsland: { context in
            DynamicIsland {
                // MARK: Expanded
                DynamicIslandExpandedRegion(.leading) {
                    AgentLabel(agentName: context.attributes.agentName)
                }
                DynamicIslandExpandedRegion(.center) {
                    ExpandedStatusView(state: context.state)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    TrailingView(state: context.state)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    if let task = context.state.taskDescription {
                        Text(task)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 4)
                    }
                }
            } compactLeading: {
                // MARK: Compact Leading
                CompactLeadingView(state: context.state)
            } compactTrailing: {
                // MARK: Compact Trailing
                CompactTrailingView(state: context.state)
            } minimal: {
                // MARK: Minimal
                MinimalView(state: context.state)
            }
        }
    }
}

// MARK: - Lock Screen

private struct LockScreenView: View {
    let context: ActivityViewContext<OpenClawActivityAttributes>

    var body: some View {
        HStack(spacing: 10) {
            StatusDot(state: context.state)
                .frame(width: 10, height: 10)

            VStack(alignment: .leading, spacing: 2) {
                Text(context.attributes.agentName)
                    .font(.subheadline.bold())
                if let task = context.state.taskDescription {
                    Text(task)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                } else {
                    Text(context.state.statusText)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer()
            TrailingView(state: context.state)
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 4)
    }
}

// MARK: - Expanded views

private struct AgentLabel: View {
    let agentName: String

    var body: some View {
        Label(agentName, systemImage: "cpu")
            .font(.caption.bold())
            .foregroundStyle(.primary)
            .lineLimit(1)
    }
}

private struct ExpandedStatusView: View {
    let state: OpenClawActivityAttributes.ContentState

    var body: some View {
        Group {
            if state.isWorking {
                HStack(spacing: 6) {
                    ProgressView()
                        .controlSize(.mini)
                        .tint(.blue)
                    Text(state.taskDescription ?? "Working…")
                        .font(.subheadline.weight(.medium))
                        .lineLimit(1)
                }
            } else {
                Text(state.statusText)
                    .font(.subheadline)
                    .lineLimit(1)
            }
        }
        .transition(.opacity.combined(with: .scale(scale: 0.95)))
        .animation(.easeInOut(duration: 0.2), value: state.isWorking)
    }
}

// MARK: - Compact views

private struct CompactLeadingView: View {
    let state: OpenClawActivityAttributes.ContentState

    var body: some View {
        if state.isWorking {
            ProgressView()
                .controlSize(.mini)
                .tint(.blue)
        } else {
            StatusDot(state: state)
        }
    }
}

private struct CompactTrailingView: View {
    let state: OpenClawActivityAttributes.ContentState

    var body: some View {
        if state.isWorking, let task = state.taskDescription {
            Text(task)
                .font(.caption2.weight(.medium))
                .foregroundStyle(.primary)
                .lineLimit(1)
                .frame(maxWidth: 80)
        } else {
            Text(state.statusText)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .frame(maxWidth: 64)
        }
    }
}

private struct MinimalView: View {
    let state: OpenClawActivityAttributes.ContentState

    var body: some View {
        if state.isWorking {
            ProgressView()
                .controlSize(.mini)
                .tint(.blue)
        } else {
            StatusDot(state: state)
        }
    }
}

// MARK: - Shared subviews

private struct TrailingView: View {
    let state: OpenClawActivityAttributes.ContentState

    var body: some View {
        Group {
            if state.isConnecting {
                ProgressView().controlSize(.small)
            } else if state.isDisconnected {
                Image(systemName: "wifi.slash")
                    .foregroundStyle(.red)
            } else if state.isWorking {
                // Elapsed timer shows how long the agent has been working.
                Text(state.startedAt, style: .timer)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            } else if state.isIdle {
                Image(systemName: "antenna.radiowaves.left.and.right")
                    .foregroundStyle(.green)
            }
        }
    }
}

private struct StatusDot: View {
    let state: OpenClawActivityAttributes.ContentState

    var body: some View {
        Circle()
            .fill(dotColor)
            .frame(width: 6, height: 6)
    }

    private var dotColor: Color {
        if state.isDisconnected { return .red }
        if state.isConnecting { return .gray }
        if state.isWorking { return .blue }
        if state.isIdle { return .green }
        return .secondary
    }
}

// MARK: - Previews

#Preview("Compact — Idle", as: .dynamicIsland(.compact), using: OpenClawActivityAttributes.preview) {
    OpenClawLiveActivity()
} contentStates: {
    OpenClawActivityAttributes.ContentState.idle
}

#Preview("Compact — Working", as: .dynamicIsland(.compact), using: OpenClawActivityAttributes.preview) {
    OpenClawLiveActivity()
} contentStates: {
    OpenClawActivityAttributes.ContentState.working(task: "Building iOS app…")
}

#Preview("Expanded — Working", as: .dynamicIsland(.expanded), using: OpenClawActivityAttributes.preview) {
    OpenClawLiveActivity()
} contentStates: {
    OpenClawActivityAttributes.ContentState.working(task: "Running tests…")
}

#Preview("Lock Screen", as: .content, using: OpenClawActivityAttributes.preview) {
    OpenClawLiveActivity()
} contentStates: {
    OpenClawActivityAttributes.ContentState.working(task: "Capturing screenshot…")
    OpenClawActivityAttributes.ContentState.idle
    OpenClawActivityAttributes.ContentState.disconnected
}
