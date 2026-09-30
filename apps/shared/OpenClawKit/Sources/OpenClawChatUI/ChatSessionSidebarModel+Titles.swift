import Foundation

extension ChatSessionSidebarModel {
    public static func displayName(for session: OpenClawChatSessionEntry) -> String {
        ChatPayloadDecoding.trimmedNonEmptyString(session.label) ??
            ChatPayloadDecoding.trimmedNonEmptyString(session.displayName) ??
            ChatPayloadDecoding.trimmedNonEmptyString(session.autoLabel) ??
            self.displayName(forKey: session.key)
    }

    /// Compact "repo \u{2387} branch" line for worktree/work sessions; mirrors the
    /// web sidebar row subtitle (ui/src/lib/session-display.ts).
    public static func workSubtitle(for session: OpenClawChatSessionEntry) -> String? {
        let repoRoot = session.worktree?.repoRoot?.trimmingCharacters(in: .whitespacesAndNewlines)
        let branch = session.worktree?.branch?.trimmingCharacters(in: .whitespacesAndNewlines)
        let repoName = repoRoot?.split(separator: "/").last.map(String.init)
        let shortBranch = branch.map { $0.hasPrefix("openclaw/") ? String($0.dropFirst("openclaw/".count)) : $0 }
        guard let repoName, !repoName.isEmpty else { return nil }
        guard let shortBranch, !shortBranch.isEmpty else { return repoName }
        return "\(repoName) \u{2387} \(shortBranch)"
    }

    /// Session keys read as routing ids ("agent:main:main"); show the human
    /// part and keep the owning agent as a suffix only when it disambiguates.
    public static func displayName(forKey key: String) -> String {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = trimmed.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0] == "agent" else {
            return trimmed.isEmpty ? key : trimmed
        }
        let agent = String(parts[1])
        let session = String(parts[2])
        if session.isEmpty { return trimmed }
        return agent == "main" || agent.isEmpty ? session : "\(session) (\(agent))"
    }
}
