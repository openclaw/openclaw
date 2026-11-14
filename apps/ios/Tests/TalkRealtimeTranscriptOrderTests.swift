import Foundation
import OpenClawKit
@preconcurrency import WebRTC
import XCTest
@testable import OpenClaw

/// The user's speech recognition can finish after the reply's transcript. Persisted history
/// must still follow conversation order, whichever final arrives first.
@MainActor
final class TalkRealtimeTranscriptOrderTests: XCTestCase {
    func testLateUserTranscriptionPersistsBeforeTheReply() async throws {
        let saved = try await Self.persistedTranscripts(after: [
            #"{"type":"input_audio_buffer.speech_started","item_id":"user-1"}"#,
            #"{"type":"input_audio_buffer.committed","item_id":"user-1","previous_item_id":null}"#,
            #"{"type":"conversation.item.added","item":{"id":"user-1","type":"message","role":"user","content":[{"type":"input_audio"}]}}"#,
            #"{"type":"conversation.item.added","item":{"id":"reply-1","type":"message","role":"assistant","content":[]}}"#,
            // The race from the phone trace: the reply's final lands first.
            #"{"type":"response.output_audio_transcript.done","item_id":"reply-1","transcript":"Hey Peter."}"#,
            #"{"type":"conversation.item.input_audio_transcription.completed","item_id":"user-1","transcript":"Hey, Chatting."}"#,
        ], expecting: 2)
        XCTAssertEqual(saved.map(\.role), ["user", "assistant"])
        XCTAssertEqual(saved.map(\.text), ["Hey, Chatting.", "Hey Peter."])
        XCTAssertEqual(saved.map(\.entryId), ["1", "2"])
        XCTAssertLessThanOrEqual(saved[0].timestamp, saved[1].timestamp)
    }

    func testLateFramelessUserTurnPersistsBeforeTheReply() async throws {
        let saved = try await Self.persistedTranscripts(after: [
            #"{"type":"input_transcript.added","item":{"id":"in-1","text":"Hey,"}}"#,
            #"{"type":"output_transcript.added","item":{"id":"out-1","text":"Hey"}}"#,
            #"{"type":"turn.done","turn":{"id":"turn-2","role":"assistant","transcript":"Hey Peter."}}"#,
            #"{"type":"turn.done","turn":{"id":"turn-1","role":"user","transcript":"Hey, Chatting."}}"#,
        ], expecting: 2)
        XCTAssertEqual(saved.map(\.role), ["user", "assistant"])
        XCTAssertEqual(saved.map(\.text), ["Hey, Chatting.", "Hey Peter."])
    }

    func testFinalsInConversationOrderStillPersistImmediately() async throws {
        let saved = try await Self.persistedTranscripts(after: [
            #"{"type":"input_audio_buffer.committed","item_id":"user-1"}"#,
            #"{"type":"conversation.item.input_audio_transcription.completed","item_id":"user-1","transcript":"First."}"#,
            #"{"type":"conversation.item.added","item":{"id":"reply-1","type":"message","role":"assistant"}}"#,
            #"{"type":"response.output_audio_transcript.done","item_id":"reply-1","transcript":"Second."}"#,
        ], expecting: 2)
        XCTAssertEqual(saved.map(\.text), ["First.", "Second."])
    }

