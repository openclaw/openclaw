import Foundation
import Testing
@testable import OpenClawChatUI

private final class ContextUsageTestTransport: @unchecked Sendable, OpenClawChatTransport {
    func requestHistory(sessionKey _: String) async throws -> OpenClawChatHistoryPayload {
        throw CancellationError()
    }

    func sendMessage(
        sessionKey _: String,
        message _: String,
        thinking _: String,
        idempotencyKey _: String,
        attachments _: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        throw CancellationError()
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        false
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        AsyncStream { continuation in
            continuation.finish()
        }
    }
}

struct ChatContextUsageTests {
    private func message(
        role: String = "assistant",
        usage: OpenClawChatUsage? = nil) -> OpenClawChatMessage
    {
        OpenClawChatMessage(
            id: UUID(),
            role: role,
            content: [OpenClawChatMessageContent(
                type: "text",
                text: "hi",
                thinking: nil,
                thinkingSignature: nil,
                mimeType: nil,
                fileName: nil,
                content: nil,
                id: nil,
                name: nil,
                arguments: nil)],
            timestamp: nil,
            usage: usage)
    }

    private func usage(
        input: Int? = nil,
        output: Int? = nil,
        cacheRead: Int? = nil,
        cacheWrite: Int? = nil,
        total: Int? = nil,
        costTotal: Double? = nil,
        contextUsage: [String: Any]? = nil) throws -> OpenClawChatUsage
    {
        var payload: [String: Any] = [:]
        payload["input"] = input
        payload["output"] = output
        payload["cacheRead"] = cacheRead
        payload["cacheWrite"] = cacheWrite
        payload["total"] = total
        payload["contextUsage"] = contextUsage
        if let costTotal {
            payload["cost"] = ["total": costTotal]
        }
        let data = try JSONSerialization.data(withJSONObject: payload.compactMapValues { $0 })
        return try JSONDecoder().decode(OpenClawChatUsage.self, from: data)
    }

    /// Counters summed over a multi-call turn, far larger than the latest call's prompt.
    private func wholeTurnUsage(contextUsage: [String: Any]? = nil) throws -> OpenClawChatUsage {
        try self.usage(
            input: 100,
            output: 2000,
            cacheRead: 140_000,
            cacheWrite: 6900,
            total: 149_000,
            contextUsage: contextUsage)
    }

    @Test func `uses newest usage-bearing message, not a sum of runs`() throws {
        let messages = try [
            self.message(usage: self.usage(total: 900)),
            self.message(role: "user"),
            self.message(usage: self.usage(total: 1200)),
        ]
        let result = ChatContextUsageCalculator.usage(
            messages: messages,
            sessionEntry: nil,
            defaults: nil,
            modelContextWindow: 4000)

        #expect(result?.usedTokens == 1200)
        #expect(result?.contextWindowTokens == 4000)
        #expect(result?.percentUsed == 30)
    }

    @Test func `sums usage components when total is missing`() throws {
        let messages = try [self.message(usage: self.usage(input: 700, output: 100, cacheRead: 200))]
        let result = ChatContextUsageCalculator.usage(
            messages: messages,
            sessionEntry: nil,
            defaults: nil,
            modelContextWindow: nil)

        #expect(result?.usedTokens == 1000)
        #expect(result?.contextWindowTokens == nil)
        #expect(result?.fractionUsed == nil)
    }

    @Test func `whole-turn counters report the latest call's context marker`() throws {
        let marked = try self.wholeTurnUsage(
            contextUsage: ["state": "available", "promptTokens": 74000, "totalTokens": 75000])
        let results = try [marked, self.wholeTurnUsage()].map {
            ChatContextUsageCalculator.usage(
                messages: [self.message(usage: $0)],
                sessionEntry: nil,
                defaults: nil,
                modelContextWindow: 150_000)
        }

        #expect(results[0]?.usedTokens == 75000)
        #expect(results[0]?.percentUsed == 50)
        #expect(results[1]?.usedTokens == 149_000)
        // The transcript cache re-decodes its own encoding; the marker must survive it.
        let restored = try JSONDecoder().decode(OpenClawChatUsage.self, from: JSONEncoder().encode(marked))
        #expect(restored == marked)
    }

