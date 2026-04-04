import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClaw

@MainActor
struct AgentEventStoreTests {
    @Test
    func `append and clear`() {
        let store = AgentEventStore()
        #expect(store.events.isEmpty)

        store.append(ControlAgentEvent(
            runId: "run",
            seq: 1,
            stream: "test",
            ts: 0,
            data: [:] as [String: OpenClawProtocol.AnyCodable],
            summary: nil))
        #expect(store.events.count == 1)

        store.clear()
        #expect(store.events.isEmpty)
    }

    @Test
    func `trims to max events`() {
        let store = AgentEventStore()
        for i in 1...401 {
            store.append(ControlAgentEvent(
                runId: "run",
                seq: i,
                stream: "test",
                ts: Double(i),
                data: [:] as [String: OpenClawProtocol.AnyCodable],
                summary: nil))
        }

        #expect(store.events.count == 400)
        #expect(store.events.first?.seq == 2)
        #expect(store.events.last?.seq == 401)
    }

    @Test
    func `latest assistant output prefers top level session key`() {
        let store = AgentEventStore()
        let base = Date(timeIntervalSince1970: 1_700_000_000)

        store.append(ControlAgentEvent(
            runId: "run-1",
            seq: 1,
            stream: "assistant",
            ts: base.addingTimeInterval(-60).timeIntervalSince1970 * 1000,
            data: [
                "text": AnyCodable("stale output"),
                "sessionKey": AnyCodable("main"),
            ],
            sessionKey: "agent:max:main",
            summary: nil))

        store.append(ControlAgentEvent(
            runId: "run-2",
            seq: 1,
            stream: "assistant",
            ts: base.addingTimeInterval(30).timeIntervalSince1970 * 1000,
            data: [
                "text": AnyCodable("fresh output"),
                "mediaUrls": AnyCodable([AnyCodable("https://example.com/render.png")]),
            ],
            sessionKey: "agent:max:main",
            summary: nil))

        let latest = store.latestAssistantOutput(sessionKey: "agent:max:main")
        #expect(latest?.text == "fresh output")
        #expect(latest?.hasMedia == true)

        let sinceRoundStart = store.latestAssistantOutput(
            sessionKey: "agent:max:main",
            since: base)
        #expect(sinceRoundStart?.text == "fresh output")

        let afterFreshOutput = store.latestAssistantOutput(
            sessionKey: "agent:max:main",
            since: base.addingTimeInterval(31))
        #expect(afterFreshOutput == nil)
    }

    @Test
    func `control agent event decodes top level session key`() throws {
        let payload = """
        {
          "runId": "run-1",
          "seq": 1,
          "stream": "assistant",
          "ts": 1700000000000,
          "sessionKey": "agent:gaga:main",
          "data": {
            "text": "hello"
          },
          "summary": "assistant update"
        }
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(ControlAgentEvent.self, from: payload)
        #expect(event.sessionKey == "agent:gaga:main")
        #expect(event.resolvedSessionKey == "agent:gaga:main")
    }
}
