import Foundation
import OpenClawChatUI
import OpenClawProtocol
import Testing

struct ChatGatewayPayloadCodecTests {
    @Test func `session key extracts canonical agent identity`() {
        #expect(OpenClawChatSessionKey.agentID(from: " agent:Reviewer:main ") == "Reviewer")
        #expect(OpenClawChatSessionKey.agentID(from: "agent::main") == nil)
        #expect(OpenClawChatSessionKey.agentID(from: "global") == nil)
    }

    @Test func `agent wait distinguishes terminal and retryable timeouts`() throws {
        #expect(try OpenClawChatGatewayPayloadCodec.decodeAgentWaitObservation(
            Data(#"{"status":"completed"}"#.utf8)) == .terminal(.completed))
        #expect(try OpenClawChatGatewayPayloadCodec.decodeAgentWaitObservation(
            Data(#"{"status":"pending"}"#.utf8)) == .checkAgain)
        #expect(try OpenClawChatGatewayPayloadCodec.decodeAgentWaitObservation(
            Data(#"{"status":"timeout","timeoutPhase":"queue"}"#.utf8)) == .checkAgain)
        #expect(try OpenClawChatGatewayPayloadCodec.decodeAgentWaitObservation(
            Data(#"{"status":"timeout","timeoutPhase":"provider"}"#.utf8)) ==
            .terminal(.failed(message: "Run timed out")))
    }

    @Test func `model choices preserve metadata and replace blank names`() throws {
        let choices = try OpenClawChatGatewayPayloadCodec.decodeModelChoices(Data(
            #"{"models":[{"id":"gpt-5","name":"  ","provider":"openai","contextWindow":200000,"reasoning":true}]}"#
                .utf8))

        #expect(choices == [OpenClawChatModelChoice(
            modelID: "gpt-5",
            name: "gpt-5",
            provider: "openai",
            contextWindow: 200_000,
            reasoning: true)])
    }

    @Test func `command choice normalizes source aliases and identity`() {
        let choice = OpenClawChatGatewayPayloadCodec.commandChoice(CommandEntry(
            name: "review",
            textaliases: [" /review ", ""],
            description: "Review changes",
            source: AnyCodable("plugin"),
            scope: AnyCodable("text"),
            acceptsargs: true))

        #expect(choice.id == "plugin:review:/review")
        #expect(choice.textAliases == ["/review"])
        #expect(choice.source == .plugin)
        #expect(choice.acceptsArgs)
    }

    @Test func `event frames map to shared chat transport events`() {
        let sessionsChanged = EventFrame(
            type: "event",
            event: "sessions.changed",
            payload: AnyCodable([
                "sessionKey": AnyCodable("agent:main:main"),
                "agentId": AnyCodable("main"),
                "reason": AnyCodable("command-metadata"),
            ]))
        guard case let .sessionsChanged(change) = OpenClawChatGatewayPayloadCodec.event(from: sessionsChanged)
        else {
            Issue.record("expected sessionsChanged")
            return
        }
        #expect(change == .init(
            sessionKey: "agent:main:main",
            agentId: "main",
            reason: "command-metadata"))

        let chat = EventFrame(
            type: "event",
            event: "chat",
            payload: AnyCodable([
                "runId": AnyCodable("run-1"),
                "sessionKey": AnyCodable("main"),
                "state": AnyCodable("final"),
            ]))
        guard case let .chat(payload) = OpenClawChatGatewayPayloadCodec.event(from: chat) else {
            Issue.record("expected chat")
            return
        }
        #expect(payload.runId == "run-1")
        #expect(payload.sessionKey == "main")
        #expect(payload.state == "final")

        #expect(OpenClawChatGatewayPayloadCodec.event(from: EventFrame(
            type: "event",
            event: "unknown")) == nil)
    }
}
