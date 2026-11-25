import XCTest
@testable import OpenClawChatUI

final class ChatComposerPrimaryRoleTests: XCTestCase {
    private func role(
        draft: Bool = false,
        canSend: Bool = false,
        reply: Bool = false,
        elsewhere: Bool = false,
        blocking: Bool = false,
        capture: Bool = false,
        talk: Bool = true) -> ChatComposerPrimaryRole
    {
        ChatComposerPrimaryRole.resolve(
            hasDraftToSend: draft,
            canSendDraft: canSend,
            hasStoppableReply: reply,
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

    func testSendInFlightFollowsTheField() {
        // The draft stays in the field until the local write finishes: Send, disabled (canSend is false).
        XCTAssertEqual(self.role(draft: true), .send)
        // Once the field clears the button is what an empty field shows: Talk, or Stop when the run registered.
        XCTAssertEqual(self.role(), .talk)
        XCTAssertEqual(self.role(reply: true), .stop)
        // Between the send and the run registering here, the Gateway already advertises the run.
        XCTAssertEqual(self.role(elsewhere: true), .stop)
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
}
