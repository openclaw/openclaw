import ActivityKit
import SwiftUI
import WidgetKit

struct OpenClawLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: OpenClawActivityAttributes.self) { context in
            lockScreenBanner(context: context)
        } dynamicIsland: { context in
            DynamicIsland {
                // Expanded regions
                DynamicIslandExpandedRegion(.leading) {
                    statusDot(state: context.state)
                        .padding(.top, 6)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(alignment: .leading, spacing: 4) {
                        if let subject = context.state.subject {
                            Text(subject)
                                .font(.headline)
                                .lineLimit(1)
                        } else {
                            Text(context.attributes.agentName)
                                .font(.headline)
                        }
                        if context.state.isDisconnected {
                            Text("Disconnected")
                                .font(.subheadline)
                                .foregroundStyle(.red)
                        } else if context.state.isConnecting {
                            Text("Connecting...")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        } else if context.state.isIdle {
                            Text("Idle")
                                .font(.subheadline)
                                .foregroundStyle(.green)
                        } else if context.state.isFinished {
                            Text("Complete")
                                .font(.subheadline)
                                .foregroundStyle(.green)
                        } else if context.state.isError {
                            Text("Error")
                                .font(.subheadline)
                                .foregroundStyle(.red)
                        } else {
                            Text(context.state.statusText)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if context.state.isDisconnected {
                        Image(systemName: "wifi.slash")
                            .font(.caption)
                            .foregroundStyle(.red)
                    } else if context.state.isConnecting {
                        ProgressView()
                            .controlSize(.small)
                    } else if context.state.isIdle {
                        Image(systemName: "antenna.radiowaves.left.and.right")
                            .font(.caption)
                            .foregroundStyle(.green)
                    } else if context.state.isFinished || context.state.isError {
                        if let endedAt = context.state.endedAt {
                            let elapsed = endedAt.timeIntervalSince(context.state.startedAt)
                            Text(Duration.seconds(elapsed).formatted(.time(pattern: .minuteSecond)))
                                .font(.caption)
                                .monospacedDigit()
                                .foregroundStyle(.secondary)
                        }
                    } else {
                        Text(context.state.startedAt, style: .timer)
                            .font(.caption)
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    if let prev = context.state.previousToolLabel,
                       !context.state.isFinished, !context.state.isError, !context.state.isIdle, !context.state.isConnecting
                    {
                        HStack(spacing: 6) {
                            Image(systemName: "checkmark")
                                .font(.system(size: 8, weight: .bold))
                                .foregroundStyle(.green)
                            Text(prev)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                }
            } compactLeading: {
                statusDot(state: context.state)
            } compactTrailing: {
                if context.state.isDisconnected {
                    Image(systemName: "wifi.slash")
                        .font(.caption2)
                        .foregroundStyle(.red)
                } else if context.state.isConnecting {
                    Text("Connecting...")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .frame(maxWidth: 64)
                } else if context.state.isIdle {
                    Image(systemName: "antenna.radiowaves.left.and.right")
                        .font(.caption2)
                        .foregroundStyle(.green)
                } else if context.state.isFinished {
                    Text("Done")
                        .font(.caption2)
                        .foregroundStyle(.green)
                } else if context.state.isError {
                    Text("Error")
                        .font(.caption2)
                        .foregroundStyle(.red)
                } else if let toolLabel = context.state.currentToolLabel {
                    Text(toolLabel)
                        .font(.caption2)
                        .lineLimit(1)
                        .frame(maxWidth: 64)
                } else {
                    Text("Thinking...")
                        .font(.caption2)
                        .lineLimit(1)
                        .frame(maxWidth: 64)
                }
            } minimal: {
                statusDot(state: context.state)
            }
        }
    }

    // MARK: - Status Dot

    @ViewBuilder
    private func statusDot(state: OpenClawActivityAttributes.ContentState) -> some View {
        Circle()
            .fill(dotColor(state: state))
            .frame(width: 6, height: 6)
    }

    private func dotColor(state: OpenClawActivityAttributes.ContentState) -> Color {
        if state.isDisconnected { return .red }
        if state.isError { return .red }
        if state.isConnecting { return .gray }
        if state.isFinished { return .green }
        if state.isIdle { return .green }
        return .blue
    }

    // MARK: - Lock Screen Banner

    @ViewBuilder
    private func lockScreenBanner(context: ActivityViewContext<OpenClawActivityAttributes>) -> some View {
        let state = context.state

        VStack(alignment: .leading, spacing: 8) {
            // Header: subject or "OpenClaw" + agent name + timer/status icon
            HStack {
                HStack(spacing: 6) {
                    Circle()
                        .fill(dotColor(state: state))
                        .frame(width: 8, height: 8)
                    if state.isDisconnected {
                        Text("OpenClaw")
                            .font(.subheadline.bold())
                        Text("·")
                            .foregroundStyle(.secondary)
                        Text("Disconnected")
                            .font(.subheadline)
                            .foregroundStyle(.red)
                    } else if state.isConnecting {
                        Text("OpenClaw")
                            .font(.subheadline.bold())
                        Text("·")
                            .foregroundStyle(.secondary)
                        Text("Connecting...")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    } else if state.isIdle {
                        Text("OpenClaw")
                            .font(.subheadline.bold())
                        Text("·")
                            .foregroundStyle(.secondary)
                        Text("Idle")
                            .font(.subheadline)
                            .foregroundStyle(.green)
                    } else if let subject = state.subject, !state.isFinished, !state.isError {
                        Text(subject)
                            .font(.subheadline.bold())
                            .lineLimit(1)
                    } else {
                        Text("OpenClaw")
                            .font(.subheadline.bold())
                        Text("·")
                            .foregroundStyle(.secondary)
                        Text(context.attributes.agentName)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if state.isDisconnected {
                    Image(systemName: "wifi.slash")
                        .font(.caption)
                        .foregroundStyle(.red)
                } else if state.isConnecting {
                    ProgressView()
                        .controlSize(.small)
                } else if state.isIdle {
                    Image(systemName: "antenna.radiowaves.left.and.right")
                        .font(.caption)
                        .foregroundStyle(.green)
                } else if state.isFinished || state.isError, let endedAt = state.endedAt {
                    let elapsed = endedAt.timeIntervalSince(state.startedAt)
                    Text(Duration.seconds(elapsed).formatted(.time(pattern: .minuteSecond)))
                        .font(.caption)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                } else {
                    Text(state.startedAt, style: .timer)
                        .font(.caption)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
            }

            // Body: current status / tool label with icon / completion / idle / disconnected
            if state.isDisconnected {
                HStack(spacing: 6) {
                    Image(systemName: "wifi.slash")
                        .foregroundStyle(.red)
                    Text("Disconnected")
                        .font(.body)
                        .foregroundStyle(.red)
                }
            } else if state.isConnecting {
                HStack(spacing: 6) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Connecting...")
                        .font(.body)
                        .foregroundStyle(.secondary)
                }
            } else if state.isIdle {
                HStack(spacing: 6) {
                    Image(systemName: "antenna.radiowaves.left.and.right")
                        .foregroundStyle(.green)
                    Text("Idle")
                        .font(.body)
                        .foregroundStyle(.green)
                }
            } else if state.isFinished {
                HStack(spacing: 6) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                    Text(state.subject ?? "Complete")
                        .font(.body.bold())
                        .lineLimit(1)
                }
            } else if state.isError {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.circle.fill")
                        .foregroundStyle(.red)
                    Text("Error")
                        .font(.body.bold())
                }
            } else if let toolLabel = state.currentToolLabel {
                HStack(spacing: 6) {
                    Image(systemName: state.currentToolIcon ?? "gearshape")
                        .foregroundStyle(.blue)
                    Text(toolLabel)
                        .font(.body)
                        .lineLimit(1)
                }
            } else if let streaming = state.streamingText {
                HStack(spacing: 6) {
                    Image(systemName: "text.bubble")
                        .foregroundStyle(.blue)
                    Text(streaming)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            } else {
                HStack(spacing: 6) {
                    Image(systemName: "brain")
                        .foregroundStyle(.blue)
                    Text(state.statusText)
                        .font(.body)
                        .foregroundStyle(.secondary)
                }
            }

            // Footer: step counter + previous tool (only during active run)
            if !state.isIdle, !state.isConnecting {
                HStack {
                    if state.toolStepCount > 0 {
                        Text("Step \(state.toolStepCount)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if let prev = state.previousToolLabel, !state.isFinished {
                        Text("·")
                            .foregroundStyle(.tertiary)
                        HStack(spacing: 4) {
                            Image(systemName: "checkmark")
                                .font(.system(size: 8, weight: .bold))
                                .foregroundStyle(.green)
                            Text(prev)
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                        }
                    }
                    Spacer()
                }
            }
        }
        .padding(16)
        .activityBackgroundTint(.black.opacity(0.75))
    }
}

// MARK: - Previews

#if DEBUG
#Preview("Lock Screen - Idle", as: .content, using: OpenClawActivityAttributes.preview) {
    OpenClawLiveActivity()
} contentStates: {
    OpenClawActivityAttributes.ContentState.idle
    OpenClawActivityAttributes.ContentState.thinking
    OpenClawActivityAttributes.ContentState.toolRunning
    OpenClawActivityAttributes.ContentState.multiTool
    OpenClawActivityAttributes.ContentState.streaming
    OpenClawActivityAttributes.ContentState.finished
}

#Preview("Dynamic Island", as: .dynamicIsland(.expanded), using: OpenClawActivityAttributes.preview) {
    OpenClawLiveActivity()
} contentStates: {
    OpenClawActivityAttributes.ContentState.idle
    OpenClawActivityAttributes.ContentState.toolRunning
    OpenClawActivityAttributes.ContentState.multiTool
    OpenClawActivityAttributes.ContentState.finished
}
#endif
