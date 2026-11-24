import Foundation
import OpenClawChatUI
import OpenClawProtocol

extension LocalFixtureChatStore {
    func replayLiveToolActivity(sessionKey: String, runId: String) async {
        func publishEmptyThinking(_ index: Int, stopReason: String = "toolUse") {
            let id = "compact-thinking-\(index)"
            let message = OpenClawChatMessage(
                role: "assistant",
                content: [.init(type: "thinking", thinking: "", thinkingSignature: "fixture-signature")],
                timestamp: Date().timeIntervalSince1970 * 1000,
                transcriptMessageID: id,
                transcriptRunID: runId,
                stopReason: stopReason)
            self.messages.append(message)
            self.publish(.sessionMessage(.init(
                sessionKey: sessionKey,
                message: message,
                messageId: id,
                messageSeq: nil,
                hasActiveRun: true,
                activeRunIds: [runId])))
        }
        func emit(_ seq: Int, _ name: String, _ phase: String, _ args: [String: String], item: Bool = false) {
            var data: [String: Any] = [
                "toolCallId": "compact-\(name)", "name": name, "phase": phase, "args": args,
            ]
            if item {
                data["itemId"] = "tool:compact-\(name)"
                data["kind"] = "tool"
                data["title"] = name.capitalized
                data["status"] = phase == "end" ? "completed" : "running"
            } else if phase == "result" {
                data["isError"] = false
                data["result"] = ["content": [["type": "text", "text": "ready"]]]
            }
            let wire: [String: Any] = [
                "runId": runId, "seq": seq, "stream": item ? "item" : "tool", "data": data,
                "ts": Int(Date().timeIntervalSince1970 * 1000),
            ]
            if let bytes = try? JSONSerialization.data(withJSONObject: wire),
               let event = try? JSONDecoder().decode(OpenClawAgentEventPayload.self, from: bytes)
            {
                self.publish(.agent(event))
            }
        }
        try? await Task.sleep(for: .seconds(2))
        guard self.activeRunID == runId else { return }
        emit(1, "exec", "start", ["command": "printf ready"], item: true)
        emit(2, "exec", "start", ["command": "printf ready"])
        try? await Task.sleep(for: .seconds(6))
        guard self.activeRunID == runId else { return }
        publishEmptyThinking(1)
        emit(3, "process", "start", ["action": "poll"], item: true)
        emit(4, "process", "start", ["action": "poll"])
        publishEmptyThinking(2)
        emit(5, "read", "start", ["path": "README.md"], item: true)
        emit(6, "read", "start", ["path": "README.md"])
        try? await Task.sleep(for: .seconds(6))
        guard self.activeRunID == runId else { return }
        let startedAt = Date().timeIntervalSince1970 * 1000
        self.messages.append(OpenClawChatMessage(
            role: "assistant",
            content: [.init(type: "toolCall", id: "compact-exec", name: "exec")],
            timestamp: startedAt,
            transcriptMessageID: "compact-exec-call",
            transcriptRunID: runId))
        self.messages.append(OpenClawChatMessage(
            role: "assistant",
            content: [
                .init(type: "toolcall", id: "compact-process", name: "process"),
                .init(type: "tool_result", text: "ready", id: "compact-process", name: "process"),
            ],
            timestamp: startedAt + 1,
            transcriptMessageID: "compact-process-call",
            transcriptRunID: runId))
        publishEmptyThinking(3)
        self.messages.append(OpenClawChatMessage(
            role: "assistant",
            content: [.init(type: "toolcall", id: "compact-read", name: "read")],
            timestamp: Date().timeIntervalSince1970 * 1000,
            transcriptMessageID: "compact-read-call",
            transcriptRunID: runId))
        self.liveReplayReadHistory = false
        self.liveReplayAwaitingHistory = true
        self.publish(.seqGap)
        try? await Task.sleep(for: .seconds(12))
        self.liveReplayAwaitingHistory = false
        guard self.activeRunID == runId, self.liveReplayReadHistory else { return }
        emit(7, "exec", "result", ["command": "printf ready"])
        emit(8, "exec", "end", ["command": "printf ready"], item: true)
        try? await Task.sleep(for: .seconds(2))
        guard self.activeRunID == runId else { return }
        let now = Date().timeIntervalSince1970 * 1000
        for (offset, name) in ["exec", "process", "read"].enumerated() {
            let callID = "compact-\(name)"
            if name == "process" { continue }
            self.messages.append(OpenClawChatMessage(
                role: "toolResult",
                content: [.init(type: "text", text: "ready")],
                timestamp: now + Double(offset * 2 + 1),
                transcriptMessageID: "\(callID)-result",
                transcriptRunID: runId,
                toolCallId: callID,
                toolName: name))
        }
        self.messages.append(OpenClawChatMessage(
            role: "assistant",
            content: [.init(type: "text", text: "The checks are complete.")],
            timestamp: now + 6,
            transcriptMessageID: "compact-final",
            transcriptRunID: runId,
            stopReason: "stop",
            phase: "final_answer"))
        self.activeRunID = nil
        self.publish(.chat(.init(
            runId: runId,
            sessionKey: sessionKey,
            state: "final",
            message: nil,
            errorMessage: nil)))
    }
}
