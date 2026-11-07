import Foundation

/// A chat whose own turn has ended while a helper session it started is still running or paused.
struct ChatSubagentWait: Equatable {
    struct Child: Equatable {
        let key: String
        let name: String
        var paused = false
    }

    /// Name a single known unfinished or paused helper; the roster may still be partial.
    let child: Child?
    /// Helpers paused on sessions_yield keep the wait open without running.
    var pausedCount = 0

    static func resolve(
        session: OpenClawChatSessionEntry?,
        sessions: [OpenClawChatSessionEntry],
        runActive: Bool) -> ChatSubagentWait?
    {
        guard let session, !runActive, session.archived != true, !Self.isRunning(session) else { return nil }
        let children = sessions.filter { row in
            guard row.key != session.key, row.archived != true else { return false }
            if let parent = row.parentSessionKey ?? row.spawnedBy { return parent == session.key }
            return session.childSessions?.contains(row.key) == true
        }
        let running = children.filter { Self.isRunning($0) || $0.hasActiveSubagentRun == true }
        let paused = children.filter(Self.isPaused)
        // The parent's descendant flag counts running work only; a paused child keeps the wait.
        guard session.hasActiveSubagentRun == true || !paused.isEmpty else { return nil }
        let waiting = running + paused
        let child = waiting.count == 1 ? waiting.first : nil
        return ChatSubagentWait(
            child: child.map {
                Child(key: $0.key, name: ChatSessionSidebarModel.displayName(for: $0), paused: Self.isPaused($0))
            },
            pausedCount: paused.count)
    }

    /// Match ui/src/pages/chat/chat-subagent-wait.ts isPausedChild: a newer run reads as running.
    private static func isPaused(_ row: OpenClawChatSessionEntry) -> Bool {
        row.subagentRunState == "paused" && row.status != "queued" && !self.isRunning(row) &&
            row.hasActiveSubagentRun != true
    }

    /// Match src/shared/session-run-state.ts: terminal status wins over stale liveness.
    private static func isRunning(_ session: OpenClawChatSessionEntry) -> Bool {
        if let status = session.status, status != "queued", status != "running" { return false }
        return session.hasActiveRun ?? (session.status == "running" || session.status == "queued")
    }
}

extension OpenClawChatViewModel {
    var subagentWait: ChatSubagentWait? {
        ChatSubagentWait.resolve(
            session: self.currentSessionEntry(),
            sessions: self.sessions,
            runActive: self.hasBlockingRunActivity)
    }
}
