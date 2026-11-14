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

    func testLateFramelessFragmentKeepsItsOpenReservation() throws {
        var order = TalkRealtimeTranscriptOrder()
        _ = try order.observe(event(#"{"type":"input_transcript.added","item":{"text":"Question"}}"#))
        _ = try order.observe(event(#"{"type":"output_transcript.added","item":{"text":"Reply"}}"#))
        XCTAssertEqual(order.settle(role: .assistant, text: "Reply.", itemId: nil), [])
        XCTAssertEqual(try order.observe(event(#"{"type":"input_transcript.added","item":{"text":"continued"}}"#)), [])
        XCTAssertEqual(self.texts(order.settle(role: .user, text: "Question continued.", itemId: nil)),
                       ["Question continued.", "Reply."])
    }

    func testInterruptedFramelessReplyDoesNotLendItsPlaceToTheNextReply() throws {
        var order = TalkRealtimeTranscriptOrder()
        _ = try order.observe(event(#"{"type":"output_transcript.added","item":{"text":"Let me"}}"#))
        _ = try order.observe(event(#"{"type":"input_transcript.added","item":{"text":"Stop"}}"#))
        XCTAssertEqual(order.settle(role: .user, text: "Stop.", itemId: nil), [])
        let released = try order.observe(event(#"{"type":"output_audio_buffer.cleared"}"#))
        XCTAssertEqual(self.texts(released), ["Stop."])
        _ = try order.observe(event(#"{"type":"output_transcript.added","item":{"text":"Okay"}}"#))
        XCTAssertEqual(self.texts(order.settle(role: .assistant, text: "Okay.", itemId: nil)), ["Okay."])
    }

    func testEmptyFramelessCompletionReleasesTheNextTurn() async throws {
        let saved = try await TalkRealtimeTranscriptOrderTests.persistedTranscripts(
            after: [
                #"{"type":"output_transcript.added","item":{"text":"Discarded"}}"#,
                #"{"type":"input_transcript.added","item":{"text":"Next"}}"#,
                #"{"type":"turn.done","turn":{"role":"user","transcript":"Next."}}"#,
                #"{"type":"turn.done","turn":{"role":"assistant","transcript":""}}"#,
            ],
            expecting: 1,
            makeSession: { gateway, delegate in
                TalkRealtimeWebRTCSession(
                    gateway: gateway, sessionKey: "main", voiceSessionId: "voice-1",
                    transcriptStore: TalkRealtimeTranscriptStore(retryDelaysNanoseconds: []),
                    transcriptHoldTimeoutSeconds: 60, delegate: delegate)
            })
        XCTAssertEqual(saved.map(\.text), ["Next."])
    }

    func testNewerBlockerSurvivesTheOlderTimeout() async throws {
        let clock = TranscriptHoldClock()
        defer { clock.resumeAll() }
        let newerReply = expectation(description: "newer reply processed")
        let saved = try await TalkRealtimeTranscriptOrderTests.persistedTranscripts(
            after: [
                #"{"type":"input_audio_buffer.committed","item_id":"u1"}"#,
                #"{"type":"conversation.item.added","item":{"id":"a1","type":"message","role":"assistant"}}"#,
                #"{"type":"response.output_audio_transcript.done","item_id":"a1","transcript":"A1."}"#,
            ],
            expecting: 3,
            onTranscript: { if $0 == "A2." { newerReply.fulfill() } },
            makeSession: { gateway, delegate in
                TalkRealtimeWebRTCSession(
                    gateway: gateway, sessionKey: "main", voiceSessionId: "voice-1",
                    transcriptStore: TalkRealtimeTranscriptStore(retryDelaysNanoseconds: []),
                    transcriptHoldTimeoutSeconds: 1,
                    transcriptHoldSleep: { await clock.sleep($0) }, delegate: delegate)
            },
            afterEvents: { talk, channel in
                await self.fulfillment(of: [clock.firstScheduled], timeout: 5)
                for json in [
                    #"{"type":"input_audio_buffer.committed","item_id":"u2"}"#,
                    #"{"type":"conversation.item.added","item":{"id":"a2","type":"message","role":"assistant"}}"#,
                #"{"type":"response.output_audio_transcript.done","item_id":"a2","transcript":"A2."}"#,
                ] {
                    talk.dataChannel(channel, didReceiveMessageWith: RTCDataBuffer(data: Data(json.utf8), isBinary: false))
                }
                await self.fulfillment(of: [newerReply], timeout: 5)
                clock.resumeOldest()
                await self.fulfillment(of: [clock.secondScheduled], timeout: 5)
                let final = #"{"type":"conversation.item.input_audio_transcription.completed","item_id":"u2","transcript":"U2."}"#
                talk.dataChannel(channel, didReceiveMessageWith: RTCDataBuffer(data: Data(final.utf8), isBinary: false))
            })
        XCTAssertEqual(saved.map(\.text), ["A1.", "U2.", "A2."])
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

/// A timeout fires only when the test releases it, independent of simulator load.
@MainActor
private final class TranscriptHoldClock {
    let firstScheduled = XCTestExpectation(description: "older timeout scheduled")
    let secondScheduled = XCTestExpectation(description: "newer timeout scheduled")
    private var pending: [CheckedContinuation<Void, Never>] = []
    private var scheduled = 0

    func sleep(_ nanoseconds: UInt64) async {
        XCTAssertEqual(nanoseconds, 1_000_000_000)
        await withCheckedContinuation { continuation in
            self.pending.append(continuation)
            self.scheduled += 1
            if self.scheduled == 1 { self.firstScheduled.fulfill() }
            if self.scheduled == 2 { self.secondScheduled.fulfill() }
        }
    }

    func resumeOldest() {
        self.pending.removeFirst().resume()
    }

    func resumeAll() {
        let pending = self.pending
        self.pending.removeAll()
        for continuation in pending { continuation.resume() }
    }
}
