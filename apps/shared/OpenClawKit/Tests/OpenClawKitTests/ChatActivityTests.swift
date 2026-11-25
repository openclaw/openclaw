import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawChatUI

struct ChatActivityTests {
    private func child(_ key: String, _ state: ChatActivityChild.State) -> ChatActivityChild {
        ChatActivityChild(key: key, name: key, state: state, startedAt: nil, endedAt: nil, runtimeMs: nil, order: 0)
    }

    private func goal(_ status: OpenClawChatSessionGoal.Status = .active) -> OpenClawChatSessionGoal {
        OpenClawChatSessionGoal(id: "g1", objective: "Ship the trip plan", status: status, createdAt: 0, updatedAt: 0)
    }

    private func plan(_ statuses: [ProgressCardStepStatus], runActive: Bool = false) -> ChatActivityPlan {
        ChatActivityPlan(
            steps: statuses.enumerated().map { ProgressCardStep(step: "Step \($0.offset + 1)", status: $0.element) },
            note: nil,
            runActive: runActive,
            sessionStatus: nil,
            refreshPending: false)
    }

    private func pullRequests(
        _ states: [String],
        status: String = "ready") throws -> OpenClawSessionPullRequestSnapshot
    {
        let rows = states.enumerated().map { index, state in
            #"{"number":\#(100 + index),"owner":"o","repo":"r","branch":"b\#(index)","title":"T\#(index)","url":"https://github.com/o/r/pull/\#(100 + index)","state":"\#(state)","checks":{"state":"failing","passed":1,"failed":1,"skipped":0,"running":0}}"#
        }
        let json = #"{"pullRequests":[\#(rows.joined(separator: ","))],"rateLimited":false,"status":"\#(status)"}"#
        return try JSONDecoder().decode(OpenClawSessionPullRequestSnapshot.self, from: Data(json.utf8))
    }

    @Test func `no activity shows no row at all`() {
        #expect(ChatActivityRules.pills(ChatActivityInput()).isEmpty)
        // Finished and queued children are not activity in the row.
        let input = ChatActivityInput(children: [self.child("a", .done), self.child("b", .queued)])
        #expect(ChatActivityRules.pills(input).isEmpty)
    }

