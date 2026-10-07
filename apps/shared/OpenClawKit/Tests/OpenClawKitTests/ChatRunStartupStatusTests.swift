import Foundation
import Testing
@testable import OpenClawChatUI

@Suite("ChatRunStartup")
struct ChatRunStartupTests {
    private func status(_ text: String, seq: Int?, retrying: Bool = false, run: String = "r") -> ChatRunStartup {
        ChatRunStartup(runID: run, state: .status(text, retrying: retrying), seq: seq)
    }

    private func activity(seq: Int?, run: String = "r") -> ChatRunStartup {
        ChatRunStartup(runID: run, state: .activity, seq: seq)
    }

    @Test func `a status event decodes its phase and maps to the Control UI wording`() throws {
        let json = #"{"runId":"r","sessionKey":"main","state":"status","phase":"starting_model","seq":4}"#
        let event = try JSONDecoder().decode(OpenClawChatEventPayload.self, from: Data(json.utf8))
        #expect(event.state == "status" && event.phase == "starting_model" && event.seq == 4)
        #expect(ChatRunStartup.state(phase: event.phase, retry: event.retry)
            == .status("Waiting for a response…", retrying: false))
        let retry = OpenClawChatEventPayload.Retry(attempt: 2, maxAttempts: 5)
        #expect(ChatRunStartup.state(phase: "starting_model", retry: retry) == .status("Retrying… 2/5", retrying: true))
        #expect(ChatRunStartup.state(phase: "something_new", retry: nil) == nil)
    }

    @Test func `a replayed older status does not come back after the run moved on`() {
        let waiting = self.status("Waiting for a response…", seq: 3)
        // Newer status replaces older; an older or unsequenced one is ignored.
        #expect(ChatRunStartup
            .reconciled(current: self.status("Preparing this turn…", seq: 2), next: waiting) == waiting)
        #expect(ChatRunStartup
            .reconciled(current: waiting, next: self.status("Preparing this turn…", seq: 2)) == waiting)
        #expect(ChatRunStartup
            .reconciled(current: waiting, next: self.status("Preparing this turn…", seq: nil)) == waiting)

        // A chat delta ends the startup line and keeps the agent sequence for later comparisons.
        let active = ChatRunStartup.reconciled(current: waiting, next: self.activity(seq: nil))
        #expect(active == self.activity(seq: 3))
        // After activity, an ordinary status never returns, whatever its sequence; a newer retry does.
        #expect(ChatRunStartup
            .reconciled(current: active, next: self.status("Waiting for a response…", seq: 9)) == active)
        #expect(ChatRunStartup.reconciled(current: active, next: self.status("Retrying… 1/3", seq: 2, retrying: true))
            == active)
        let retry = self.status("Retrying… 1/3", seq: 5, retrying: true)
        #expect(ChatRunStartup.reconciled(current: active, next: retry) == retry)
    }

    @Test func `another run starts from its own first status`() {
        let old = self.activity(seq: 40)
        let fresh = self.status("Preparing this turn…", seq: 1, run: "next")
        #expect(ChatRunStartup.reconciled(current: old, next: fresh) == fresh)
    }
}

private struct StartupStatusTransport: OpenClawChatTransport {
    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        .init(sessionKey: sessionKey, sessionId: nil, messages: [], thinkingLevel: nil)
    }

    func sendMessage(
        sessionKey _: String, message _: String, thinking _: String, idempotencyKey: String,
        attachments _: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        .init(runId: idempotencyKey, status: "started")
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        true
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        AsyncStream { $0.finish() }
    }
}

@MainActor
struct ChatRunStartupTransportTests {
    private func model() -> OpenClawChatViewModel {
        let model = OpenClawChatViewModel(sessionKey: "main", transport: StartupStatusTransport())
        model.pendingRuns.insert("r")
        return model
    }

    private func chat(_ json: String, model: OpenClawChatViewModel) throws {
        let event = try JSONDecoder().decode(OpenClawChatEventPayload.self, from: Data(json.utf8))
        model.handleTransportEvent(.chat(event))
    }

