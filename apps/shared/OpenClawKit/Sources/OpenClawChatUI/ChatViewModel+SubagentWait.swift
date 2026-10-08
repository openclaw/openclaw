import Foundation

/// A chat whose own turn has ended while a helper session it started is still running.
struct ChatSubagentWait: Equatable {
    struct Child: Equatable {
        let key: String
        let name: String
    }

    /// Named only when exactly one helper is running, as in the Control UI.
    let child: Child?

    static func resolve(
        session: OpenClawChatSessionEntry?,
        sessions: [OpenClawChatSessionEntry],
        runActive: Bool) -> ChatSubagentWait?
    {
        guard let session, !runActive, session.archived != true,
              session.hasActiveSubagentRun == true, !Self.isRunning(session)
        else { return nil }
        let running = sessions.filter { row in
            guard row.key != session.key, row.archived != true, Self.isRunning(row) else { return false }
            if let parent = row.parentSessionKey ?? row.spawnedBy { return parent == session.key }
            return session.childSessions?.contains(row.key) == true
        }
        let child = running.count == 1 ? running.first : nil
        return ChatSubagentWait(child: child.map {
            Child(key: $0.key, name: ChatSessionSidebarModel.displayName(for: $0))
        })
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
