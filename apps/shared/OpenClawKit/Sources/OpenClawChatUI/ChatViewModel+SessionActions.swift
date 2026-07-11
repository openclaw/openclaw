import Foundation

extension OpenClawChatViewModel {
    public func refreshSessions(limit: Int? = nil) {
        let context = self.currentSessionSnapshot()
        Task { await self.fetchSessions(limit: limit, sessionSnapshot: context) }
    }

    public func startNewSession(worktree: Bool = false) async {
        await self.performStartNewSession(worktree: worktree)
    }

    public func requestSessionReset() {
        Task { await self.performReset() }
    }

    public func requestSessionCompact() {
        Task { await self.performCompact() }
    }

    public func setSessionPinned(_ sessionKey: String, pinned: Bool) {
        Task {
            do {
                try await self.transport.patchSession(
                    key: sessionKey,
                    label: nil,
                    category: nil,
                    pinned: pinned,
                    archived: nil,
                    unread: nil)
            } catch {
                self.errorText = error.localizedDescription
                return
            }
            await self.fetchSessions(limit: nil, sessionSnapshot: self.currentSessionSnapshot())
        }
    }
}
