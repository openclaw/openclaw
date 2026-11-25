import Foundation
import Testing
@testable import OpenClaw

struct TalkRealtimeServerEventDecodingTests {
    @Test(arguments: ["content", "connection_lost", "close_requested", "expired", "remote_hangup"])
    func `public Live closure receipts distinguish failures from graceful endings`(_ reason: String) throws {
        let data = try JSONSerialization.data(withJSONObject: ["type": "session.closed", "reason": reason])
        let event = try JSONDecoder().decode(TalkRealtimeServerEvent.self, from: data)
        let failureStatuses = ["content": "Realtime error", "connection_lost": "Realtime disconnected"]
        #expect(event.reason == reason)
        #expect(event.sessionCloseFailureStatus == failureStatuses[reason])
    }

    @Test func `decodes frameless realtime transcript and turn events`() throws {
        let userDelta = try JSONDecoder().decode(
            TalkRealtimeServerEvent.self,
            from: Data(#"{"type":"input_transcript.added","item":{"id":"user-1","text":"Hello"}}"#.utf8))
        #expect(userDelta.item?.id == "user-1")
        #expect(userDelta.item?.text == "Hello")

        let assistantDelta = try JSONDecoder().decode(
            TalkRealtimeServerEvent.self,
            from: Data(#"{"type":"output_transcript.added","item":{"id":"assistant-1","text":"Hi"}}"#.utf8))
        #expect(assistantDelta.item?.id == "assistant-1")
        #expect(assistantDelta.item?.text == "Hi")

        let turnDone = try JSONDecoder().decode(
            TalkRealtimeServerEvent.self,
            from: Data(
                #"{"type":"turn.done","turn":{"id":"turn-1","role":"assistant","transcript":"Hi there"}}"#.utf8))
        #expect(turnDone.turn?.id == "turn-1")
        #expect(turnDone.turn?.role == "assistant")
        #expect(turnDone.turn?.transcript == "Hi there")
    }

    @Test func `public Live captions preserve overlapping speakers and reset at a boundary`() throws {
        var buffer = TalkRealtimeLiveCaptionBuffer()
        func event(_ type: String, _ delta: String) throws -> TalkRealtimeServerEvent {
            let data = try JSONSerialization.data(withJSONObject: [
                "type": type, "delta": delta, "start_ms": 0, "end_ms": 500,
            ])
            return try JSONDecoder().decode(TalkRealtimeServerEvent.self, from: data)
        }

        #expect(try buffer.append(event("session.input_transcript.delta", "Check the "))?.text == "Check the ")
        #expect(try buffer.append(event("session.output_transcript.delta", "I'm "))?.text == "I'm ")
        let user = try buffer.append(event("session.input_transcript.delta", "lights"))
        #expect(user?.role == .user)
        #expect(user?.text == "Check the lights")
        let assistant = try buffer.append(event("session.output_transcript.delta", "checking."))
        #expect(assistant?.role == .assistant)
        #expect(assistant?.text == "I'm checking.")
        buffer.reset()
        #expect(try buffer.append(event("session.input_transcript.delta", "Next task"))?.text == "Next task")
        #expect(try buffer.append(event("session.output_transcript.delta", "Ready"))?.text == "Ready")
        #expect(try buffer.append(event("input_transcript.added", "Legacy")) == nil)
    }
}
