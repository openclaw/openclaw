import SwiftUI

struct ChatSubagentActivityList: View {
    @Environment(\.openClawChatDesktopLayout) private var isDesktopLayout
    let activities: [ChatSubagentActivity]
    let hiddenWorkingCount: Int

    var body: some View {
        VStack(alignment: .leading, spacing: self.isDesktopLayout ? 6 : 2) {
            ForEach(self.activities) { activity in
                ChatSubagentActivityRow(activity: activity)
            }
            if self.hiddenWorkingCount > 0 {
                Text(verbatim: String(
                    format: String(localized: "+%1$lld more working"),
                    Int64(self.hiddenWorkingCount)))
                    .font(OpenClawChatTypography.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.leading, 35)
            }
        }
        .padding(4)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ChatSubagentActivityRow: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.openClawChatDesktopLayout) private var isDesktopLayout
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var colorSchemeContrast
    @State private var expanded = false

    let activity: ChatSubagentActivity

    private var detail: String? {
        if self.activity.status.isWorking {
            return self.activity.snippet
        }
        return self.activity.terminalSummary ?? self.activity.snippet
    }

    private var title: LocalizedStringResource {
        #if os(macOS)
        "Subagent"
        #else
        switch self.activity.status {
        case .queued:
            "Subagent queued"
        case .running:
            "Subagent working"
        case .completed:
            "Subagent finished"
        case .failed, .timedOut:
            "Subagent failed"
        case .cancelled:
            "Subagent cancelled"
        }
        #endif
    }

    private var titleColor: Color {
        #if os(macOS)
        self.isDesktopLayout
            ? OpenClawChatTheme.desktopText(in: self.colorScheme, contrast: self.colorSchemeContrast)
            : OpenClawChatTheme.assistantText
        #else
        switch self.activity.status {
        case .failed, .timedOut:
            OpenClawChatTheme.danger
        case .queued, .running, .completed, .cancelled:
            self.isDesktopLayout
                ? OpenClawChatTheme.desktopText(in: self.colorScheme, contrast: self.colorSchemeContrast)
                : OpenClawChatTheme.assistantText
        }
        #endif
    }

    #if !os(macOS)
    private var statusLabel: LocalizedStringResource {
        switch self.activity.status {
        case .queued: "Queued"
        case .running: "Working"
        case .completed: "Finished"
        case .failed, .timedOut: "Failed"
        case .cancelled: "Cancelled"
        }
    }
    #endif

    private var statusHelp: String {
        switch self.activity.status {
        case .queued: String(localized: "Queued — waiting to start.")
        case .running: String(localized: "Running — working on this task.")
        case .completed: String(localized: "Completed — finished successfully.")
        case .failed: String(localized: "Failed — the task ended with an error.")
        case .cancelled: String(localized: "Cancelled — stopped before completion.")
        case .timedOut: String(localized: "Timed out — reached its time limit.")
        }
    }

