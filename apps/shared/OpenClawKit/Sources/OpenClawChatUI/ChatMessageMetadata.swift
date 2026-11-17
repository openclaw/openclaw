import Foundation
import SwiftUI
import Synchronization

struct ChatMessageMetadata: Equatable {
    let timestamp: Double?
    let model: String?
    /// The reply run's working time (web chat-message-group-frame.ts:122-125).
    var durationMilliseconds: Double?
}

extension ChatTranscriptRow {
    /// Assign before completed-work reordering so hidden work cannot join unrelated replies.
    static func footerMetadata(
        in rows: [Self],
        activeRunIDs: Set<String>,
        runWorking: Bool,
        runDurations: [String: Double] = [:],
        isMessageVisible: (OpenClawChatMessage) -> Bool) -> [UUID: ChatMessageMetadata]
    {
        var result: [UUID: ChatMessageMetadata] = [:]
        var group: [OpenClawChatMessage] = []
        func flush(isTrailing: Bool = false) {
            defer { group.removeAll(keepingCapacity: true) }
            guard let first = group.first, let last = group.last(where: isMessageVisible) else { return }
            let role = first.role.lowercased()
            guard role == "user" || role == "assistant" else { return }
            if role == "assistant" {
                guard first.workPhase != "commentary" || first.isForwardedTurnBoundary,
                      !last.stoppedForToolUse,
                      group.contains(where: { ChatMessageVisibleText.hasVisibleText(in: $0) ||
                              $0.content.contains { $0.isInlineAttachment || $0.preview?.inlineWidgetPath != nil }
                      }),
                      !group.contains(where: { $0.workRunID.map(activeRunIDs.contains) == true }),
                      !(isTrailing && runWorking && (activeRunIDs.isEmpty || first.workRunID == nil))
                else { return }
            }
            let model = role == "assistant" ? group.reversed().compactMap {
                ChatPayloadDecoding.trimmedNonEmptyString($0.model)
            }.first { $0 != "gateway-injected" } : nil
            // Forwarded replies belong to another session's run; their duration is not this turn's.
            let duration = role == "assistant" && !first.isForwardedTurnBoundary
                ? first.workRunID.flatMap { runDurations[$0] } : nil
            guard first.timestamp?.isFinite == true || model != nil || duration != nil else { return }
            result[last.id] = ChatMessageMetadata(
                timestamp: first.timestamp,
                model: model,
                durationMilliseconds: duration)
        }
        for row in rows {
            guard case let .message(message) = row else {
                flush()
                continue
            }
            if let first = group.first, !Self.sharesFooter(first, message) { flush() }
            group.append(message)
        }
        flush(isTrailing: true)
        return result
    }

    private static func sharesFooter(_ first: OpenClawChatMessage, _ next: OpenClawChatMessage) -> Bool {
        let role = first.role.lowercased()
        guard next.turnBoundary != true,
              role == next.role.lowercased(),
              first.footerSourceIdentity == next.footerSourceIdentity,
              first.isRealtimeVoiceTranscript == next.isRealtimeVoiceTranscript
        else { return false }
        if role == "user" {
            return (first.steerTargetRunID ?? first.workRunID) == (next.steerTargetRunID ?? next.workRunID)
        }
        func kind(_ message: OpenClawChatMessage) -> String {
            message.workPhase ?? (ChatMessageVisibleText.hasVisibleText(in: message) ||
                message.content.contains { $0.isInlineAttachment || $0.preview?.inlineWidgetPath != nil }
                ? "reply" : "activity")
        }
        return first.workRunID == next.workRunID && kind(first) == kind(next)
    }
}

struct ChatMessageTimestampPresentation: Equatable {
    let label: String
    let exact: String

    /// One locale/time-zone entry bounds retention. All formatter use stays under the lock.
    private static let formatters = Mutex(Formatters(locale: .current, timeZone: .current))

    private struct Formatters {
        let locale: Locale
        let timeZone: TimeZone
        let exact: DateFormatter
        let shortDate: DateFormatter
        let dateWithYear: DateFormatter
        let relative: RelativeDateTimeFormatter

        init(locale: Locale, timeZone: TimeZone) {
            self.locale = locale
            self.timeZone = timeZone
            func dateFormatter(_ template: String) -> DateFormatter {
                let formatter = DateFormatter()
                formatter.locale = locale
                formatter.timeZone = timeZone
                formatter.setLocalizedDateFormatFromTemplate(template)
                return formatter
            }
            self.exact = dateFormatter("EEEE MMMM d yyyy jmmss z")
            self.shortDate = dateFormatter("MMM d")
            self.dateWithYear = dateFormatter("MMM d yyyy")
            self.relative = RelativeDateTimeFormatter()
            self.relative.locale = locale
            self.relative.unitsStyle = .abbreviated
            self.relative.dateTimeStyle = .named
        }
    }

