import Foundation
import OpenClawChatUI
import OpenClawProtocol

extension LocalFixtureChatStore {
    func finishExternalRunTool() {
        let now = Date().timeIntervalSince1970 * 1000
        self.emitFixtureAgentEvent(
            runId: "fixture-external-run",
            seq: 3,
            stream: "tool",
            timestamp: now,
            data: ["phase": "result", "name": "read", "toolCallId": "external-read"])
        self.emitFixtureAgentEvent(
            runId: "fixture-external-run", seq: 4, stream: "usage", timestamp: now, data: ["outputTokens": 485])
    }

    func emitFixtureAgentEvent(
        runId: String,
        seq: Int,
        stream: String,
        timestamp: Double,
        data: [String: Any],
        snapshotOnly: Bool = false)
    {
        let frame = EventFrame(
            type: "event",
            event: "agent",
            payload: AnyCodable([
                "runId": runId, "seq": seq, "stream": stream, "ts": Int(timestamp), "data": data,
            ]))
        guard let event = OpenClawChatGatewayPayloadCodec.event(from: frame) else {
            preconditionFailure("Invalid duplicate reply fixture event")
        }
        if Self.reconnectsToolFixture, case let .agent(agent) = event {
            if stream == "item", let itemID = agent.data["itemId"]?.stringValue {
                // The Gateway snapshot keeps the newest phase per item ID, not every live item update.
                self.fixtureToolEvents.removeAll { $0.stream == "item" && $0.data["itemId"]?.stringValue == itemID }
            }
            self.fixtureToolEvents.append(agent)
        }
        if !snapshotOnly { self.publish(event) }
    }

    static func toolRunSeed() -> [OpenClawChatMessage] {
        [OpenClawChatMessage(
            role: "user",
            content: [.init(type: "text", text: "Check the sample project.")],
            timestamp: Date().timeIntervalSince1970 * 1000,
            transcriptMessageID: "slot-input",
            transcriptRunID: self.toolRunID)]
    }

    static let toolRunID = "fixture-tool-slot"
    static var playsToolRunFixture: Bool {
        ProcessInfo.processInfo.arguments.contains("--openclaw-tool-run-fixture")
    }

    static var reconnectsToolFixture: Bool {
        ProcessInfo.processInfo.arguments.contains("--openclaw-reconnect-tool-fixture")
    }

    func toolRunSnapshot(sessionKey: String) -> OpenClawChatInFlightRun? {
        guard Self.playsToolRunFixture, let runID = self.activeRunID else { return nil }
        if !self.toolRunReplayStarted {
            self.toolRunReplayStarted = true
            Task { await self.replayToolRun(sessionKey: sessionKey) }
        }
        return .init(runId: runID, text: "", events: self.fixtureToolEvents.isEmpty ? nil : self.fixtureToolEvents)
    }

