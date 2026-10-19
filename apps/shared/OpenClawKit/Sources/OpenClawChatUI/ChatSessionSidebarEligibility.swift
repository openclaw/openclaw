#if os(macOS)
import Foundation

enum ChatSessionSidebarEligibility {
    static func canDelete(_ sessions: [OpenClawChatSessionEntry], mainSessionKey: String) -> Bool {
        // ui/src/lib/sessions/session-key.ts:400 keeps Delete all-idle or all-archived;
        // app-sidebar-session-navigation-logic.ts:205 resolves optional liveness before that check.
        sessions.allSatisfy(\.isArchived) || sessions.allSatisfy { session in
            (session.isArchived || !ChatSessionSidebarRowFacts.RuntimeSample(session).running) &&
                !self.isProtectedLifecycleRoot(session, mainSessionKey: mainSessionKey)
        }
    }

    static func canPin(_ session: OpenClawChatSessionEntry, isChild: Bool = false) -> Bool {
        let key = session.key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let parsed = self.agentKey(key)
        // ui/src/lib/sessions/session-key.ts:71 and session-menu-actions.ts:379:
        // root dashboard auto-parenting is pinnable; spawned and nested rows are not.
        guard !session.isArchived, !isChild, !key.hasPrefix("subagent:"),
              parsed?.rest.hasPrefix("subagent:") != true,
              ChatPayloadDecoding.trimmedNonEmptyString(session.spawnedBy) == nil
        else { return false }
        guard let parent = ChatPayloadDecoding.trimmedNonEmptyString(session.parentSessionKey) else { return true }
        guard let parsed else { return false }
        return parent == "agent:\(parsed.agent):main"
    }

    static func canArchive(_ session: OpenClawChatSessionEntry, mainSessionKey: String) -> Bool {
        if session.isArchived { return true }
        // ui/src/lib/sessions/session-key.ts:390: Gateway drains live runs;
        // protection belongs to main/global/unknown identity, not activity state.
        return ChatPayloadDecoding.trimmedNonEmptyString(session.sessionId) != nil &&
            !self.isProtectedLifecycleRoot(session, mainSessionKey: mainSessionKey)
    }

    private static func isProtectedLifecycleRoot(
        _ session: OpenClawChatSessionEntry, mainSessionKey: String) -> Bool
    {
        let key = session.key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let main = mainSessionKey.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let configuredMain = self.agentKey(main)?.rest ?? (main.isEmpty ? "main" : main)
        return session.kind == "global" || session.kind == "unknown" ||
            key == "global" || key == "unknown" || session.key == "main" ||
            self.agentKey(key)?.rest == configuredMain
    }

    private static func agentKey(_ key: String) -> (agent: String, rest: String)? {
        let parts = key.split(separator: ":", omittingEmptySubsequences: true)
        guard parts.count >= 3, parts[0] == "agent",
              let agent = ChatPayloadDecoding.trimmedNonEmptyString(String(parts[1]))
        else { return nil }
        return (agent, parts.dropFirst(2).joined(separator: ":"))
    }
}
#endif
