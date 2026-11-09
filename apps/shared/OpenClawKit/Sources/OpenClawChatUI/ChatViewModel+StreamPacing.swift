import Foundation

struct ChatStreamPacing {
    var interval = 0.15
    var pending: String?
    var scheduledID: UUID?
}

extension OpenClawChatViewModel {
    /// First output and clearing are immediate. Growing text waits for the default run-loop mode,
    /// which leaves touch tracking free to scroll rather than laying out every arriving word.
    func scheduleStreamingAssistantDisplay(_ text: String?) {
        guard let text, self.displayedStreamingAssistantTextUntracked != nil else {
            self.streamPacing.pending = nil
            self.streamPacing.scheduledID = nil
            self.applyStreamingAssistantDisplay(text)
            return
        }
        self.streamPacing.pending = text
        guard self.streamPacing.scheduledID == nil else { return }
        let scheduledID = UUID()
        self.streamPacing.scheduledID = scheduledID
        DispatchQueue.main.asyncAfter(deadline: .now() + self.streamPacing.interval) { [weak self] in
            RunLoop.main.perform(inModes: [.default]) { [weak self] in
                MainActor.assumeIsolated { self?.flushStreamingAssistantDisplay(scheduledID: scheduledID) }
            }
        }
    }

    func flushStreamingAssistantDisplay(scheduledID: UUID) {
        // A clear/session switch retires the callback, even if another run starts before it fires.
        guard self.streamPacing.scheduledID == scheduledID else { return }
        self.streamPacing.scheduledID = nil
        guard let pending = self.streamPacing.pending else { return }
        self.streamPacing.pending = nil
        self.applyStreamingAssistantDisplay(pending)
    }
}
