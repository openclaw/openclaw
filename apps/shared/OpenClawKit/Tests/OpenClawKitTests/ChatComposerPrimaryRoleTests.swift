import XCTest
@testable import OpenClawChatUI

final class ChatComposerPrimaryRoleTests: XCTestCase {
    private func role(
        draft: Bool = false,
        canSend: Bool = false,
        reply: Bool = false,
        sending: Bool = false,
        blocking: Bool = false,
        capture: Bool = false,
        talk: Bool = true) -> ChatComposerPrimaryRole
    {
        ChatComposerPrimaryRole.resolve(
            hasDraftToSend: draft,
            canSendDraft: canSend,
            hasStoppableReply: reply,
            isSending: sending,
            // A reply this client can stop is always blocking run activity.
            hasBlockingRunActivity: blocking || reply,
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
        // Sending a follow-up clears the field and Stop comes back.
        XCTAssertEqual(self.role(reply: true, sending: true), .stop)
    }

    func testOtherActivityNeverOffersTalk() {
        XCTAssertEqual(self.role(sending: true), .send)
        XCTAssertEqual(self.role(blocking: true), .send)
        XCTAssertEqual(self.role(capture: true), .send)
        XCTAssertEqual(self.role(draft: true, canSend: true, blocking: true), .send)
    }
}