    @Test(arguments: [
        #"{"state":"estimated","promptTokens":74000,"totalTokens":75000}"#,
        #"{"state":"available","promptTokens":74000}"#,
        #"{"state":"available","promptTokens":"74000","totalTokens":75000}"#,
        #""available""#,
    ])
    func `unusable context marker decodes to nil and keeps the counters`(marker: String) throws {
        let message = try JSONDecoder().decode(OpenClawChatMessage.self, from: Data("""
        {"role":"assistant","content":"hi","usage":{"input":700,"output":100,"cacheRead":200,"contextUsage":\(marker)}}
        """.utf8))
        let result = ChatContextUsageCalculator.usage(
            messages: [message],
            sessionEntry: nil,
            defaults: nil,
            modelContextWindow: 2000)
        let presentation = try #require(ChatMessageUsagePresentation.make(
            message: message,
            contextWindowTokens: 2000))

        #expect(message.usage?.contextUsage == nil)
        #expect(result?.usedTokens == 1000)
        #expect(presentation.text.hasSuffix("45% ctx"))
    }

    @Test func `falls back to session totals without message usage`() {
        let entry = OpenClawChatSessionEntry(
            key: "main",
            kind: nil,
            displayName: nil,
            surface: nil,
            subject: nil,
            room: nil,
            space: nil,
            updatedAt: nil,
            sessionId: nil,
            systemSent: nil,
            abortedLastRun: nil,
            thinkingLevel: nil,
            verboseLevel: nil,
            inputTokens: nil,
            outputTokens: nil,
            totalTokens: 5000,
            modelProvider: nil,
            model: nil,
            contextTokens: 10000)
        let result = ChatContextUsageCalculator.usage(
            messages: [self.message()],
            sessionEntry: entry,
            defaults: nil,
            modelContextWindow: nil)

        #expect(result?.usedTokens == 5000)
        #expect(result?.contextWindowTokens == 10000)
        #expect(result?.percentUsed == 50)
    }

    @Test func `ignores stale session totals without message usage`() {
        let entry = OpenClawChatSessionEntry(
            key: "main",
            kind: nil,
            displayName: nil,
            surface: nil,
            subject: nil,
            room: nil,
            space: nil,
            updatedAt: nil,
            sessionId: nil,
            systemSent: nil,
            abortedLastRun: nil,
            thinkingLevel: nil,
            verboseLevel: nil,
            inputTokens: nil,
            outputTokens: nil,
            totalTokens: 5000,
            totalTokensFresh: false,
            modelProvider: nil,
            model: nil,
            contextTokens: 10000)
        let result = ChatContextUsageCalculator.usage(
            messages: [self.message()],
            sessionEntry: entry,
            defaults: nil,
            modelContextWindow: nil)

        #expect(result == nil)
    }

    @Test func `sums cost across all runs`() throws {
        let messages = try [
            self.message(usage: self.usage(total: 100, costTotal: 0.25)),
            self.message(usage: self.usage(total: 200, costTotal: 0.5)),
        ]
        let result = ChatContextUsageCalculator.usage(
            messages: messages,
            sessionEntry: nil,
            defaults: nil,
            modelContextWindow: nil)

        #expect(result?.totalCost == 0.75)
    }

    @Test func `no usage anywhere yields nil`() {
        let result = ChatContextUsageCalculator.usage(
            messages: [self.message()],
            sessionEntry: nil,
            defaults: nil,
            modelContextWindow: 4000)

        #expect(result == nil)
    }

    @Test @MainActor func `view model resolves context totals through a selected global alias`() {
        let vm = OpenClawChatViewModel(
            sessionKey: "agent:ops:main",
            transport: ContextUsageTestTransport(),
            activeAgentId: "main",
            sessionRoutingContract: "global|main|main")
        vm.sessions = [OpenClawChatSessionEntry(
            key: "global",
            kind: nil,
            displayName: nil,
            agentId: "ops",
            surface: nil,
            subject: nil,
            room: nil,
            space: nil,
            updatedAt: nil,
            sessionId: nil,
            systemSent: nil,
            abortedLastRun: nil,
            thinkingLevel: nil,
            verboseLevel: nil,
            inputTokens: nil,
            outputTokens: nil,
            totalTokens: 5000,
            modelProvider: nil,
            model: nil,
            contextTokens: 10000)]

        #expect(vm.contextUsage?.usedTokens == 5000)
        #expect(vm.contextUsage?.contextWindowTokens == 10000)
    }

    @Test func `assistant message usage mirrors the compact control UI footer`() throws {
        let message = try self.message(usage: self.usage(
            input: 59,
            output: 13400,
            cacheRead: 2_200_000,
            cacheWrite: 43900,
            costTotal: 0.01234))

        let presentation = try #require(ChatMessageUsagePresentation.make(
            message: message,
            contextWindowTokens: 3_000_000))

        #expect(presentation.text == "↑59 ↓13.4k R2.2M W43.9k $0.0123 ⚠︎ 75% ctx")
        #expect(presentation.pressure == .warning)
        #expect(presentation.accessibilityValue.contains("Warning"))
    }

    @Test func `usage footer sizes context from the marker and keeps whole-turn counters`() throws {
        let marked = try self.message(usage: self.wholeTurnUsage(
            contextUsage: ["state": "available", "promptTokens": 74000, "totalTokens": 75000]))
        let unmarked = try self.message(usage: self.wholeTurnUsage())

        let markedPresentation = try #require(ChatMessageUsagePresentation.make(
            message: marked,
            contextWindowTokens: 150_000))
        let unmarkedPresentation = try #require(ChatMessageUsagePresentation.make(
            message: unmarked,
            contextWindowTokens: 150_000))

        #expect(markedPresentation.text == "↑100 ↓2k R140k W6.9k 49% ctx")
        #expect(markedPresentation.pressure == .normal)
        #expect(unmarkedPresentation.text == "↑100 ↓2k R140k W6.9k ⚠︎ 98% ctx")
        #expect(unmarkedPresentation.pressure == .danger)
    }

    @Test func `context pressure excludes output tokens and clamps at one hundred percent`() throws {
        let warning = try self.message(usage: self.usage(
            input: 700,
            output: 900_000,
            cacheRead: 50,
            cacheWrite: 50))
        let danger = try self.message(usage: self.usage(input: 1200, output: 900_000))

        let warningPresentation = try #require(ChatMessageUsagePresentation.make(
            message: warning,
            contextWindowTokens: 1000))
        let dangerPresentation = try #require(ChatMessageUsagePresentation.make(
            message: danger,
            contextWindowTokens: 1000))

        #expect(warningPresentation.text.hasSuffix("⚠︎ 80% ctx"))
        #expect(warningPresentation.pressure == .warning)
        #expect(dangerPresentation.text.hasSuffix("⚠︎ 100% ctx"))
        #expect(dangerPresentation.pressure == .danger)
        #expect(dangerPresentation.accessibilityValue.contains("Critical"))
    }

    @Test func `extreme decoded usage clamps without integer overflow`() throws {
        let message = try self.message(usage: self.usage(input: Int.max, cacheRead: 1))

        let presentation = try #require(ChatMessageUsagePresentation.make(
            message: message,
            contextWindowTokens: 1))

        #expect(presentation.text.hasSuffix("⚠︎ 100% ctx"))
        #expect(presentation.pressure == .danger)
    }

    @Test func `usage footer is assistant-only and omits unsupported totals`() throws {
        let usage = try self.usage(total: 1200)
        let user = self.message(role: "user", usage: usage)
        let assistant = self.message(usage: usage)

        #expect(ChatMessageUsagePresentation.make(message: user, contextWindowTokens: 4000) == nil)
        #expect(ChatMessageUsagePresentation.make(message: assistant, contextWindowTokens: 4000) == nil)
    }
}
