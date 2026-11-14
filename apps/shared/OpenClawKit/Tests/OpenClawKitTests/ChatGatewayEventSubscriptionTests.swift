import Foundation
import OpenClawChatUI
import OpenClawProtocol
import Testing
@testable import OpenClawKit

struct ChatGatewayEventSubscriptionTests {
    @Test
    func `chat admission preserves mapped events through an unrelated burst`() async throws {
        // Fixed wire fixtures cover the codec's public event contract, including
        // another agent's global session and extensible reason/stream values.
        let fixtures: [(name: String, payload: String, expected: String)] = [
            ("tick", "null", "tick"),
            (
                "chat.metadata.changed",
                #"""
                {
                  "agentId":"research",
                  "modelCatalogChanged":false
                }
                """#,
                "metadata:research:false"),
            ("chat.metadata.changed", #"{"modelSelectionChanged":true}"#, "modelSelection"),
            ("config.changed", "null", "modelSelection"),
            (
                "sessions.changed",
                #"""
                {
                  "sessionKey":"global",
                  "agentId":"research",
                  "reason":"future-reason"
                }
                """#,
                "session:research:global:future-reason"),
            (
                "session.reaction",
                #"""
                {
                  "sessionKey":"global",
                  "agentId":"research",
                  "sessionId":"transcript-1",
                  "messageId":"saved-1",
                  "emoji":"+1",
                  "action":"added",
                  "actor":{"type":"human","id":"viewer"},
                  "reactions":[]
                }
                """#,
                "reaction:research:saved-1"),
            (
                "session.observer",
                #"""
                {
                  "sessionKey":"global",
                  "runId":"run-1",
                  "revision":2,
                  "updatedAt":300,
                  "headline":"Working",
                  "health":"on-track"
                }
                """#,
                "observer:global:run-1"),
            ("seqGap", "null", "seqGap"),
            ("health", #"{"ok":false}"#, "health:false"),
            (
                "chat",
                #"""
                {
                  "runId":"run-1",
                  "sessionKey":"global",
                  "seq":1,
                  "state":"delta",
                  "deltaText":"Synthetic reply"
                }
                """#,
                "chat:run-1:delta"),
            (
                "session.message",
                #"""
                {
                  "sessionKey":"global",
                  "agentId":"research",
                  "messageId":"saved-1",
                  "message":{"role":"assistant","content":[{"type":"text","text":"Synthetic reply"}]}
                }
                """#,
                "message:research:saved-1"),
            (
                "agent",
                #"""
                {
                  "runId":"run-1",
                  "seq":1,
                  "ts":100,
                  "stream":"tool",
                  "data":{"phase":"start","name":"synthetic"}
                }
                """#,
                "agent:run-1:tool"),
            (
                "agent",
                #"""
                {
                  "runId":"run-1",
                  "seq":1,
                  "ts":100,
                  "stream":"future-stream",
                  "data":{}
                }
                """#,
                "agent:run-1:future-stream"),
            ("progressCard.changed", #"{"sessionKey":"global","revision":7}"#, "progress:global"),
            (
                "question.requested",
                #"""
                {
                  "id":"ask-1",
                  "questions": [
                      {
                        "questionId": "choice",
                        "header": "Choice",
                        "question": "Choose",
                        "options": [
                          {
                            "label": "One"
                          }
                        ]
                      }
                    ],
                  "agentId":"research",
                  "sessionKey":"global",
                  "createdAtMs":1,
                  "expiresAtMs":4000000000000,
                  "status":"pending"
                }
                """#,
                "question:ask-1"),
            ("question.resolved", #"{"id":"ask-1","status":"answered","answers":{"answers":{}}}"#, "resolved:ask-1"),
        ]
        let gateway = GatewayNodeSession()
        let chat = await gateway.makeServerEventSubscription(
            matching: { OpenClawChatGatewayPayloadCodec.acceptsEvent($0) })
        // An independent subscriber still receives every event. Its larger buffer
        // lets us count all mapping attempts without conflating them with overflow.
        let all = await gateway.makeServerEventSubscription(bufferingNewest: 512)
        defer {
            chat.cancel()
            all.cancel()
        }
        for fixture in fixtures {
            let wire = #"{"type":"event","event":"\#(fixture.name)","payload":\#(fixture.payload)}"#
            let frame = try JSONDecoder().decode(EventFrame.self, from: Data(wire.utf8))
            await gateway._test_broadcastServerEvent(frame)
        }
        // More traffic than the production 200-frame buffer. None of these names
        // maps to a chat effect, including the intentionally unused narration tail.
        let noise = ["presence", "node.invoke.request", "talk.mode", "session.narration", "plugin.future.event"]
        for index in 0..<250 {
            await gateway._test_broadcastServerEvent(EventFrame(type: "event", event: noise[index % noise.count]))
        }
        chat.cancel()
        all.cancel()
        // Finishing a subscription prevents later events from joining its buffer.
        await gateway._test_broadcastServerEvent(EventFrame(type: "event", event: "tick"))

        var chatMappingAttempts = 0
        var mapped: [String] = []
        for await frame in chat.events {
            chatMappingAttempts += 1
            let event = try #require(OpenClawChatGatewayPayloadCodec.event(from: frame))
            mapped.append(Self.effect(event))
        }
        var allMappingAttempts = 0
        var allMapped = 0
        for await frame in all.events {
            allMappingAttempts += 1
            if OpenClawChatGatewayPayloadCodec.event(from: frame) != nil { allMapped += 1 }
        }
        #expect(mapped == fixtures.map(\.expected))
        #expect(chatMappingAttempts == 16)
        #expect(allMappingAttempts == 266)
        #expect(allMapped == 16)
    }

    private static func effect(_ event: OpenClawChatTransportEvent) -> String {
        switch event {
        case .tick: "tick"
        case let .chatMetadataChanged(catalog, agent): "metadata:\(agent ?? ""):\(catalog)"
        case .modelSelectionChanged: "modelSelection"
        case let .sessionsChanged(change):
            "session:\(change.agentId ?? ""):\(change.sessionKey ?? ""):\(change.reason)"
        case let .sessionReaction(reaction): "reaction:\(reaction.agentID):\(reaction.messageID)"
        case let .sessionObserver(digest): "observer:\(digest.sessionkey):\(digest.runid ?? "")"
        case .seqGap: "seqGap"
        case let .health(ok): "health:\(ok)"
        case let .chat(chat): "chat:\(chat.runId ?? ""):\(chat.state ?? "")"
        case let .sessionMessage(message):
            "message:\(message.agentId ?? ""):\(message.message?.transcriptMessageID ?? "")"
        case let .agent(agent): "agent:\(agent.runId):\(agent.stream)"
        case let .progressCardChanged(card): "progress:\(card.sessionkey)"
        case let .questionRequested(question): "question:\(question.id)"
        case let .questionResolved(question): "resolved:\(question.id)"
        case .routeChanged: "routeChanged"
        case .reconnected: "reconnected"
        }
    }
}