    static func make(
        timestamp: Double?,
        now: Date = .now,
        locale: Locale = .current,
        timeZone: TimeZone = .current) -> Self?
    {
        // Gateway transcript timestamps are milliseconds, including cached history.
        guard let timestamp, timestamp.isFinite else { return nil }
        let date = Date(timeIntervalSince1970: timestamp / 1000)
        return Self.formatters.withLock { formatters in
            if formatters.locale != locale || formatters.timeZone != timeZone {
                formatters = Formatters(locale: locale, timeZone: timeZone)
            }
            return Self.format(date: date, now: now, using: formatters)
        }
    }

    private static func format(date: Date, now: Date, using formatters: Formatters) -> Self {
        let exact = formatters.exact.string(from: date)
        let age = now.timeIntervalSince(date)
        let label: String
        if age >= -120, age < 7 * 24 * 60 * 60 {
            let seconds = max(0, age).rounded()
            let minutes = (seconds / 60).rounded()
            let hours = (minutes / 60).rounded()
            if seconds < 60 {
                label = String(localized: "Just now", locale: formatters.locale)
            } else {
                let components = minutes < 60 ? DateComponents(minute: -Int(minutes)) :
                    hours < 48 ? DateComponents(hour: -Int(hours)) :
                    DateComponents(day: -Int((hours / 24).rounded()))
                label = formatters.relative.localizedString(from: components)
            }
        } else {
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = formatters.timeZone
            if calendar.component(.year, from: date) == calendar.component(.year, from: now) {
                label = formatters.shortDate.string(from: date)
            } else {
                label = formatters.dateWithYear.string(from: date)
            }
        }
        return Self(label: label, exact: exact)
    }
}

/// Reply footer (web chat-message-timestamp-view.tsx:105-148,262-330): the relative time stays visible;
/// run duration, exact time, tokens, cost, context and model open from a tap on the time.
struct ChatMessageFooter: View {
    let metadata: ChatMessageMetadata?
    let usage: ChatMessageUsagePresentation?
    @Environment(\.locale) private var locale
    @Environment(\.timeZone) private var timeZone
    @State private var showsDetails = false

    var body: some View {
        let time = ChatMessageTimestampPresentation.make(
            timestamp: self.metadata?.timestamp, locale: self.locale, timeZone: self.timeZone)
        let duration = ChatCompletedWorkSummary.workedFor(self.metadata?.durationMilliseconds)
        Button {
            self.showsDetails = true
        } label: {
            Group {
                if let time {
                    Text(time.label)
                } else {
                    Image(systemName: "info.circle")
                }
            }
            .font(OpenClawChatTypography.caption2)
            .monospacedDigit()
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(time?.exact ?? String(localized: "Message details"))
        .accessibilityHint(String(localized: "Shows usage and model"))
        .accessibilityIdentifier("chat-message-footer")
        .popover(isPresented: self.$showsDetails) {
            ChatMessageFooterDetails(
                duration: duration,
                exactTime: time?.exact,
                usage: self.usage,
                model: self.metadata?.model)
                #if os(iOS)
                    .presentationCompactAdaptation(.popover)
                #endif
        }
    }
}

/// The tap-to-open context table (web chat-composer-context-panel.tsx:163-264 and
/// chat-context-breakdown.tsx): this reply's prompt budget with its bar and parts, then the
/// reply's work and cost, then the model and exact time.
private struct ChatMessageFooterDetails: View {
    let duration: String?
    let exactTime: String?
    let usage: ChatMessageUsagePresentation?
    let model: String?

    var body: some View {
        let rows = self.usage?.rows ?? []
        let hasUsage = self.usage?.context != nil || !rows.isEmpty
        let facts = self.replyFacts
        VStack(alignment: .leading, spacing: 12) {
            if let context = self.usage?.context {
                self.budget(context)
            }
            if !rows.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(rows, id: \.component) { row in
                        ChatContextUsageRow(row: row)
                    }
                }
            }
            if !facts.isEmpty {
                if hasUsage {
                    Divider()
                }
                self.replyRow(facts)
            }
            if self.model != nil || self.exactTime != nil {
                if hasUsage || !facts.isEmpty {
                    Divider()
                }
                VStack(alignment: .leading, spacing: 2) {
                    if let model {
                        // The full provider/model id: the footer never abbreviates it here.
                        Text(verbatim: model)
                            .accessibilityLabel(String(format: String(localized: "Model: %@"), model))
                    }
                    if let exactTime {
                        Text(exactTime)
                    }
                }
                .font(OpenClawChatTypography.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            }
        }
        .padding(16)
        .frame(width: 300, alignment: .leading)
    }

