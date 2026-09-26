import Foundation
import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClawChatUI

/// The Gateway sends `reasoningLevel` on the session read path (session rows,
/// history summaries, and `sessions.changed` events). These tests pin that the
/// Swift read-path models decode it and that the sidebar projection carries it,
/// so hosts can mirror the Control UI's `reasoningLevel === "on"` visibility gate.
struct ChatReasoningVisibilityTests {
    private func entry(key: String, reasoningLevel: String? = nil) -> OpenClawChatSessionEntry {
        OpenClawChatSessionEntry(
            key: key,
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
            reasoningLevel: reasoningLevel,
            inputTokens: nil,
            outputTokens: nil,
            totalTokens: nil,
            modelProvider: nil,
            model: nil,
            contextTokens: nil)
    }

    @Test func `history session summary decodes gateway reasoningLevel`() throws {
        let off = try JSONDecoder().decode(
            OpenClawChatSessionInfo.self,
            from: Data(#"{"key":"sess-x","agentId":"main","reasoningLevel":"off"}"#.utf8))
        #expect(off.reasoningLevel == "off")

        let absent = try JSONDecoder().decode(
            OpenClawChatSessionInfo.self,
            from: Data(#"{"key":"sess-x"}"#.utf8))
        #expect(absent.reasoningLevel == nil)
    }

    @Test func `session row decodes gateway reasoningLevel`() throws {
        let row = try JSONDecoder().decode(
            OpenClawChatSessionEntry.self,
            from: Data(#"{"key":"sess-x","reasoningLevel":"stream","updatedAt":100}"#.utf8))
        #expect(row.key == "sess-x")
        #expect(row.reasoningLevel == "stream")
    }

    @Test func `sessions changed event carries reasoningLevel and the sidebar projection applies it`() throws {
        let change = try JSONDecoder().decode(
            OpenClawChatSessionsChangedEvent.self,
            from: Data(
                #"{"sessionKey":"sess-x","reason":"patch","session":{"key":"sess-x","reasoningLevel":"off"}}"#.utf8))
        #expect(change.sessionKey == "sess-x")
        #expect(change.session?.reasoningLevel == "off")

        let projected = ChatSessionSidebarModel.applying(
            sessionChange: change,
            to: [self.entry(key: "sess-x", reasoningLevel: "on")],
            activeAgentId: nil)
        #expect(projected?.first?.reasoningLevel == "off")
    }

    @Test func `sidebar projection keeps local reasoningLevel when the event omits the session row`() {
        guard let change = try? JSONDecoder().decode(
            OpenClawChatSessionsChangedEvent.self,
            from: Data(#"{"sessionKey":"sess-x","reason":"patch","updatedAt":100}"#.utf8))
        else {
            Issue.record("expected a decodable sessions.changed event")
            return
        }
        let projected = ChatSessionSidebarModel.applying(
            sessionChange: change,
            to: [self.entry(key: "sess-x", reasoningLevel: "on")],
            activeAgentId: nil)
        #expect(change.session == nil)
        #expect(projected?.first?.reasoningLevel == "on")
    }

    /// History reload must project `sessionInfo.reasoningLevel` through
    /// `applyInFlightRunSnapshot` into the existing active session row, so the
    /// relaunch path cannot regress while decode tests still pass.
    @Test @MainActor func `history reload projects reasoningLevel into the active session entry`() {
        let viewModel = OpenClawChatViewModel(
            sessionKey: "sess-x",
            transport: TestChatTransport(historyResponses: []))
        defer { viewModel.detachTransport() }
        viewModel.sessions = [self.entry(key: "sess-x")]

        let payload = OpenClawChatHistoryPayload(
            sessionKey: "sess-x",
            sessionId: "sess-x",
            messages: [],
            thinkingLevel: nil,
            sessionInfo: OpenClawChatSessionInfo(
                hasActiveRun: false,
                activeRunIds: [],
                key: "sess-x",
                agentId: nil,
                reasoningLevel: "on"),
            inFlightRun: nil)
        let applied = viewModel.applyHistoryPayload(
            payload,
            for: viewModel.beginHistoryRequest(),
            preservingOptimisticLocalMessages: false)

        #expect(applied == true)
        #expect(viewModel.currentSessionEntry()?.reasoningLevel == "on")
        #expect(viewModel.currentSessionReasoningVisible == true)
    }
}