    private var rowHelp: String {
        self.activity.title.map { "\($0)\n\(self.statusHelp)" } ?? self.statusHelp
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if self.isDesktopLayout, self.detail != nil {
                Button {
                    withAnimation(self.reduceMotion ? nil : .easeOut(duration: 0.15)) {
                        self.expanded.toggle()
                    }
                } label: {
                    self.summary
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityValue([
                    self.statusHelp,
                    self.expanded ? String(localized: "Expanded") : String(localized: "Collapsed"),
                ].joined(separator: " "))
                .accessibilityIdentifier("chat-subagent-activity-\(self.activity.id)")
            } else {
                self.summary
            }
            if self.isDesktopLayout, self.expanded, let detail = self.detail {
                Text(verbatim: detail)
                    .font(OpenClawChatTypography.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .padding(.leading, 35)
            }
        }
        .modifier(ChatWorkCardStyle())
        .help(Text(self.rowHelp))
    }

    private var summary: some View {
        HStack(alignment: .center, spacing: 7) {
            #if os(macOS)
            ChatSubagentStatusClaw(activity: self.activity)
            #else
            if self.activity.status == .running {
                ChatWorkingClawView(seed: self.activity.id)
            } else {
                Image(systemName: self.statusSymbol)
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(
                        self.activity.status == .completed
                            ? OpenClawChatTheme.success
                            : self.activity.status == .cancelled || self.activity.status == .queued
                            ? Color.secondary
                            : OpenClawChatTheme.danger)
                    .frame(width: 28, height: 24)
                    .accessibilityHidden(true)
            }
            #endif

            (self.activity.title.map { Text(verbatim: $0) } ?? Text(self.title))
                .font(OpenClawChatTypography.footnoteSemiBold)
                .foregroundStyle(self.titleColor)
                .lineLimit(1)
                .help(Text(self.rowHelp))

            #if !os(macOS)
            if self.activity.title != nil {
                Text(self.statusLabel)
                    .font(OpenClawChatTypography.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize()
            }
            #endif

            if let detail = self.detail {
                Text(verbatim: detail)
                    .font(OpenClawChatTypography.mono(size: 12, relativeTo: .footnote))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .contentTransition(.opacity)
                    .animation(
                        self.reduceMotion ? nil : .easeOut(duration: 0.16),
                        value: detail)
            }

            if let stat = self.activity.diffStat {
                ChatDiffStatChips(stat: stat)
            }

            Spacer(minLength: 0)
            if self.isDesktopLayout, self.detail != nil {
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .rotationEffect(.degrees(self.expanded ? 90 : 0))
            }
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
        .accessibilityValue(self.statusHelp)
    }

    #if !os(macOS)
    private var statusSymbol: String {
        switch self.activity.status {
        case .queued: "hourglass"
        case .running: "circle.dotted"
        case .completed: "checkmark"
        case .cancelled: "stop.circle"
        case .failed, .timedOut: "exclamationmark.triangle"
        }
    }
    #endif
}

#if os(macOS)
private struct ChatSubagentStatusClaw: View {
    @State private var completionHighlighted = false
    let activity: ChatSubagentActivity

    var body: some View {
        ChatWorkingClawView(
            seed: self.activity.id,
            parked: self.activity.status != .running,
            tint: self.tint)
            .overlay(alignment: .topTrailing) {
                if self.activity.status == .failed || self.activity.status == .timedOut {
                    Image(systemName: self.activity.status == .failed ? "exclamationmark.triangle.fill" : "clock.fill")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundStyle(self.activity.status == .failed
                            ? OpenClawChatTheme.danger : OpenClawChatTheme.warning)
                        .padding(2)
                        .background(Circle().fill(OpenClawChatTheme.composerField))
                        .offset(x: 2, y: -1)
                }
            }
            .accessibilityHidden(true)
            .task(id: self.completionDeadline) {
                self.completionHighlighted = false
                guard let deadline = self.completionDeadline else { return }
                let remaining = deadline.timeIntervalSinceNow
                guard remaining > 0, remaining <= 3 else { return }
                self.completionHighlighted = true
                try? await Task.sleep(for: .seconds(remaining))
                guard !Task.isCancelled else { return }
                self.completionHighlighted = false
            }
    }

    private var completionDeadline: Date? {
        guard self.activity.status == .completed,
              let observedAt = self.activity.terminalObservedAt,
              observedAt.isFinite
        else { return nil }
        return Date(timeIntervalSince1970: observedAt / 1000).addingTimeInterval(3)
    }

    private var tint: Color? {
        switch self.activity.status {
        case .running: nil
        case .queued: Color.secondary.opacity(0.55)
        case .cancelled: Color.secondary.opacity(0.35)
        case .completed where self.completionHighlighted: OpenClawChatTheme.success
        case .completed, .failed, .timedOut: Color.secondary.opacity(0.8)
        }
    }
}
#endif