    /// Live events arrive first. A normal transcript invalidation then returns the provider's
    /// unsequenced CLI rows; no new send, reconnect, or synthetic run switch is involved.
    private func replayImportedTools(sessionKey: String) async {
        try? await Task.sleep(for: .seconds(3))
        let run = Self.toolRunID
        let tool = "mcp__openclaw__exec"
        let started = Date().timeIntervalSince1970 * 1000
        func historyMessage(_ role: String, _ id: String, _ offset: Double, _ blocks: [[String: Any]]) -> AnyCodable {
            AnyCodable([
                "role": role,
                "timestamp": started + offset,
                "content": blocks,
                "__openclaw": [
                    "id": id,
                    "importedFrom": "claude-cli",
                    "cliSessionId": "sample-library",
                    "externalId": id,
                ],
            ] as [String: Any])
        }
        var imported = [historyMessage(
            "assistant",
            "library-note",
            0,
            [["type": "text", "text": "Checking the sample shelves."]])]
        for (i, shelf) in ["north", "east", "west"].enumerated() {
            let id = "toolu_sample_" + shelf
            let offset = Double(i * 10 + 1)
            let args = ["command": "cat " + shelf + ".txt"]
            let call: [String: Any] = ["type": "toolcall", "id": id, "name": tool, "arguments": args]
            self.emitFixtureAgentEvent(
                runId: run,
                seq: i * 4 + 1,
                stream: "item",
                timestamp: started + offset,
                data: [
                    "kind": "tool",
                    "phase": "start",
                    "status": "running",
                    "itemId": "tool:" + id,
                    "toolCallId": id,
                    "title": "Exec",
                    "name": "exec",
                ])
            self.emitFixtureAgentEvent(
                runId: run,
                seq: i * 4 + 2,
                stream: "tool",
                timestamp: started + offset,
                data: ["phase": "start", "toolCallId": id, "name": "exec", "args": args])
            if shelf == "west" {
                imported.append(historyMessage("assistant", shelf, offset + 1, [call]))
                break
            }
            let output = shelf + " shelf checked"
            let result: [String: Any] = [
                "type": "tool_result",
                "tool_use_id": id,
                "name": tool,
                "is_error": false,
                "content": output,
            ]
            self.emitFixtureAgentEvent(
                runId: run,
                seq: i * 4 + 3,
                stream: "tool",
                timestamp: started + offset + 1,
                data: [
                    "phase": "result",
                    "toolCallId": id,
                    "name": "exec",
                    "result": ["text": output],
                ])
            self.emitFixtureAgentEvent(
                runId: run,
                seq: i * 4 + 4,
                stream: "item",
                timestamp: started + offset + 2,
                data: [
                    "kind": "tool",
                    "phase": "end",
                    "status": "completed",
                    "itemId": "tool:" + id,
                    "toolCallId": id,
                    "name": "exec",
                    "title": "Exec",
                ])
            if i == 0 {
                imported.append(historyMessage("assistant", shelf, offset + 2, [call, result]))
            } else {
                imported.append(historyMessage(
                    "assistant",
                    shelf,
                    offset + 2,
                    [["type": "thinking", "thinking": "Checking"], call]))
                imported.append(historyMessage("user", shelf + "-result", offset + 3, [result]))
            }
        }
        try? await Task.sleep(for: .milliseconds(650))
        self.importedToolRows = imported
        if Self.reconnectsToolFixture {
            // The last call can finish on the server while the socket is away, before its saved receipt arrives.
            if ProcessInfo.processInfo.arguments.contains("--openclaw-finish-tool-offline") {
                self.emitFixtureAgentEvent(
                    runId: run,
                    seq: 11,
                    stream: "tool",
                    timestamp: started + 24,
                    data: ["phase": "result", "name": "exec", "toolCallId": "toolu_sample_west"],
                    snapshotOnly: true)
                self.emitFixtureAgentEvent(
                    runId: run,
                    seq: 12,
                    stream: "item",
                    timestamp: started + 25,
                    data: [
                        "kind": "tool", "phase": "end", "status": "completed", "itemId": "tool:toolu_sample_west",
                        "toolCallId": "toolu_sample_west", "name": "exec", "title": "Exec",
                    ],
                    snapshotOnly: true)
            }
            self.publish(.reconnected)
        } else {
            self.publish(.sessionsChanged(.init(sessionKey: sessionKey, reason: "message", phase: "message")))
        }
    }

