import ActivityKit
import Foundation
import SwiftUI
import WidgetKit

struct OpenClawRunLiveActivity: Widget {
    private typealias State = OpenClawRunActivityAttributes.ContentState
    private typealias Presentation = State.Presentation

    var body: some WidgetConfiguration {
        ActivityConfiguration(for: OpenClawRunActivityAttributes.self) { context in
            let presentation = context.state.presentation(isStale: context.isStale)
            HStack(spacing: 10) {
                self.statusIcon(presentation, size: 20)
                    .frame(width: 32, height: 32)
                VStack(alignment: .leading, spacing: 2) {
                    Text("OpenClaw")
                        .font(OpenClawActivityType.subheadBold)
                        .lineLimit(1)
                    self.statusText(presentation)
                        .font(OpenClawActivityType.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 8)
                self.factTime(context.state)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        } dynamicIsland: { context in
            let presentation = context.state.presentation(isStale: context.isStale)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    self.statusIcon(presentation, size: 20)
                        .frame(width: 32, height: 32)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("OPENCLAW")
                            .font(OpenClawActivityType.eyebrow)
                            .foregroundStyle(RunActivityStyle.coral)
                        self.statusText(presentation)
                            .font(OpenClawActivityType.subheadSemiBold)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    self.factTime(context.state)
                }
            } compactLeading: {
                Text("OC")
                    .font(OpenClawActivityType.caption.weight(.bold))
                    .foregroundStyle(RunActivityStyle.coral)
                    .frame(width: 22, height: 18)
            } compactTrailing: {
                self.statusIcon(presentation, size: 12)
                    .frame(width: 18, height: 18)
            } minimal: {
                self.statusIcon(presentation, size: 12)
                    .frame(width: 18, height: 18)
            }
            .keylineTint(self.tint(presentation))
        }
    }

    @ViewBuilder
    private func factTime(_ state: State) -> some View {
        if state.status.isTerminal {
            if let endedAt = state.endedAt {
                self.time(endedAt, label: Text("Ended"))
            }
        } else {
            self.time(state.observedAt, label: Text("Updated"))
        }
    }

    private func time(_ date: Date, label: Text) -> some View {
        VStack(alignment: .trailing, spacing: 2) {
            label
                .font(OpenClawActivityType.eyebrow)
                .foregroundStyle(.secondary)
            Text(date, style: .time)
                .font(OpenClawActivityType.caption)
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: 90, alignment: .trailing)
    }

    private func statusText(_ presentation: Presentation) -> Text {
        switch presentation {
        case .updateDelayed: Text("Update delayed")
        case .status(.running): Text("Running")
        case .status(.toolRunning): Text("Using a tool")
        case .status(.approvalNeeded): Text("Approval needed")
        case .status(.completed): Text("Completed")
        case .status(.failed): Text("Failed")
        case .status(.cancelled): Text("Cancelled")
        case .status(.timedOut): Text("Timed out")
        }
    }

    private func statusIcon(_ presentation: Presentation, size: CGFloat) -> some View {
        Image(systemName: self.symbol(presentation))
            .font(OpenClawActivityType.symbol(size: size, weight: .semibold))
            .foregroundStyle(self.tint(presentation))
            .accessibilityLabel(self.statusText(presentation))
    }

    private func symbol(_ presentation: Presentation) -> String {
        switch presentation {
        case .updateDelayed: "clock.arrow.circlepath"
        case .status(.running): "arrow.triangle.2.circlepath"
        case .status(.toolRunning): "hammer.fill"
        case .status(.approvalNeeded): "exclamationmark.triangle.fill"
        case .status(.completed): "checkmark.circle.fill"
        case .status(.failed): "xmark.octagon.fill"
        case .status(.cancelled): "stop.circle"
        case .status(.timedOut): "clock.badge.exclamationmark"
        }
    }

    private func tint(_ presentation: Presentation) -> Color {
        switch presentation {
        case .updateDelayed, .status(.approvalNeeded), .status(.timedOut): RunActivityStyle.warn
        case .status(.running), .status(.toolRunning): RunActivityStyle.sea
        case .status(.completed): RunActivityStyle.ok
        case .status(.failed): RunActivityStyle.danger
        case .status(.cancelled): .secondary
        }
    }
}

private enum RunActivityStyle {
    // Same widget-local Carapace tokens as the local tool/voice activity.
    static let coral = Color(red: 245 / 255.0, green: 101 / 255.0, blue: 74 / 255.0)
    static let sea = Color(red: 79 / 255.0, green: 200 / 255.0, blue: 174 / 255.0)
    static let ok = Color(red: 34 / 255.0, green: 197 / 255.0, blue: 94 / 255.0)
    static let danger = Color(red: 185 / 255.0, green: 28 / 255.0, blue: 28 / 255.0)
    static let warn = Color(red: 245 / 255.0, green: 158 / 255.0, blue: 11 / 255.0)
}