    @Test func `startup status is scoped to the selected run and session`() throws {
        let model = self.model()
        defer { model.clearPendingRuns() }
        try self.chat(
            #"{"runId":"r","sessionKey":"main","state":"status","phase":"starting_model","seq":3}"#,
            model: model)
        #expect(model.runStartupStatus == "Waiting for a response…")
        try self.chat(
            #"""
            {
              "runId": "other",
              "sessionKey": "main",
              "state": "status",
              "phase": "preparing_context",
              "seq": 9
            }
            """#,
            model: model)
        try self.chat(
            #"""
            {
              "runId": "other",
              "sessionKey": "elsewhere",
              "state": "status",
              "phase": "preparing_context",
              "seq": 10
            }
            """#,
            model: model)
        let unrelated = try JSONDecoder().decode(OpenClawAgentEventPayload.self, from: Data(
            #"{"runId":"other","seq":11,"stream":"assistant","data":{"text":"Unrelated output"}}"#.utf8))
        model.handleTransportEvent(.agent(unrelated))
        #expect(model.runStartupStatus == "Waiting for a response…")
        let usage = try JSONDecoder().decode(OpenClawAgentEventPayload.self, from: Data(
            #"{"runId":"r","seq":12,"stream":"usage","data":{}}"#.utf8))
        model.handleTransportEvent(.agent(usage))
        #expect(model.runStartupStatus == "Waiting for a response…")
        model.clearStreamingActivity()
        #expect(model.runStartupStatus == nil)
    }

    @Test func `first output clears startup and only a newer sequenced retry can restore it`() throws {
        let model = self.model()
        defer { model.clearPendingRuns() }
        try self.chat(
            #"{"runId":"r","sessionKey":"main","state":"status","phase":"starting_model","seq":3}"#,
            model: model)
        try self.chat(
            #"""
            {
              "runId": "r",
              "sessionKey": "main",
              "state": "delta",
              "message": {
                "role": "assistant",
                "content": [
                  {
                    "type": "text",
                    "text": "Hello"
                  }
                ]
              }
            }
            """#,
            model: model)
        #expect(model.streamingAssistantText == "Hello")
        #expect(model.runStartupStatus == nil)
        try self.chat(
            #"""
            {
              "runId": "r",
              "sessionKey": "main",
              "state": "status",
              "phase": "preparing_context",
              "seq": 8
            }
            """#,
            model: model)
        #expect(model.runStartupStatus == nil)
        try self.chat(
            #"""
            {
              "runId": "r",
              "sessionKey": "main",
              "state": "status",
              "phase": "starting_model",
              "seq": 2,
              "retry": {
                "attempt": 1,
                "maxAttempts": 3
              }
            }
            """#,
            model: model)
        try self.chat(
            #"""
            {
              "runId": "r",
              "sessionKey": "main",
              "state": "status",
              "phase": "starting_model",
              "retry": {
                "attempt": 1,
                "maxAttempts": 3
              }
            }
            """#,
            model: model)
        #expect(model.runStartupStatus == nil)
        try self.chat(
            #"""
            {
              "runId": "r",
              "sessionKey": "main",
              "state": "status",
              "phase": "starting_model",
              "seq": 9,
              "retry": {
                "attempt": 2,
                "maxAttempts": 3
              }
            }
            """#,
            model: model)
        #expect(model.runStartupStatus == "Retrying… 2/3")
        let output = try JSONDecoder().decode(OpenClawAgentEventPayload.self, from: Data(
            #"{"runId":"r","seq":10,"stream":"assistant","data":{"text":"Recovered"}}"#.utf8))
        model.handleTransportEvent(.agent(output))
        #expect(model.runStartupStatus == nil)
        try self.chat(
            #"""
            {
              "runId": "r",
              "sessionKey": "main",
              "state": "status",
              "phase": "starting_model",
              "seq": 9,
              "retry": {
                "attempt": 2,
                "maxAttempts": 3
              }
            }
            """#,
            model: model)
        #expect(model.runStartupStatus == nil)
    }

    private func agent(_ json: String, model: OpenClawChatViewModel) throws {
        try model.handleTransportEvent(.agent(JSONDecoder().decode(
            OpenClawAgentEventPayload.self, from: Data(json.utf8))))
    }

    private func replay(_ json: String, text: String = "", model: OpenClawChatViewModel) throws {
        let events = try JSONDecoder().decode([OpenClawAgentEventPayload].self, from: Data(json.utf8))
        let payload = OpenClawChatHistoryPayload(
            sessionKey: "main", sessionId: nil, messages: [], thinkingLevel: nil,
            inFlightRun: .init(runId: "r", text: text, events: events))
        #expect(model.applyHistoryPayload(
            payload, for: model.beginHistoryRequest(), preservingOptimisticLocalMessages: true))
    }

    @Test func `history restores startup and orders replayed output before retry`() throws {
        let model = self.model()
        defer { model.clearPendingRuns() }
        try self.replay(
            #"[{"runId":"r","seq":3,"stream":"run_status","data":{"phase":"starting_model"}}]"#,
            model: model)
        #expect(model.runStartupStatus == "Waiting for a response…")
        try self.replay(
            #"[{"runId":"r","seq":5,"stream":"run_status","data":{"phase":"retrying","attempt":2,"maxAttempts":4}},{"runId":"r","seq":4,"stream":"assistant","data":{"text":"Earlier output"}}]"#,
            model: model)
        #expect(model.runStartupStatus == "Retrying… 2/4")
        try self.replay(
            #"[{"runId":"r","seq":6,"stream":"assistant","data":{}}]"#,
            model: model)
        #expect(model.runStartupStatus == nil)
        try self.chat(
            #"{"runId":"r","sessionKey":"main","state":"status","phase":"starting_model","seq":5,"retry":{"attempt":2,"maxAttempts":4}}"#,
            model: model)
        #expect(model.runStartupStatus == nil)
    }

    @Test func `buffered history cannot clear a newer live retry`() throws {
        let model = self.model()
        defer { model.clearPendingRuns() }
        try self.chat(
            #"{"runId":"r","sessionKey":"main","state":"status","phase":"starting_model","seq":10,"retry":{"attempt":2,"maxAttempts":4}}"#,
            model: model)
        try self.replay("[]", text: "Old buffered text", model: model)
        #expect(model.runStartupStatus == "Retrying… 2/4")
        try self.replay(
            #"[{"runId":"r","seq":8,"stream":"assistant","data":{}}]"#,
            text: "Old buffered text", model: model)
        #expect(model.runStartupStatus == "Retrying… 2/4")
        try self.replay(
            #"[{"runId":"r","seq":11,"stream":"assistant","data":{}}]"#,
            model: model)
        #expect(model.runStartupStatus == nil)
    }

    @Test func `ignored events and bookkeeping preserve startup until visible activity`() throws {
        let model = self.model()
        defer { model.clearPendingRuns() }
        model.progressCardStoreAvailable = true
        try self.chat(
            #"{"runId":"r","sessionKey":"main","state":"status","phase":"starting_model","seq":3}"#,
            model: model)
        for json in [
            #"{"runId":"r","seq":4,"stream":"item","data":{"kind":"tool","phase":"start","itemId":"hidden","title":"Hidden","suppressChannelProgress":true}}"#,
            #"{"runId":"r","seq":5,"stream":"item","data":{"kind":"tool"}}"#,
            #"{"runId":"r","seq":6,"stream":"plan","data":{"phase":"update","steps":["Do work"]}}"#,
            #"{"runId":"r","seq":7,"stream":"assistant","data":{"text":""}}"#,
            #"{"runId":"r","seq":8,"stream":"tool","data":{"phase":"start"}}"#,
            #"{"runId":"r","seq":9,"stream":"item","data":{"kind":"preamble","phase":"update","progressText":"Growing preview"}}"#,
            #"{"runId":"r","seq":10,"stream":"lifecycle","data":{"phase":"start"}}"#,
        ] {
            try self.agent(json, model: model)
            #expect(model.runStartupStatus == "Waiting for a response…")
        }
        try self.chat(
            #"{"runId":"r","sessionKey":"main","state":"delta"}"#,
            model: model)
        #expect(model.runStartupStatus == "Waiting for a response…")
        try self.agent(
            #"{"runId":"r","seq":11,"stream":"item","data":{"kind":"tool","phase":"start","itemId":"visible","title":"Read file"}}"#,
            model: model)
        #expect(model.runStartupStatus == nil)
    }

    @Test func `advertised but unowned output cannot clear startup`() throws {
        let model = OpenClawChatViewModel(sessionKey: "main", transport: StartupStatusTransport())
        model.activeSessionRunIDs = ["r"]
        try self.chat(
            #"{"runId":"r","sessionKey":"main","state":"status","phase":"starting_model","seq":3}"#,
            model: model)
        #expect(model.runStartupStatus == "Waiting for a response…")
        try self.agent(
            #"{"runId":"r","seq":4,"stream":"assistant","data":{"text":"Unowned output"}}"#,
            model: model)
        #expect(model.runStartupStatus == "Waiting for a response…")
    }

    @Test func `selected run replacement and session cleanup discard previous startup`() throws {
        let model = self.model()
        defer { model.clearPendingRuns() }
        try self.chat(
            #"{"runId":"r","sessionKey":"main","state":"status","phase":"starting_model","seq":3}"#,
            model: model)
        model.adoptRun(runId: "next", bufferedText: "")
        #expect(model.runStartupStatus == nil)
        try self.chat(
            #"{"runId":"next","sessionKey":"main","state":"status","phase":"starting_model","seq":1}"#,
            model: model)
        #expect(model.runStartupStatus == "Waiting for a response…")
        model.clearSessionOwnedState()
        #expect(model.runStartupStatus == nil && model.runStartup == nil)
    }

    @Test func `a no-op tool result cannot erase a live retry`() throws {
        let model = self.model()
        defer { model.clearPendingRuns() }
        try self.chat(
            #"{"runId":"r","sessionKey":"main","state":"status","phase":"starting_model","seq":10,"retry":{"attempt":2,"maxAttempts":4}}"#,
            model: model)
        try self.agent(
            #"{"runId":"r","seq":11,"stream":"tool","data":{"phase":"result","name":"read","toolCallId":"unknown"}}"#,
            model: model)
        #expect(model.runStartupStatus == "Retrying… 2/4")
        try self.agent(
            #"{"runId":"r","seq":12,"stream":"tool","data":{"phase":"start","name":"read","toolCallId":"known"}}"#,
            model: model)
        #expect(model.runStartupStatus == nil)
        try self.chat(
            #"{"runId":"r","sessionKey":"main","state":"status","phase":"starting_model","seq":13,"retry":{"attempt":3,"maxAttempts":4}}"#,
            model: model)
        try self.agent(
            #"{"runId":"r","seq":14,"stream":"tool","data":{"phase":"result","name":"read","toolCallId":"known"}}"#,
            model: model)
        #expect(model.runStartupStatus == nil)
    }
}
