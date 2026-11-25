import Foundation
import OpenClawChatUI
import OpenClawKit
import SwiftUI

@MainActor
enum SessionPresentation {
    struct WorkItem {
        let icon: String
        let title: String
        let detail: String
        let state: String
        let color: Color
        let isUnread: Bool
        let isPinned: Bool
        var sessionColor: String?
    }

    static func workItem(
        for session: OpenClawChatSessionEntry,
        currentSessionKey: String,
        now: Date = .now) -> WorkItem
    {
        let isCurrent = session.key == currentSessionKey
        return WorkItem(
            icon: isCurrent ? "bubble.left.and.text.bubble.right.fill" : "bubble.left.fill",
            title: Self.title(session),
            detail: Self.detail(session, now: now),
            state: isCurrent ? "open" : "recent",
            color: isCurrent ? OpenClawBrand.accent : OpenClawBrand.ok,
            isUnread: session.unread == true,
            isPinned: session.pinned == true,
            sessionColor: session.color)
    }

    static func title(_ session: OpenClawChatSessionEntry) -> String {
        // web `resolveSessionDisplayName`: a key copied into a name field is not a name.
        if let label = session.label?.trimmedNonEmpty, label != session.key {
            return label
        }
        if let displayName = session.displayName?.trimmedNonEmpty, displayName != session.key {
            return Self.redactedSessionTitle(for: displayName) ?? displayName
        }
        if let autoLabel = session.autoLabel?.trimmedNonEmpty {
            return autoLabel
        }
        if let subject = session.subject?.trimmedNonEmpty {
            return Self.redactedSessionTitle(for: subject) ?? subject
        }
        // Generic key placeholders only after real topic names are absent.
        return self.redactedSessionTitle(for: session.key) ?? session.key
    }

    private static func redactedSessionTitle(for key: String) -> String? {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        let lowercased = trimmed.lowercased()
        guard !trimmed.isEmpty else { return nil }
        if lowercased.contains(":ios-") {
            return String(localized: "iOS chat")
        }
        if lowercased.hasPrefix("telegram:") {
            return String(localized: "Telegram chat")
        }
        if lowercased.hasPrefix("user:+") {
            return String(localized: "Direct chat")
        }
        if lowercased.hasPrefix("cron:") {
            return Self.humanizedSessionKey(String(trimmed.dropFirst("cron:".count)))
        }
        return nil
    }

    private static func humanizedSessionKey(_ key: String) -> String? {
        let words = key
            .replacingOccurrences(of: "_", with: "-")
            .split(separator: "-")
        guard !words.isEmpty else { return nil }

        return words
            .map { word in
                switch word.lowercased() {
                case "ai", "api", "ios", "qmd", "url":
                    word.uppercased()
                default:
                    word.prefix(1).uppercased() + String(word.dropFirst())
                }
            }
            .joined(separator: " ")
    }

    static func detail(_ session: OpenClawChatSessionEntry, now: Date = .now) -> String {
        if session.archived != true, session.isSnoozed(at: now), let milliseconds = session.snoozedUntil {
            let wake = OpenClawChatSessionSnooze.wakeDescription(
                Date(timeIntervalSince1970: milliseconds / 1000), now: now)
            return String(format: String(localized: "Wakes %@"), wake)
        }
        let activityAt = session.lastActivityAt ?? session.updatedAt
        if let activityAt, activityAt > 0 {
            return self.relativeTimeText(forMilliseconds: activityAt, relativeTo: now)
        }
        return session.key
    }

    static func relativeTimeText(
        forMilliseconds milliseconds: Double,
        relativeTo now: Date = .now) -> String
    {
        let date = Date(timeIntervalSince1970: milliseconds / 1000)
        guard now.timeIntervalSince(date) >= 60 else {
            return String(localized: "just now")
        }
        let formatter = RelativeDateTimeFormatter()
        formatter.dateTimeStyle = .numeric
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: now)
    }
}
