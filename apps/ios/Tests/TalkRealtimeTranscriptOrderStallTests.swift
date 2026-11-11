import Foundation
import OpenClawKit
@preconcurrency import WebRTC
import XCTest
@testable import OpenClaw

/// Ordering must never cost a transcript: a turn that never finishes gives up its place.
@MainActor
final class TalkRealtimeTranscriptOrderStallTests: XCTestCase {
    private func event(_ json: String) throws -> TalkRealtimeServerEvent {
        try JSONDecoder().decode(TalkRealtimeServerEvent.self, from: Data(json.utf8))
    }

    private func texts(_ entries: [TalkRealtimeTranscriptOrder.Entry]) -> [String] {
        entries.map(\.text)
    }

    func testInterruptedReplyWithoutTranscriptReleasesTheNextTurn() throws {
        var order = TalkRealtimeTranscriptOrder()
        _ = try order.observe(event(#"{"type":"conversation.item.added","item":{"id":"a1","type":"message","role":"assistant"}}"#))
        _ = try order.observe(event(#"{"type":"input_audio_buffer.committed","item_id":"u2"}"#))
        XCTAssertEqual(order.settle(role: .user, text: "Stop.", itemId: "u2"), [])
        XCTAssertTrue(order.isHolding)
        let released = try order.observe(event(
            #"{"type":"response.output_item.done","item":{"id":"a1","type":"message","role":"assistant"}}"#))
        XCTAssertEqual(self.texts(released), ["Stop."])
        XCTAssertFalse(order.isHolding)
    }

    func testFailedUserTranscriptionReleasesTheReply() throws {
        var order = TalkRealtimeTranscriptOrder()
        _ = try order.observe(event(#"{"type":"input_audio_buffer.committed","item_id":"u1"}"#))
        _ = try order.observe(event(#"{"type":"conversation.item.added","item":{"id":"a1","type":"message","role":"assistant"}}"#))
        XCTAssertEqual(order.settle(role: .assistant, text: "Hi.", itemId: "a1"), [])
        let released = try order.observe(event(
            #"{"type":"conversation.item.input_audio_transcription.failed","item_id":"u1"}"#))
        XCTAssertEqual(self.texts(released), ["Hi."])
    }

    func testReleasingAStalledTurnKeepsItsLateFinalInArrivalOrder() throws {
        var order = TalkRealtimeTranscriptOrder()
        _ = try order.observe(event(#"{"type":"input_audio_buffer.committed","item_id":"u1"}"#))
        _ = try order.observe(event(#"{"type":"conversation.item.added","item":{"id":"a1","type":"message","role":"assistant"}}"#))
        _ = try order.observe(event(#"{"type":"input_audio_buffer.committed","item_id":"u2"}"#))
        XCTAssertEqual(order.settle(role: .assistant, text: "Reply.", itemId: "a1"), [])
        XCTAssertEqual(self.texts(order.releaseHeld()), ["Reply."])
        XCTAssertFalse(order.isHolding, "u2 has not started speaking text yet; nothing waits behind it")
        XCTAssertEqual(self.texts(order.settle(role: .user, text: "Late.", itemId: "u1")), ["Late."])
        XCTAssertEqual(self.texts(order.settle(role: .user, text: "Next.", itemId: "u2")), ["Next."])
    }

    func testReplyTextAfterAnEmptyItemCompletionIsKept() throws {
        var order = TalkRealtimeTranscriptOrder()
        _ = try order.observe(event(#"{"type":"input_audio_buffer.committed","item_id":"u1"}"#))
        _ = try order.observe(event(#"{"type":"conversation.item.added","item":{"id":"a1","type":"message","role":"assistant"}}"#))
        XCTAssertEqual(try order.observe(event(
            #"{"type":"response.output_item.done","item":{"id":"a1","type":"message","role":"assistant"}}"#)), [])
        XCTAssertEqual(order.settle(role: .assistant, text: "Reply.", itemId: "a1"), [])
        XCTAssertEqual(self.texts(order.settle(role: .user, text: "Question.", itemId: "u1")), ["Question.", "Reply."])
    }

    func testInterruptedFramelessReplyDoesNotLendItsPlaceToTheNextReply() throws {
        var order = TalkRealtimeTranscriptOrder()
        // Reply 1 is cut off: it streams text but never sends turn.done.
        _ = try order.observe(event(#"{"type":"output_transcript.added","item":{"text":"Let me"}}"#))
        _ = try order.observe(event(#"{"type":"input_transcript.added","item":{"text":"Stop"}}"#))
        XCTAssertEqual(order.settle(role: .user, text: "Stop.", itemId: nil), [])
        let released = try order.observe(event(#"{"type":"output_transcript.added","item":{"text":"Okay"}}"#))
        XCTAssertEqual(self.texts(released), ["Stop."])
        XCTAssertEqual(self.texts(order.settle(role: .assistant, text: "Okay.", itemId: nil)), ["Okay."])
        XCTAssertFalse(order.isHolding)
    }

    func testEachStallReportsItsOwnBlockingTurn() throws {
        var order = TalkRealtimeTranscriptOrder()
        _ = try order.observe(event(#"{"type":"input_audio_buffer.committed","item_id":"u1"}"#))
        _ = try order.observe(event(#"{"type":"conversation.item.added","item":{"id":"a1","type":"message","role":"assistant"}}"#))
        _ = try order.observe(event(#"{"type":"input_audio_buffer.committed","item_id":"u2"}"#))
        _ = order.settle(role: .assistant, text: "A.", itemId: "a1")
        let first = try XCTUnwrap(order.holdingTurn)
        XCTAssertEqual(self.texts(order.settle(role: .user, text: "U1.", itemId: "u1")), ["U1.", "A."])
        XCTAssertNil(order.holdingTurn)
        _ = try order.observe(event(#"{"type":"conversation.item.added","item":{"id":"a2","type":"message","role":"assistant"}}"#))
        _ = order.settle(role: .assistant, text: "A2.", itemId: "a2")
        let second = try XCTUnwrap(order.holdingTurn)
        XCTAssertNotEqual(first, second)
    }

    func testUnreservedItemFinalKeepsArrivalOrder() {
        var order = TalkRealtimeTranscriptOrder()
        XCTAssertEqual(self.texts(order.settle(role: .assistant, text: "Unknown item.", itemId: "x")), ["Unknown item."])
    }

    func testUnexpectedContentShapeStillDecodesTheEvent() throws {
        let decoded = try event(#"{"type":"conversation.item.added","item":{"id":"a1","type":"message","role":7,"content":"text"}}"#)
        XCTAssertEqual(decoded.item?.id, "a1")
        XCTAssertNil(decoded.item?.role)
        XCTAssertNil(decoded.item?.content)
    }

    func testStalledUserTranscriptionDoesNotWithholdTheReply() async throws {
        let saved = try await TalkRealtimeTranscriptOrderTests.persistedTranscripts(
            after: [
                #"{"type":"input_audio_buffer.committed","item_id":"user-1"}"#,
                #"{"type":"conversation.item.added","item":{"id":"reply-1","type":"message","role":"assistant"}}"#,
                #"{"type":"response.output_audio_transcript.done","item_id":"reply-1","transcript":"Reply."}"#,
            ],
            expecting: 2,
            makeSession: { gateway, delegate in
                TalkRealtimeWebRTCSession(
                    gateway: gateway,
                    sessionKey: "main",
                    voiceSessionId: "voice-1",
                    transcriptStore: TalkRealtimeTranscriptStore(retryDelaysNanoseconds: []),
                    transcriptHoldTimeoutSeconds: 0.2,
                    delegate: delegate)
            },
            afterEvents: { talk, channel in
                try await Task.sleep(nanoseconds: 600_000_000)
                let late = #"{"type":"conversation.item.input_audio_transcription.completed","item_id":"user-1","transcript":"Late."}"#
                talk.dataChannel(channel, didReceiveMessageWith: RTCDataBuffer(data: Data(late.utf8), isBinary: false))
            })
        XCTAssertEqual(saved.map(\.text), ["Reply.", "Late."])
    }

    func testConsultFlushPersistsFinalsHeldBehindAStalledTurn() async throws {
        let saved = try await TalkRealtimeTranscriptOrderTests.persistedTranscripts(
            after: [
                #"{"type":"conversation.item.added","item":{"id":"reply-0","type":"message","role":"assistant"}}"#,
                #"{"type":"input_audio_buffer.committed","item_id":"user-1"}"#,
                #"{"type":"conversation.item.input_audio_transcription.completed","item_id":"user-1","transcript":"Ask OpenClaw."}"#,
            ],
            expecting: 1,
            makeSession: { gateway, delegate in
                TalkRealtimeWebRTCSession(
                    gateway: gateway,
                    sessionKey: "main",
                    voiceSessionId: "voice-1",
                    transcriptStore: TalkRealtimeTranscriptStore(retryDelaysNanoseconds: []),
                    transcriptHoldTimeoutSeconds: 60,
                    delegate: delegate)
            },
            afterEvents: { talk, _ in
                try await Task.sleep(nanoseconds: 200_000_000)
                // The consult path flushes before reading history.
                await talk.flushTranscriptWrites()
            })
        XCTAssertEqual(saved.map(\.text), ["Ask OpenClaw."])
    }

    func testStopPersistsFinalsHeldBehindAnUnfinishedTurn() async throws {
        let saved = try await TalkRealtimeTranscriptOrderTests.persistedTranscripts(
            after: [
                #"{"type":"input_audio_buffer.committed","item_id":"user-1"}"#,
                #"{"type":"conversation.item.added","item":{"id":"reply-1","type":"message","role":"assistant"}}"#,
                #"{"type":"response.output_audio_transcript.done","item_id":"reply-1","transcript":"Reply."}"#,
            ],
            expecting: 1,
            makeSession: { gateway, delegate in
                TalkRealtimeWebRTCSession(
                    gateway: gateway,
                    sessionKey: "main",
                    voiceSessionId: "voice-1",
                    transcriptStore: TalkRealtimeTranscriptStore(retryDelaysNanoseconds: []),
                    transcriptHoldTimeoutSeconds: 60,
                    delegate: delegate)
            },
            afterEvents: { talk, _ in
                // Let the queued data-channel events reach the session before Stop.
                try await Task.sleep(nanoseconds: 200_000_000)
                talk.stop()
            })
        XCTAssertEqual(saved.map(\.text), ["Reply."])
    }
}