    static func persistedTranscripts(
        after events: [String],
        expecting count: Int,
        timeoutSeconds: Double = 5,
        makeSession: ((GatewayNodeSession, TalkRealtimeWebRTCSessionDelegate) -> TalkRealtimeWebRTCSession)? = nil,
        afterEvents: ((TalkRealtimeWebRTCSession, RTCDataChannel) async throws -> Void)? = nil)
        async throws -> [SavedTalkTranscript]
    {
        let requests = TranscriptRequestCapture()
        let socket = GatewayTestWebSocketTask(sendHook: { socket, message, _ in
            let data: Data
            switch message {
            case let .data(value): data = value
            case let .string(value): data = Data(value.utf8)
            @unknown default: return
            }
            let frame = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            guard frame["method"] as? String == "talk.client.transcript" else { return }
            let params = frame["params"] as? [String: Any] ?? [:]
            await requests.append(SavedTalkTranscript(
                entryId: params["entryId"] as? String ?? "",
                role: params["role"] as? String ?? "",
                text: params["text"] as? String ?? "",
                timestamp: params["timestamp"] as? Double ?? 0))
            let id = try XCTUnwrap(frame["id"] as? String)
            socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
        })
        let gateway = GatewayNodeSession()
        let delegate = TranscriptOrderDelegate()
        let talk = makeSession?(gateway, delegate) ?? TalkRealtimeWebRTCSession(
            gateway: gateway,
            sessionKey: "main",
            voiceSessionId: "voice-1",
            transcriptStore: TalkRealtimeTranscriptStore(retryDelaysNanoseconds: []),
            delegate: delegate)
        RTCInitializeSSL()
        let factory = RTCPeerConnectionFactory()
        let peer = try XCTUnwrap(factory.peerConnection(
            with: RTCConfiguration(),
            constraints: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil),
            delegate: nil))
        defer {
            talk.stop()
            peer.close()
        }
        try await gateway.connect(
            url: XCTUnwrap(URL(string: "ws://talk-test.invalid")),
            credentials: .init(),
            connectOptions: GatewayWebSocketTestSupport.identityFreeOperatorConnectOptions,
            sessionBox: WebSocketSessionBox(session: GatewayTestWebSocketSession(taskFactory: { socket })),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { BridgeInvokeResponse(id: $0.id, ok: true) })
        let channel = try XCTUnwrap(peer.dataChannel(
            forLabel: "synthetic-transcripts",
            configuration: RTCDataChannelConfiguration()))
        for event in events {
            talk.dataChannel(channel, didReceiveMessageWith: RTCDataBuffer(data: Data(event.utf8), isBinary: false))
        }
        try await afterEvents?(talk, channel)
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        while await requests.count < count, Date() < deadline {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        let deliveredBeforeFlush = await requests.count
        XCTAssertEqual(deliveredBeforeFlush, count, "expected delivery without an explicit flush")
        await talk.flushTranscriptWrites()
        // Late duplicates or extra writes would also be ordering bugs.
        try await Task.sleep(nanoseconds: 100_000_000)
        let saved = await requests.all
        await gateway.disconnect()
        XCTAssertEqual(saved.count, count, "persisted: \(saved.map(\.text))")
        return saved
    }
}

struct SavedTalkTranscript: Sendable {
    let entryId: String
    let role: String
    let text: String
    let timestamp: Double
}

private actor TranscriptRequestCapture {
    private var saved: [SavedTalkTranscript] = []
    func append(_ value: SavedTalkTranscript) {
        self.saved.append(value)
    }

    var count: Int {
        self.saved.count
    }

    var all: [SavedTalkTranscript] {
        self.saved
    }
}

@MainActor
private final class TranscriptOrderDelegate: TalkRealtimeWebRTCSessionDelegate {
    func realtimeSession(_: TalkRealtimeWebRTCSession, didChangeStatus _: String) {}
    func realtimeSession(_: TalkRealtimeWebRTCSession, didDetectInputSpeech _: Bool) {}
    func realtimeSession(_: TalkRealtimeWebRTCSession, didUpdateAudioLevels _: Double?, output _: Double?) {}
    func realtimeSession(_: TalkRealtimeWebRTCSession, didReceiveUserTranscript _: String) {}
    func realtimeSession(_: TalkRealtimeWebRTCSession, didReceiveAssistantTranscript _: String) {}
    func realtimeSession(
        _: TalkRealtimeWebRTCSession,
        didFailTranscriptPersistenceForEntry _: String,
        error _: Error) {}
    func realtimeSessionDidFinish(_: TalkRealtimeWebRTCSession) {}
}
