import XCTest
@testable import OpenClawChatUI

@MainActor
final class ChatTalkPresentationTests: XCTestCase {
    private func control(
        _ phase: OpenClawChatTalkPhase?,
        muted: Bool = false,
        heard: String = "",
        listening: Bool = false,
        speaking: Bool = false,
        settings: Bool = true) -> OpenClawChatTalkControl
    {
        var openSettings: (@MainActor () -> Void)?
        if settings { openSettings = {} }
        return OpenClawChatTalkControl(
            isEnabled: true,
            isListening: listening,
            isSpeaking: speaking,
            isGatewayConnected: true,
            statusText: "Speaking (System)…",
            phase: phase,
            providerLabel: "OpenAI",
            isMicrophoneMuted: muted,
            partialTranscript: heard,
            openSettings: openSettings,
            toggle: { _ in })
    }

    private func presentation(_ control: OpenClawChatTalkControl) -> ChatTalkPresentation {
        ChatTalkPresentation(control: control)
    }

    func testEachStateSaysOnePhraseAndNeverTheOwnersRawStatus() {
        XCTAssertEqual(self.presentation(self.control(.connecting)).text, "Connecting…")
        XCTAssertEqual(self.presentation(self.control(.listening)).text, "Listening")
        XCTAssertEqual(self.presentation(self.control(.thinking)).text, "Waiting for a reply")
        XCTAssertEqual(self.presentation(self.control(.speaking)).text, "Speaking")
        XCTAssertEqual(self.presentation(self.control(.listening, muted: true)).text, "Muted")
        XCTAssertEqual(self.presentation(self.control(.issue(.offline))).text, "Offline")
        XCTAssertEqual(self.presentation(self.control(.issue(.replyFailed))).text, "Couldn’t get a reply")
    }

    func testMarksFollowTheState() {
        XCTAssertEqual(self.presentation(self.control(.connecting)).mark, .connecting)
        XCTAssertEqual(self.presentation(self.control(.listening)).mark, .meter(listening: true))
        XCTAssertEqual(self.presentation(self.control(.speaking)).mark, .meter(listening: false))
        XCTAssertEqual(self.presentation(self.control(.thinking)).mark, .thinking)
        XCTAssertEqual(self.presentation(self.control(.listening, muted: true)).mark, .muted)
        XCTAssertEqual(self.presentation(self.control(.issue(.startFailed))).mark, .issue)
    }

    func testHeardWordsShowWhileListeningButTheStatusStaysListening() {
        let hearing = self.presentation(self.control(.listening, heard: "  What’s on my calendar "))
        XCTAssertEqual(hearing.text, "What’s on my calendar")
        XCTAssertEqual(hearing.status, "Listening")
        XCTAssertTrue(hearing.showsHeardWords)
        // Muted: nothing more is heard, so the row says Muted.
        XCTAssertEqual(self.presentation(self.control(.listening, muted: true, heard: "What’s")).text, "Muted")
        // Heard words never stand in for another state.
        XCTAssertEqual(self.presentation(self.control(.thinking, heard: "What’s")).text, "Waiting for a reply")
    }

    func testMuteDoesNotHideWhatTheAgentIsDoing() {
        XCTAssertEqual(self.presentation(self.control(.speaking, muted: true)).text, "Speaking")
        XCTAssertEqual(self.presentation(self.control(.thinking, muted: true)).text, "Waiting for a reply")
    }

    func testOnlyAccessIssuesOfferSettings() {
        XCTAssertTrue(self.presentation(self.control(.issue(.microphoneAccess))).offersSettings)
        XCTAssertTrue(self.presentation(self.control(.issue(.speechRecognitionAccess))).offersSettings)
        XCTAssertFalse(self.presentation(self.control(.issue(.offline))).offersSettings)
        XCTAssertFalse(self.presentation(self.control(.issue(.microphoneAccess), settings: false)).offersSettings)
    }

    func testHostsWithoutAPhaseDeriveItFromListeningAndSpeaking() {
        XCTAssertEqual(self.presentation(self.control(nil, listening: true)).text, "Listening")
        XCTAssertEqual(self.presentation(self.control(nil, speaking: true)).text, "Speaking")
        XCTAssertEqual(self.presentation(self.control(nil)).text, "Waiting for a reply")
    }
}
