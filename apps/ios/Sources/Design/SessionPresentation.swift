import Foundation
import OpenClawChatUI
import OpenClawKit
import SwiftUI

/// Session titles and row details shared by the sidebar, All Sessions and search. Nonisolated, as search ranks
/// titles off the main actor.
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
        self.title(session, includesRoutingFallback: true) ?? String(localized: "Untitled session")
    }

    static func title(_ session: OpenClawChatSessionEntry, includesRoutingFallback: Bool) -> String? {
        func titleFrom(_ value: String) -> String? {
            guard let placeholder = Self.redactedSessionTitle(for: value) else { return value }
            return includesRoutingFallback ? placeholder : nil
        }

        // web `resolveSessionDisplayName`: a key copied into a name field is not a name.
        if let label = session.label?.trimmedNonEmpty, label != session.key {
            return label
        }
        if let displayName = session.displayName?.trimmedNonEmpty,
           displayName != session.key,
           let title = titleFrom(displayName)
        {
            return title
        }
        if let autoLabel = session.autoLabel?.trimmedNonEmpty, includesRoutingFallback || autoLabel != session.key {
            return autoLabel
        }
        if let subject = session.subject?.trimmedNonEmpty,
           includesRoutingFallback || subject != session.key,
           let title = titleFrom(subject)
        {
            return title
        }
        // ui/src/lib/session-display.ts:308: the Gateway's title derived from the first message. The main
        // session keeps the name of its sidebar row instead.
        if let derivedTitle = session.derivedTitle?.trimmedNonEmpty, derivedTitle != session.key,
           !Self.isMainSessionKey(session.key)
        {
            return derivedTitle
        }
        // Keep key-based placeholders for lists; an unnamed chat header can show its agent instead.
        guard includesRoutingFallback else { return nil }
        return Self.redactedSessionTitle(for: session.key) ?? Self.namedKeyTail(session.key)
    }

    private static func isMainSessionKey(_ key: String) -> Bool {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed == "main" || trimmed.firstMatch(of: /^agent:[^:]+:main$/) != nil
    }

    /// ui/src/lib/session-display.ts:259-264: a named subsession (`agent:<id>:iv-lane-1`) reads as its tail.
    /// A tail holding an opaque id run (the web's `OPAQUE_ID_RUN_RE`, `:30-31`, which it shortens to `…abcd`)
    /// is not a name: the caller shows "Untitled session" rather than a fragment.
    static func namedKeyTail(_ key: String) -> String? {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let match = trimmed.firstMatch(of: /^agent:[^:]+:(?:explicit:)?(.+)$/) else { return nil }
        let tail = String(match.output.1)
        let opaqueRun = /(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{10,}/
        return tail.contains(opaqueRun) ? nil : tail
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
        // ui/src/lib/session-display.ts:195: the main session is named, never shown as its key; it carries
        // the sidebar row's name.
        if Self.isMainSessionKey(trimmed) {
            return String(localized: "Main chat")
        }
        // ui/src/lib/session-display.ts:255: a dashboard session's title is generated later; its uuid key
        // must not show meanwhile.
        if trimmed.range(of: #"^agent:[^:]+:dashboard:"#, options: .regularExpression) != nil {
            return String(localized: "New session")
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
