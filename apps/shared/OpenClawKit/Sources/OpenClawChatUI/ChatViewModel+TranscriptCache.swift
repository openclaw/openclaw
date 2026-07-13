import Foundation

// Offline transcript cache integration. The cache only pre-paints cold opens
// and covers offline browsing; live gateway responses are always the source
// of truth and replace cached rows wholesale.

extension OpenClawChatViewModel {
    struct SessionSnapshot {
        var key: String
        var generation: UInt64
    }

    func replaceMessages(_ messages: [OpenClawChatMessage]) {
        guard self.messages != messages else { return }
        self.messages = messages
        self.markTimelineChanged()
    }

    func persistTranscriptToCache(sessionKey: String, messages: [OpenClawChatMessage]) {
        guard let transcriptCache else { return }
        // Chain writes so an older snapshot can never land after a newer one;
        // detached tasks alone give no ordering guarantee across awaits.
        let previous = self.pendingCacheWriteTask
        self.pendingCacheWriteTask = Task.detached {
            await previous?.value
            await transcriptCache.storeTranscript(sessionKey: sessionKey, messages: messages)
        }
    }

    func persistSessionsToCache(_ sessions: [OpenClawChatSessionEntry]) {
        guard let transcriptCache else { return }
        let previous = self.pendingCacheWriteTask
        self.pendingCacheWriteTask = Task.detached {
            await previous?.value
            await transcriptCache.storeSessions(sessions)
        }
    }

    /// Cache-first cold open: pre-paint the cached transcript/session list
    /// while the live requests are in flight (or failing while offline).
    /// Live history replaces the painted rows wholesale via the normal
    /// applyHistoryPayload reconciliation path.
    func paintFromCacheIfNeeded(session: SessionSnapshot) {
        guard let transcriptCache else { return }
        if self.sessions.isEmpty, !self.hasAppliedLiveSessions {
            Task { [weak self] in
                let cached = await transcriptCache.loadSessions()
                guard let self, !cached.isEmpty else { return }
                // A live sessions response (even an empty one) is authoritative;
                // a slow cache read must never repaint over it.
                guard self.sessions.isEmpty, !self.hasAppliedLiveSessions else { return }
                self.sessions = cached
            }
        }
        guard self.messages.isEmpty, !self.hasAppliedLiveHistory else { return }
        Task { [weak self] in
            let cached = await transcriptCache.loadTranscript(sessionKey: session.key)
            guard let self, !cached.isEmpty else { return }
            guard self.isCurrentSession(session), !self.hasAppliedLiveHistory, self.messages.isEmpty else {
                return
            }
            self.replaceMessages(cached)
            self.isShowingCachedTranscript = true
        }
    }
}
