import Testing

struct WatchVoiceTurnTrackerTests {
    @Test func `waits for matching completed voice command`() {
        var tracker = WatchVoiceTurnTracker()
        tracker.begin(commandId: "voice-command")

        #expect(tracker.takeReply(completedCommandId: "other-command", text: "Other reply") == nil)
        #expect(tracker.isAwaitingReply)
        #expect(tracker.takeReply(completedCommandId: "voice-command", text: "New reply") == "New reply")
        #expect(!tracker.isAwaitingReply)
    }

    @Test func `ignores empty assistant messages until readable reply arrives`() {
        var tracker = WatchVoiceTurnTracker()
        tracker.begin(commandId: "voice-command")

        #expect(tracker.takeReply(completedCommandId: "voice-command", text: "  \n") == nil)
        #expect(tracker.isAwaitingReply)
        #expect(tracker.takeReply(completedCommandId: "voice-command", text: "  Ready.  ") == "Ready.")
    }

    @Test func `canceled turn does not speak later assistant message`() {
        var tracker = WatchVoiceTurnTracker()
        tracker.begin(commandId: "voice-command")
        tracker.cancel()

        #expect(tracker.takeReply(completedCommandId: "voice-command", text: "Later reply") == nil)
    }
}
