import Foundation
import SwiftUI

struct ChatMessageMetadata: Equatable {
    let timestamp: Double?
    let model: String?
}

extension ChatTranscriptRow {
    /// Assign before completed-work reordering so hidden work cannot join unrelated replies.
    static func footerMetadata(
        in rows: [Self],
        activeRunIDs: Set<String>,
        runWorking: Bool) -> [UUID: ChatMessageMetadata]
    {
        var result: [UUID: ChatMessageMetadata] = [:]
        var group: [OpenClawChatMessage] = []
        func flush(isTrailing: Bool = false) {
            defer { group.removeAll(keepingCapacity: true) }
            guard let first = group.first, let last = group.last else { return }
            let role = first.role.lowercased()
            guard role == "user" || role == "assistant" else { return }
            if role == "assistant" {
                guard first.workPhase != "commentary" || first.isForwardedTurnBoundary,
                      group.contains(where: { ChatMessageVisibleText.hasVisibleText(in: $0) ||
                              $0.content.contains { $0.isInlineAttachment || $0.preview?.inlineWidgetPath != nil }
                      }),
                      !group.contains(where: { $0.workRunID.map(activeRunIDs.contains) == true }),
                      !(isTrailing && runWorking)
                else { return }
            }
            let model = role == "assistant" ? group.reversed().compactMap {
                ChatPayloadDecoding.trimmedNonEmptyString($0.model)
            }.first { $0 != "gateway-injected" } : nil
            guard first.timestamp?.isFinite == true || model != nil else { return }
            result[last.id] = ChatMessageMetadata(timestamp: first.timestamp, model: model)
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
              first.footerSourceIdentity == next.footerSourceIdentity
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

    static func make(
        timestamp: Double?,
        now: Date = .now,
        locale: Locale = .current,
        timeZone: TimeZone = .current) -> Self?
    {
        // Gateway transcript timestamps are milliseconds, including cached history.
        guard let timestamp, timestamp.isFinite else { return nil }
        let date = Date(timeIntervalSince1970: timestamp / 1000)
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = timeZone
        formatter.setLocalizedDateFormatFromTemplate("EEEE MMMM d yyyy jmmss z")
        let exact = formatter.string(from: date)
        let age = now.timeIntervalSince(date)
        let label: String
        if age >= -120, age < 7 * 24 * 60 * 60 {
            let seconds = max(0, age).rounded()
            let minutes = (seconds / 60).rounded()
            let hours = (minutes / 60).rounded()
            if seconds < 60 {
                label = String(localized: "Just now", locale: locale)
            } else {
                let relative = RelativeDateTimeFormatter()
                relative.locale = locale
                relative.unitsStyle = .abbreviated
                relative.dateTimeStyle = .named
                let components = minutes < 60 ? DateComponents(minute: -Int(minutes)) :
                    hours < 48 ? DateComponents(hour: -Int(hours)) :
                    DateComponents(day: -Int((hours / 24).rounded()))
                label = relative.localizedString(from: components)
            }
        } else {
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = timeZone
            if calendar.component(.year, from: date) == calendar.component(.year, from: now) {
                formatter.setLocalizedDateFormatFromTemplate("MMM d")
            } else {
                formatter.setLocalizedDateFormatFromTemplate("MMM d yyyy")
            }
            label = formatter.string(from: date)
        }
        return Self(label: label, exact: exact)
    }
}

struct ChatMessageMetadataView: View {
    let metadata: ChatMessageMetadata
    @Environment(\.locale) private var locale
    @Environment(\.timeZone) private var timeZone

    var body: some View {
        HStack(spacing: 8) {
            if let time = ChatMessageTimestampPresentation.make(
                timestamp: self.metadata.timestamp, locale: self.locale, timeZone: self.timeZone)
            {
                Text(time.label)
                    .accessibilityLabel(time.exact)
                    #if os(macOS)
                    .help(time.exact)
                    #endif
            }
            if let model = self.metadata.model {
                Text(model.split(separator: "/").last.map(String.init) ?? model)
                    .truncationMode(.middle)
                    .accessibilityLabel(String(format: String(localized: "Model: %@"), model))
                    #if os(macOS)
                    .help(model)
                    #endif
            }
        }
        .font(OpenClawChatTypography.caption2)
        .monospacedDigit()
        .foregroundStyle(.secondary)
        .lineLimit(1)
        .accessibilityElement(children: .combine)
    }
}
