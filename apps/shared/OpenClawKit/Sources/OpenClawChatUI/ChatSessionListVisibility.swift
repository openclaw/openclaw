import Foundation

/// Display classification shared by native session browsing and sidebar options.
public enum OpenClawChatSessionListVisibility {
    static func isCronSessionDisplayKey(_ key: String) -> Bool {
        let key = key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return key.range(of: #"^(?:cron:|agent::*[^:]+:+cron:+[^:])"#, options: .regularExpression) != nil
    }

    static func isSystemCreatedSessionRow(_ session: OpenClawChatSessionEntry) -> Bool {
        let named = [session.label, session.displayName, session.subject]
            .contains { ChatPayloadDecoding.trimmedNonEmptyString($0) != nil }
        // A named heartbeat remains conversational even with system provenance.
        if session.classification == "heartbeat" { return !named }
        if session.createdActor?.type == "system" { return true }
        let internalSource = session.createdVia == "run" || session.createdVia == "internal"
        return internalSource && session.createdActor?.type != "human" && !named
    }

    public static func isAutomationSession(_ session: OpenClawChatSessionEntry) -> Bool {
        self.isCronSessionDisplayKey(session.key) || self.isSystemCreatedSessionRow(session)
    }
}