    @Test func `pills follow the web order with all four kinds`() throws {
        let input = try ChatActivityInput(
            children: [self.child("a", .working), self.child("b", .working), self.child("c", .done)],
            goal: self.goal(),
            plan: self.plan([.completed, .inProgress, .pending]),
            pullRequests: self.pullRequests(["merged", "open"]))
        let pills = ChatActivityRules.pills(input)
        #expect(pills.map(\.kind) == [
            .subagents, .goal, .progress, .pullRequest("o/r#101"), .pullRequest("o/r#100"),
        ])
        #expect(pills[0].label == "2 working")
    }

    @Test func `a waiting approval leaves only the Goal`() throws {
        let input = try ChatActivityInput(
            approvalPending: true,
            children: [self.child("a", .working)],
            goal: self.goal(.paused),
            plan: self.plan([.inProgress]),
            pullRequests: self.pullRequests(["open"]))
        #expect(ChatActivityRules.pills(input).map(\.kind) == [.goal])
    }

    @Test func `an active Goal never claims work in progress`() {
        let pill = ChatActivityRules.goal(self.goal())
        #expect(pill.label == "Goal active")
        #expect(pill.accessibilityLabel == "Goal active: Ship the trip plan")
        #expect(ChatActivityRules.goal(self.goal(.budgetLimited)).labelTone == .attention)
        #expect(ChatActivityRules.goal(self.goal(.complete)).label == "Goal achieved")
    }

    @Test func `a Goal the app cannot read stays out of the row`() throws {
        let row = try JSONDecoder().decode(OpenClawChatSessionEntry.self, from: Data(#"""
        {"key":"agent:main:a","goal":{"id":"g","objective":"x","status":"someday","tokensUsed":"many"}}
        """#.utf8))
        // The unknown state decodes without dropping the row, and shows no pill.
        #expect(row.key == "agent:main:a")
        #expect(row.goal?.isPresentable == false)
        #expect(ChatActivityRules.pills(ChatActivityInput(goal: row.goal)).isEmpty)
    }

    @Test func `the progress pill names the current step and counts what is done`() {
        let pill = ChatActivityRules.progress(self.plan([.completed, .pending, .pending]))
        // The first pending step is current; the count is completed, not position.
        #expect(pill.label == "Step 2")
        #expect(pill.count == "1/3")
        #expect(pill.badge?.label == "Pending")
        let running = ChatActivityRules.progress(self.plan([.completed, .inProgress], runActive: true))
        #expect(running.badge?.mark == .spinner)
        #expect(ChatActivityRules.progress(self.plan([.completed, .completed])).badge?.label == "Completed")
    }

    @Test func `a plan note without steps never shows a cut sentence`() {
        let note = ChatActivityPlan(
            steps: [],
            note: "Um par idêntico (N03). A cópia já estava encerrada; a original continua.",
            runActive: false,
            sessionStatus: nil,
            refreshPending: false)
        let pill = ChatActivityRules.progress(note)
        #expect(pill.label == "Task progress")
        #expect(pill.count == nil)
        #expect(pill.badge == nil)
    }

    @Test func `PR checks show only for an open head that GitHub answered for`() throws {
        let ready = try self.pullRequests(["open", "merged"])
        let open = ChatActivityRules.pullRequest(ready.pullRequests[0], status: ready.status)
        #expect(open.label == "#100")
        #expect(open.badge?.tone == .problem)
        #expect(ChatActivityRules.pullRequest(ready.pullRequests[1], status: "ready").badge == nil)
        // Kept from an earlier read: the warning replaces stale checks.
        let stale = ChatActivityRules.pullRequest(ready.pullRequests[0], status: "unavailable")
        #expect(stale.badge?.tone == .attention)
    }

    @Test func `children keep launch order and read their state from the row`() {
        let parent = OpenClawChatSessionEntry(key: "agent:main:p")
        var late = OpenClawChatSessionEntry(key: "agent:main:late", parentSessionKey: "agent:main:p", status: "running")
        late.createdAt = 20
        var early = OpenClawChatSessionEntry(key: "agent:main:early", spawnedBy: "agent:main:p", status: "failed")
        early.createdAt = 10
        let other = OpenClawChatSessionEntry(key: "agent:main:x", parentSessionKey: "agent:main:q", status: "running")
        let swarm = OpenClawChatSessionEntry(
            key: "agent:main:s", parentSessionKey: "agent:main:p", status: "running", swarmGroupId: "swarm:p:research")
        let children = ChatActivityChild.children(of: parent, in: [late, other, early, parent, swarm])
        #expect(children.map(\.key) == ["agent:main:early", "agent:main:late"])
        #expect(children.map(\.state) == [.failed, .working])
    }

    @Test func `a cleared Goal in a change removes it from the row`() {
        var row = OpenClawChatSessionEntry(key: "agent:main:a")
        row.goal = self.goal()
        let cleared = OpenClawChatSessionEntry(key: "agent:main:a")
        let merged = ChatSessionSidebarModel.mergingSessionFields(cleared, fields: ["goal"], into: row)
        #expect(merged.goal == nil)
        let untouched = ChatSessionSidebarModel.mergingSessionFields(cleared, fields: ["label"], into: row)
        #expect(untouched.goal?.id == "g1")
    }

    @Test func `elapsed time reads like the web Goal card`() {
        #expect(ChatActivityFormat.duration(ms: 42000) == "42s")
        #expect(ChatActivityFormat.duration(ms: 47 * 60000) == "47m")
        #expect(ChatActivityFormat.duration(ms: 125 * 60000) == "2h 5m")
        #expect(ChatActivityFormat.duration(ms: 26 * 3_600_000) == "1d 2h 0m")
        #expect(ChatActivityFormat.duration(ms: 15 * 86_400_000) == "2wk 1d 0h 0m")
        #expect(ChatActivityFormat.tokens(184_000) == "184k")
        #expect(ChatActivityFormat.tokens(1250) == "1.3k")
        #expect(ChatActivityFormat.goalUsage(self.goal()) == nil)
    }
}
