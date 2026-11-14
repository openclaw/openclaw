import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawChatUI

@MainActor
struct ChatQuestionDesktopHandoffTests {
    private func record() throws -> QuestionRecord {
        let json = #"""
        {
          "id": "ask_desktop",
          "sessionKey": "agent:main:main",
          "runId": "run_desktop",
          "createdAtMs": 1000000,
          "expiresAtMs": 4000000000000,
          "status": "pending",
          "questions": [{
            "questionId": "required_action",
            "header": "Manual step",
            "question": "Complete the manual step on this desktop.",
            "desktop": {"source": {"kind": "environment", "environmentId": "cbx_owned"}},
            "options": [{"label": "Ready to recheck"}, {"label": "Stop this task"}],
            "isOther": false
          }]
        }
        """#
        return try JSONDecoder().decode(QuestionRecord.self, from: Data(json.utf8))
    }

    @Test func `desktop presentation keeps the canonical task and uses ordinary question settlement`() async throws {
        let transport = TestChatTransport(historyResponses: [], resolveQuestionHook: { id, answers, hosts in
            #expect(id == "ask_desktop")
            #expect(answers == ["required_action": ["Ready to recheck"]])
            #expect(hosts == nil)
            return QuestionAnswers(answers: answers.mapValues(AnyCodable.init))
        })
        let viewModel = OpenClawChatViewModel(sessionKey: "agent:main:main", transport: transport)
        defer { viewModel.detachTransport() }
        viewModel.input = "Keep this unsent draft"
        viewModel.upsertQuestion(try self.record())
        let handoff = try #require(viewModel.pendingDesktopHandoffs.first)
        #expect(handoff.requestID == "ask_desktop")
        #expect(handoff.questionID == "required_action")
        #expect(handoff.sessionKey == "agent:main:main")
        #expect(handoff.runID == "run_desktop")
        #expect(handoff.environmentID == "cbx_owned")

        let card = try #require(viewModel.visibleQuestionCards.first)
        // Reading/reopening a desktop is presentation, never a ready answer.
        #expect(viewModel.activeDesktopHandoffs == [handoff])
        #expect(!card.canSubmit)
        #expect(card.status() == .pending)
        card.toggleOption(questionID: "required_action", value: "Ready to recheck")
        await viewModel.submitQuestion(card)

        #expect(card.status() == .answered)
        #expect(viewModel.activeDesktopHandoffs.isEmpty)
        #expect(viewModel.input == "Keep this unsent draft")
    }

    @Test func `a child question cannot open in its parent conversation and retirement clears its target`() throws {
        let viewModel = OpenClawChatViewModel(
            sessionKey: "agent:main:parent", transport: TestChatTransport(historyResponses: []))
        defer { viewModel.detachTransport() }
        viewModel.upsertQuestion(try self.record())
        #expect(viewModel.pendingDesktopHandoffs.isEmpty)

        viewModel.syncSession(to: "agent:main:main")
        #expect(viewModel.pendingDesktopHandoffs.first?.environmentID == "cbx_owned")
        viewModel.retireQuestionAuthority()
        #expect(viewModel.activeDesktopHandoffs.isEmpty)
    }
}