    private var replyFacts: [String] {
        [
            self.duration,
            self.usage?.cost.map {
                String(format: String(localized: "Cost %@"), ChatMessageUsagePresentation.cost($0))
            },
        ].compactMap(\.self)
    }

    private func budget(_ context: ChatMessageUsagePresentation.Context) -> some View {
        let pressure = self.usage?.pressure ?? .normal
        let detail = "\(ChatMessageUsagePresentation.tokens(context.promptTokens)) / "
            + "\(ChatMessageUsagePresentation.tokens(Double(context.windowTokens))) · "
        let label = Text("Prompt budget")
            .textCase(.uppercase)
            .tracking(0.4)
            .foregroundStyle(.secondary)
        let value = HStack(spacing: 0) {
            Text(verbatim: detail)
            Text(verbatim: "\(context.percent)%")
                .foregroundStyle(pressure.tint)
        }
        .monospacedDigit()
        return VStack(alignment: .leading, spacing: 8) {
            // Large text stacks the value under its label instead of truncating either.
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    label
                    Spacer(minLength: 0)
                    value
                }
                VStack(alignment: .leading, spacing: 2) {
                    label
                    value
                }
            }
            .font(OpenClawChatTypography.captionSemiBold)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(String(localized: "Prompt budget"))
            .accessibilityValue(Self.budgetAccessibilityValue(context, pressure: pressure))
            ChatContextBudgetBar(segments: context.segments)
        }
    }

    private func replyRow(_ facts: [String]) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text("This reply")
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
            Text(verbatim: facts.joined(separator: " · "))
                .monospacedDigit()
                .multilineTextAlignment(.trailing)
        }
        .font(OpenClawChatTypography.footnote)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(String(localized: "This reply"))
        .accessibilityValue(facts.joined(separator: ", "))
    }

    private static func budgetAccessibilityValue(
        _ context: ChatMessageUsagePresentation.Context,
        pressure: ChatMessageUsagePresentation.Pressure) -> String
    {
        let format = switch pressure {
        case .normal: String(localized: "%1$@ percent, %2$@ of %3$@ tokens")
        case .warning: String(localized: "Warning: %1$@ percent, %2$@ of %3$@ tokens")
        case .danger: String(localized: "Critical: %1$@ percent, %2$@ of %3$@ tokens")
        }
        return String(
            format: format,
            context.percent.formatted(),
            Int(min(context.promptTokens, Double(Int.max))).formatted(),
            context.windowTokens.formatted())
    }
}

/// One part of the reply's usage: a dot matching its bar segment, the label, the count.
private struct ChatContextUsageRow: View {
    let row: ChatMessageUsagePresentation.Row

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(self.row.component.tint)
                .frame(width: 7, height: 7)
            Text(self.row.component.title)
            Spacer(minLength: 12)
            Text(verbatim: ChatMessageUsagePresentation.tokens(Double(self.row.tokens)))
                .monospacedDigit()
                .foregroundStyle(.secondary)
        }
        .font(OpenClawChatTypography.footnote)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(self.row.component.title)
        .accessibilityValue(String(format: String(localized: "%@ tokens"), self.row.tokens.formatted()))
    }
}

/// A thin capsule over the context window, split into the prompt's parts.
private struct ChatContextBudgetBar: View {
    let segments: [ChatMessageUsagePresentation.Segment]

    var body: some View {
        GeometryReader { proxy in
            HStack(spacing: 1) {
                ForEach(self.segments.indices, id: \.self) { index in
                    let segment = self.segments[index]
                    let gap: CGFloat = index < self.segments.count - 1 ? 1 : 0
                    Rectangle()
                        .fill(segment.component?.tint ?? Color.secondary)
                        .frame(width: max(0, proxy.size.width * min(1, segment.fraction) - gap))
                }
            }
        }
        .frame(height: 4)
        .background(Color.secondary.opacity(0.2))
        .clipShape(Capsule())
        .accessibilityHidden(true)
    }
}

extension ChatMessageUsagePresentation.Component {
    fileprivate var title: String {
        switch self {
        case .cacheRead: String(localized: "Cache read")
        case .cacheWrite: String(localized: "Cache write")
        case .input: String(localized: "Input")
        case .output: String(localized: "Output")
        }
    }

    /// Semantic chart tints; output is not part of the prompt, so its dot stays neutral.
    fileprivate var tint: Color {
        switch self {
        case .cacheRead: .blue
        case .cacheWrite: .indigo
        case .input: .teal
        case .output: .secondary
        }
    }
}

extension ChatMessageUsagePresentation.Pressure {
    fileprivate var tint: Color {
        switch self {
        case .normal: .primary
        case .warning: OpenClawChatTheme.warning
        case .danger: OpenClawChatTheme.danger
        }
    }
}
