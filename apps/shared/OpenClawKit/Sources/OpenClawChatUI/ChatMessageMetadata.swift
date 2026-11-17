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

private struct ChatMessageFooterDetails: View {
    let duration: String?
    let exactTime: String?
    let usage: ChatMessageUsagePresentation?
    let model: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let duration {
                Text(duration)
                    .font(OpenClawChatTypography.footnote)
                    .foregroundStyle(.primary)
            }
            Group {
                if let exactTime {
                    Text(exactTime)
                }
                if let usage {
                    Text(usage.text)
                        .monospacedDigit()
                        .foregroundStyle(usage.pressure.tint)
                        .accessibilityLabel(String(localized: "Message usage"))
                        .accessibilityValue(usage.accessibilityValue)
                }
                if let model {
                    // The full provider/model id: the footer no longer abbreviates it.
                    Text(model)
                        .accessibilityLabel(String(format: String(localized: "Model: %@"), model))
                }
            }
            .font(OpenClawChatTypography.caption)
            .foregroundStyle(.secondary)
        }
        .fixedSize(horizontal: false, vertical: true)
        .textSelection(.enabled)
        .padding(14)
        .frame(minWidth: 200, maxWidth: 320, alignment: .leading)
    }
}

extension ChatMessageUsagePresentation.Pressure {
    fileprivate var tint: Color {
        switch self {
        case .normal: OpenClawChatTheme.muted
        case .warning: OpenClawChatTheme.warning
        case .danger: OpenClawChatTheme.danger
        }
    }
}
