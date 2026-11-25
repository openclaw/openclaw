import XCTest
@testable import OpenClawChatUI

final class ChatComposerPrimaryRoleTests: XCTestCase {
    private func role(
        draft: Bool = false,
        canSend: Bool = false,
        reply: Bool = false,
        sentJustNow: Bool = false,
        elsewhere: Bool = false,
        blocking: Bool = false,
        capture: Bool = false,
        talk: Bool = true) -> ChatComposerPrimaryRole
    {
        ChatComposerPrimaryRole.resolve(
            hasDraftToSend: draft,
            canSendDraft: canSend,
            hasOwnReply: reply || sentJustNow,
            hasReplyRunningElsewhere: elsewhere,
            // A reply this client can stop is always blocking run activity.
            hasBlockingRunActivity: blocking || reply || elsewhere,
            isLocalVoiceCaptureActive: capture,
            hasTalkControl: talk)
    }

    func testIdleComposerFollowsTheDraft() {
        XCTAssertEqual(self.role(), .talk)
        XCTAssertEqual(self.role(draft: true, canSend: true), .send)
        // A draft that cannot go out yet (offline, attachments still preparing) shows a disabled Send.
        XCTAssertEqual(self.role(draft: true), .send)
        // Without Talk there is nothing to start, so the empty field shows a disabled Send.
        XCTAssertEqual(self.role(talk: false), .send)
    }

    func testRunningReplyShowsStopUntilASendableDraftExists() {
        XCTAssertEqual(self.role(reply: true), .stop)
        XCTAssertEqual(self.role(draft: true, canSend: true, reply: true), .send)
        // Attachments and local session commands cannot be queued behind a reply, so Stop stays.
        XCTAssertEqual(self.role(draft: true, canSend: false, reply: true), .stop)
    }

    func testSendGoesStraightToStop() {
        // The tap marks the send: while the draft is still being saved (it cannot be sent again) and
        // after the field clears, the button is Stop until the reply registers.
        XCTAssertEqual(self.role(draft: true, sentJustNow: true), .stop)
        XCTAssertEqual(self.role(sentJustNow: true), .stop)
        XCTAssertEqual(self.role(sentJustNow: true, talk: false), .stop)
        XCTAssertEqual(self.role(reply: true, sentJustNow: true), .stop)
        // A new message typed in that window can be sent, like during a running reply.
        XCTAssertEqual(self.role(draft: true, canSend: true, sentJustNow: true), .send)
        // Without the mark (offline queue, local command, timeout) an empty field is Talk again.
        XCTAssertEqual(self.role(), .talk)
    }

    func testReplyThisClientCannotStopShowsStop() {
        XCTAssertEqual(self.role(elsewhere: true), .stop)
        XCTAssertEqual(self.role(draft: true, elsewhere: true), .send)
        // Dictation keeps its own stop control; the primary button does not add a second one.
        XCTAssertEqual(self.role(elsewhere: true, capture: true), .send)
    }

    func testOtherActivityNeverOffersTalk() {
        XCTAssertEqual(self.role(blocking: true), .send)
        XCTAssertEqual(self.role(capture: true), .send)
        XCTAssertEqual(self.role(draft: true, canSend: true, blocking: true), .send)
    }

    func testTalkReadsWhatItDoesAndOnlyLiveStatus() {
        let idle = ChatComposerPrimaryAccessibility.talk(isActive: false, isConnected: true, liveStatus: "")
        XCTAssertEqual(idle, .init(label: "Start voice conversation", value: "", hint: ""))
        let offline = ChatComposerPrimaryAccessibility.talk(isActive: false, isConnected: false, liveStatus: "")
        XCTAssertEqual(offline.value, "")
        XCTAssertEqual(offline.hint, "Voice conversations aren’t available while disconnected.")
        let active = ChatComposerPrimaryAccessibility.talk(isActive: true, isConnected: true, liveStatus: "Listening")
        XCTAssertEqual(active, .init(label: "End voice conversation", value: "Listening", hint: ""))
    }

    func testSendHintOnlyWhileAReplyKeepsRunning() {
        XCTAssertEqual(
            ChatComposerPrimaryAccessibility.send(isReplyRunning: false, sendKeepsReply: true),
            .init(label: "Send message", value: "", hint: ""))
        XCTAssertEqual(
            ChatComposerPrimaryAccessibility.send(isReplyRunning: true, sendKeepsReply: true).hint,
            "Sends without stopping the current reply. Clear your message to stop the reply.")
        // Interrupt mode stops the reply on send, so the hint would be false there.
        XCTAssertEqual(ChatComposerPrimaryAccessibility.send(isReplyRunning: true, sendKeepsReply: false).hint, "")
    }

    func testStopAlwaysSaysStopResponse() {
        XCTAssertEqual(
            ChatComposerPrimaryAccessibility.stop(canStop: true, isStopping: false),
            .init(label: "Stop response", value: "", hint: ""))
        XCTAssertEqual(
            ChatComposerPrimaryAccessibility.stop(canStop: false, isStopping: false),
            .init(label: "Stop response", value: "", hint: "Can’t stop this reply from this device right now."))
        XCTAssertEqual(
            ChatComposerPrimaryAccessibility.stop(canStop: true, isStopping: true),
            .init(label: "Stop response", value: "Stopping", hint: ""))
    }
}