    /// Activity sidecar from the Gateway's history projection of these invented calls.
    static func importedHistoryActivity() throws -> [OpenClawChatHistoryActivity] {
        try JSONDecoder().decode([OpenClawChatHistoryActivity].self, from: Data(#"""
        [
          {"messageId":"north","items":[
            {"itemId":"tool:toolu_sample_north","toolCallId":"toolu_sample_north","name":"exec",
             "kind":"tool","phase":"end","title":"Exec","status":"completed",
             "meta":"show north.txt, `cat north.txt`","commandBearing":true}
          ]},
          {"messageId":"east","items":[
            {"itemId":"tool:toolu_sample_east","toolCallId":"toolu_sample_east","name":"exec",
             "kind":"tool","phase":"end","title":"Exec",
             "meta":"show east.txt, `cat east.txt`","commandBearing":true,"unpairedCall":true}
          ]},
          {"messageId":"east-result","items":[
            {"itemId":"tool:toolu_sample_east","toolCallId":"toolu_sample_east","name":"exec",
             "kind":"tool","phase":"end","title":"Exec","status":"completed","commandBearing":true}
          ]},
          {"messageId":"west","items":[
            {"itemId":"tool:toolu_sample_west","toolCallId":"toolu_sample_west","name":"exec",
             "kind":"tool","phase":"end","title":"Exec",
             "meta":"show west.txt, `cat west.txt`","commandBearing":true,"unpairedCall":true}
          ]}
        ]
        """#.utf8))
    }

    private func replayToolRun(sessionKey: String) async {
        let arguments = ProcessInfo.processInfo.arguments
        if arguments.contains("--openclaw-imported-tool-fixture") {
            await self.replayImportedTools(sessionKey: sessionKey)
            return
        }
        let interval = arguments.firstIndex(of: "--openclaw-tool-run-interval-ms").flatMap {
            arguments.indices.contains($0 + 1) ? Int(arguments[$0 + 1]) : nil
        } ?? 1500
        let run = Self.toolRunID
        let files = [
            "index",
            "outline",
            "palette",
            "spacing",
            "layout",
            "icons",
            "buttons",
            "forms",
            "fields",
            "menus",
            "panels",
            "labels",
            "report",
        ]
        let narration = [1: "I’ll check the components next.", files.count - 1: "One last check on the report."]
        let initialDelay = arguments.firstIndex(of: "--openclaw-tool-run-start-delay-ms").flatMap {
            arguments.indices.contains($0 + 1) ? Int(arguments[$0 + 1]) : nil
        } ?? 3000
        try? await Task.sleep(for: .milliseconds(initialDelay))
        for (index, file) in files.enumerated() {
            let now = Date().timeIntervalSince1970 * 1000
            let call = "slot-\(file)"
            if let note = narration[index] {
                self.emitFixtureAgentEvent(runId: run, seq: index * 4, stream: "item", timestamp: now, data: [
                    "kind": "preamble", "phase": "end", "itemId": "note-\(index)", "progressText": note,
                ])
                let segment = ["source": "segment", "itemId": "note-\(index)", "runId": run]
                let fallback = try? JSONDecoder().decode(
                    OpenClawChatStreamFallback.self, from: JSONEncoder().encode(segment))
                self.messages.append(.init(
                    role: "assistant",
                    content: [.init(type: "text", text: note)],
                    timestamp: now,
                    transcriptMessageID: "note-\(index)",
                    transcriptRunID: run,
                    phase: "commentary",
                    streamFallback: fallback))
            }
            let args = ["command": "cat \(file).txt"]
            self.emitFixtureAgentEvent(runId: run, seq: index * 4 + 1, stream: "tool", timestamp: now + 1, data: [
                "phase": "start", "toolCallId": call, "name": "exec", "args": args,
            ])
            try? await Task.sleep(for: .milliseconds(interval))
            let output = "Checked \(file).txt"
            if index.isMultiple(of: 2) {
                self.emitFixtureAgentEvent(runId: run, seq: index * 4 + 2, stream: "item", timestamp: now + 2, data: [
                    "kind": "tool", "phase": "end", "itemId": call, "toolCallId": call, "name": "exec",
                    "title": "Checked \(file).txt", "status": "completed",
                ])
            }
            self.emitFixtureAgentEvent(runId: run, seq: index * 4 + 3, stream: "tool", timestamp: now + 3, data: [
                "phase": "result", "name": "exec", "toolCallId": call, "result": ["text": output],
            ])
            self.messages.append(.init(
                role: "assistant",
                content: [
                    .init(type: "toolCall", id: call, name: "exec", arguments: .init(args)),
                    .init(type: "tool_result", text: output, id: call, name: "exec"),
                ],
                timestamp: now + 1,
                transcriptMessageID: call,
                transcriptRunID: run))
        }
        self.activeRunID = nil
        self.messages.append(.init(
            role: "assistant",
            content: [.init(type: "text", text: "All checks passed.")],
            timestamp: Date().timeIntervalSince1970 * 1000,
            transcriptMessageID: "slot-answer",
            transcriptRunID: run,
            stopReason: "stop"))
        self.publish(.chat(.init(runId: run, sessionKey: sessionKey, state: "final", message: nil, errorMessage: nil)))
    }
}
