import Foundation
import OpenClawChatUI

extension LocalFixtureChatStore {
    static var playsWorkingLineFixture: Bool {
        ProcessInfo.processInfo.arguments.contains("--openclaw-working-line-fixture")
    }

    /// A plain turn with the startup timing of a real one: workspace for one frame, this turn for 0.2 s,
    /// then a wait, reasoning and a streamed answer. Each state lasts long enough to look at.
    func playWorkingLine(sessionKey: String, runId: String) async {
        func emit(_ seq: Int, _ stream: String, _ data: [String: Any]) {
            self.emitFixtureAgentEvent(
                runId: runId, seq: seq, stream: stream, timestamp: Date().timeIntervalSince1970 * 1000, data: data)
        }
        // The Gateway reports startup phases as chat status events.
        func phase(_ seq: Int, _ name: String) {
            let wire = try? JSONSerialization.data(withJSONObject: [
                "runId": runId, "sessionKey": sessionKey, "state": "status", "phase": name, "seq": seq,
            ])
            if let wire, let event = try? JSONDecoder().decode(OpenClawChatEventPayload.self, from: wire) {
                self.publish(.chat(event))
            }
            // History carries the run's phases too, as the Gateway's in-flight snapshot does.
            let agent = try? JSONSerialization.data(withJSONObject: [
                "runId": runId, "seq": seq, "stream": "run_status", "data": ["phase": name],
            ])
            if let agent, let event = try? JSONDecoder().decode(OpenClawAgentEventPayload.self, from: agent) {
                self.fixtureToolEvents.append(event)
            }
        }
        try? await Task.sleep(for: .milliseconds(300))
        phase(1, "preparing_workspace")
        try? await Task.sleep(for: .milliseconds(33))
        phase(2, "preparing_context")
        try? await Task.sleep(for: .milliseconds(200))
        phase(3, "starting_model")
        try? await Task.sleep(for: .seconds(4))
        emit(4, "thinking", ["delta": "Reading the message"])
        try? await Task.sleep(for: .seconds(4))
        let words = "Hi. I got both messages and I can look at the working line next. Send it over when ready."
            .split(separator: " ")
        for count in 1...words.count {
            emit(4 + count, "assistant", ["text": words.prefix(count).joined(separator: " ")])
            try? await Task.sleep(for: .milliseconds(450))
        }
        self.activeRunID = nil
        self.messages.append(.init(
            role: "assistant",
            content: [.init(type: "text", text: words.joined(separator: " "))],
            timestamp: Date().timeIntervalSince1970 * 1000,
            transcriptMessageID: "working-line-answer",
            transcriptRunID: runId,
            stopReason: "stop"))
        self.publish(.chat(.init(
            runId: runId, sessionKey: sessionKey, state: "final", message: nil, errorMessage: nil)))
    }
}
