import Foundation
import Testing
@testable import OpenClawChatUI

@MainActor
struct ChatHistorySessionRowTests {
    private let key = "agent:main:field-notes"

    private func decode<T: Decodable>(_ json: String, as _: T.Type = T.self) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    private func history(label: String, updatedAt: Int) throws -> OpenClawChatHistoryPayload {
        try self.decode("""
        {"sessionKey":"\(self.key)","messages":[],"sessionInfo":{"key":"\(self.key)","label":"\(label)",
        "spawnedCwd":"/projects/Fieldnotes","updatedAt":\(updatedAt),"hasActiveRun":false}}
        """)
    }

    private func model() throws -> OpenClawChatViewModel {
        let viewModel = OpenClawChatViewModel(
            sessionKey: self.key,
            transport: TestChatTransport(historyResponses: [], sessionsResponses: []))
        // The capped roster holds newer chats only.
        viewModel.sessions = try [self.decode(#"{"key":"agent:main:newer","label":"Newer chat","updatedAt":9}"#)]
        return viewModel
    }

    @Test func `history keeps the title of a chat the roster leaves out`() throws {
        let viewModel = try self.model()
        defer { viewModel.detachTransport() }
        #expect(try viewModel.applyHistoryPayload(
            self.history(label: "Field recording plan", updatedAt: 5),
            for: viewModel.beginHistoryRequest(),
            preservingOptimisticLocalMessages: false,
            decodedMessages: []))
        #expect(viewModel.currentSessionEntry() == nil)
        #expect(viewModel.retainedActiveSession?.label == "Field recording plan")
        #expect(viewModel.retainedActiveSession?.spawnedCwd == "/projects/Fieldnotes")
        #expect(viewModel.retainedActiveSession?.agentId == "main")
    }

    @Test func `an older history row does not replace a newer retained row`() throws {
        let viewModel = try self.model()
        defer { viewModel.detachTransport() }
        viewModel.retainedActiveSession = try self.decode(
            "{\"key\":\"\(self.key)\",\"label\":\"Renamed plan\",\"updatedAt\":8}")
        #expect(try viewModel.applyHistoryPayload(
            self.history(label: "Field recording plan", updatedAt: 5),
            for: viewModel.beginHistoryRequest(),
            preservingOptimisticLocalMessages: false,
            decodedMessages: []))
        #expect(viewModel.retainedActiveSession?.label == "Renamed plan")
    }
}
