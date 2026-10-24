import Foundation

/// Shared classification for automation and system session rows in ordinary
/// navigation lists.
///
/// Single Swift owner for the probes shared by the sidebar filters
/// (`ChatSessionSidebarModel.ViewOptions.includes`) and the iOS browsing
/// policy, mirroring `src/shared/session-list-visibility.ts`: cron keys own
/// automation even when system-created, a named heartbeat outranks system
/// provenance, and operator-named run/internal lanes stay conversational.
/// Display classification only; routing still validates canonical keys.
public enum OpenClawChatSessionListVisibility {
    /// Display keys historically ignore empty segments and accept whitespace
    /// owners; match the shared web classifier's cron-key shape directly.
    private static let cronDisplayKeyRegex: NSRegularExpression = {
        let pattern = "^(?:cron:|agent::*[^:]+:+cron:+[^:])"
        guard let regex = try? NSRegularExpression(pattern: pattern) else {
            preconditionFailure("Invalid cron display key regex: \(pattern)")
        }
        return regex
    }()

    /// - SeeAlso: `isCronSessionDisplayKey` in `src/shared/session-list-visibility.ts`.
    public static func isCronSessionDisplayKey(_ key: String) -> Bool {
        let normalized = key.trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        guard !normalized.isEmpty else { return false }
        let range = NSRange(normalized.startIndex..., in: normalized)
        return self.cronDisplayKeyRegex.firstMatch(in: normalized, range: range) != nil
    }

    /// Non-cron system provenance probe. A named heartbeat lane stays
    /// conversational (src/shared/session-list-visibility.ts:27) and
    /// operator-named or human-created run/internal rows remain chats.
    public static func isSystemCreatedSessionRow(_ entry: OpenClawChatSessionEntry) -> Bool {
        if entry.classification == "heartbeat" {
            return self.isBlank(entry.label) && self.isBlank(entry.displayName)
                && self.isBlank(entry.subject)
        }
        if entry.createdActor?.type == "system" { return true }
        guard entry.createdVia == "run" || entry.createdVia == "internal",
              entry.createdActor?.type != "human"
        else { return false }
        return self.isBlank(entry.label) && self.isBlank(entry.displayName)
            && self.isBlank(entry.subject)
    }

    /// Cron rows always belong to the automations scope; other system
    /// provenance follows the heartbeat-aware probe above.
    public static func isAutomationSession(_ entry: OpenClawChatSessionEntry) -> Bool {
        self.isCronSessionDisplayKey(entry.key) || self.isSystemCreatedSessionRow(entry)
    }

    /// Ordinary navigation lists keep the resolved selected session reachable
    /// even when it is automation-created, mirroring the Android navigation
    /// predicate.
    public static func isVisibleInNavigation(
        _ entry: OpenClawChatSessionEntry,
        selectedKey: String) -> Bool
    {
        entry.key == selectedKey
            || (entry.archived != true && !self.isAutomationSession(entry))
    }

    private static func isBlank(_ value: String?) -> Bool {
        guard let value else { return true }
        return value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
