import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClawChatUI

@Suite("Chat subagent activity")
struct ChatSubagentActivityTests {
    @Test func `terminal snapshot retains live fields and expires after sixty seconds`() throws {
        var state = ChatSubagentActivityState()
        state.upsert(
            self.task(
                id: "task-1",
                status: "running",
                title: "  Layout review  ",
                lastActivity: "Applying patch",
                diffStat: ["files": 1, "added": 7, "removed": 2]),
            nowMilliseconds: 1000)
        #expect(state.presentation().rows.first?.title == "Layout review")
        state.upsert(
            self.task(
                id: "task-1",
                status: "completed",
                title: "Final layout review",
                progressSummary: "Earlier milestone",
                terminalSummary: "Done",
                endedAt: 2000),
            nowMilliseconds: 2000)

        let retained = try #require(state.presentation().rows.first)
        #expect(retained.status == .completed)
        #expect(retained.title == "Final layout review")
        #expect(retained.snippet == "Applying patch")
        #expect(retained.diffStat == ChatToolDiffStat(files: 1, added: 7, removed: 2))

        state.upsert(
            self.task(id: "task-1", status: "completed", title: "Final layout review", endedAt: 2000),
            nowMilliseconds: 5000,
            source: .snapshot)
        #expect(state.presentation().rows.first?.terminalObservedAt == 2000)

        state.removeExpired(nowMilliseconds: 61999)
        #expect(state.presentation().rows.count == 1)
        state.removeExpired(nowMilliseconds: 62000)
        #expect(state.presentation().rows.isEmpty)
    }

    @Test(arguments: [nil, "", " \n "] as [String?])
    func `unnamed activity keeps the generic label available`(title: String?) throws {
        var state = ChatSubagentActivityState()
        state.upsert(self.task(id: "unnamed", status: "running", title: title), nowMilliseconds: 1000)
        let activity = try #require(state.presentation().rows.first)
        #expect(activity.title == nil)
        #expect(activity.status == .running)
    }

    @Test func `caps rows at five and counts only hidden working tasks`() {
        var state = ChatSubagentActivityState()
        for index in 0..<7 {
            state.upsert(
                self.task(id: "working-\(index)", status: "running", startedAt: Double(index)),
                nowMilliseconds: Double(index))
        }
        state.upsert(
            self.task(id: "finished", status: "completed", endedAt: 10),
            nowMilliseconds: 10)

        let presentation = state.presentation()
        #expect(presentation.rows.map(\.id) == (2..<7).reversed().map { "working-\($0)" })
        #expect(presentation.hiddenWorkingCount == 2)
    }

    private func task(
        id: String,
        status: String,
        title: String? = nil,
        lastActivity: String? = nil,
        progressSummary: String? = nil,
        terminalSummary: String? = nil,
        diffStat: [String: Int]? = nil,
        startedAt: Double = 0,
        updatedAt: Double? = nil,
        endedAt: Double? = nil) -> TaskSummary
    {
        TaskSummary(
            id: id,
            runtime: "subagent",
            status: AnyCodable(status),
            title: title,
            agentid: "main",
            sessionkey: "agent:main:main",
            updatedat: AnyCodable(updatedAt ?? startedAt),
            startedat: AnyCodable(startedAt),
            endedat: endedAt.map(AnyCodable.init),
            lastactivity: lastActivity,
            diffstat: diffStat?.mapValues(AnyCodable.init),
            progresssummary: progressSummary,
            terminalsummary: terminalSummary)
    }
}
