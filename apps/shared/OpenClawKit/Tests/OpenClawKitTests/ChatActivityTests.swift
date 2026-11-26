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
            let number = 100 + index
            let checks = #""checks":{"state":"failing","passed":1,"failed":1,"skipped":0,"running":0}"#
            return #"{"number":\#(number),"owner":"o","repo":"r","branch":"b\#(index)","title":"T\#(index)","#
                + #""url":"https://github.com/o/r/pull/\#(number)","state":"\#(state)",\#(checks)}"#
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

    private func pill(
        _ state: String,
        checks: OpenClawSessionPullRequestSnapshot.Checks?,
        status: String = "ready") -> ChatActivityPill
    {
        let pr = OpenClawSessionPullRequestSnapshot.PullRequest(
            number: 7, owner: "o", repo: "r", branch: "b", title: "T", url: "u7", state: state, checks: checks)
        return ChatActivityRules.pullRequestPills(.init(pullRequests: [pr], status: status))[0]
    }

    private func checks(_ state: String, failed: Int = 0, running: Int = 0, passed: Int = 0)
        -> OpenClawSessionPullRequestSnapshot.Checks
    {
        .init(state: state, passed: passed, failed: failed, skipped: 0, running: running)
    }

    @Test func `the PR pill marks running and failed checks and nothing once they pass`() {
        let running = self.pill("open", checks: self.checks("pending", running: 4, passed: 8))
        #expect(running.label == "#7")
        #expect(running.symbol == "arrow.triangle.pull")
        #expect(running.badge?.mark == .spinner)
        #expect(running.badge?.tone == .neutral)
        let failed = self.pill("open", checks: self.checks("failing", failed: 1, passed: 11))
        #expect(failed.badge?.mark == .symbol("xmark"))
        #expect(failed.badge?.tone == .problem)
        #expect(self.pill("open", checks: self.checks("passing", passed: 12)).badge == nil)
        let merged = self.pill("merged", checks: self.checks("failing", failed: 1))
        #expect(merged.symbol == "arrow.triangle.merge")
        #expect(merged.badge == nil)
        // Kept from an earlier read: the warning replaces checks that may be stale.
        let stale = self.pill("open", checks: self.checks("failing", failed: 1), status: "unavailable")
        #expect(stale.badge?.tone == .attention)
    }

    @Test func `a published PR GitHub didn't answer for is dimmed, locked, and listed once`() throws {
        let verified = OpenClawSessionPullRequestSnapshot.PullRequest(
            number: 2, owner: "o", repo: "r", branch: "b", title: "Two", url: "u2", state: "open")
        let snapshot = OpenClawSessionPullRequestSnapshot(
            pullRequests: [verified],
            taskPullRequests: [
                .init(url: "u1", owner: "o", repo: "notes", number: 1, branch: "x"),
                .init(url: "u2", owner: "o", repo: "r", number: 2, branch: "b", pullRequest: verified),
            ])
        let list = ChatActivityPullRequest.list(snapshot)
        // The same URL from the branch and a publication is one PR; open before one without details.
        #expect(list.map(\.number) == [2, 1])
        let locked = ChatActivityRules.pullRequestPills(snapshot)[1]
        #expect(locked.symbol == "lock")
        #expect(locked.labelTone == .muted)
        #expect(locked.badge == nil)
        #expect(list[1].title == nil)
        // Its sheet has the title line only: the repository line stands in for the missing title.
        #expect(list[1].summaryLine == nil)
        #expect(list[1].repositoryLine == "o/notes #1")
        // The Gateway's JSON decodes the publication without its details.
        let decoded = try JSONDecoder().decode(OpenClawSessionPullRequestSnapshot.self, from: Data(#"""
        {"pullRequests":[],"rateLimited":false,"status":"unavailable","taskPullRequests":[{"url":"u1","owner":"o",
        "repo":"notes","number":1,"branch":"x","sourceSessionKey":"agent:main:c","sourceAgentId":"main"}]}
        """#.utf8))
        #expect(ChatActivityPullRequest.list(decoded).first?.details == nil)
    }

    @Test func `the PR sheet lists only the checks that aren't zero, failed first`() {
        let rows = ChatActivityCheckRow.rows(self.checks("failing", failed: 1, running: 0, passed: 11))
        #expect(rows == [.init(kind: .failed, count: 1), .init(kind: .passed, count: 11)])
        let all = ChatActivityCheckRow.rows(self.checks("pending", failed: 2, running: 3, passed: 4))
        #expect(all.map(\.kind) == [.failed, .running, .passed])
        #expect(ChatActivityCheckRow.rows(self.checks("pending")).isEmpty)
        let details = OpenClawSessionPullRequestSnapshot.PullRequest(
            number: 4182,
            owner: "o",
            repo: "r",
            branch: "b",
            title: "T",
            url: "u",
            state: "open",
            additions: 214,
            deletions: 18)
        let pr = ChatActivityPullRequest.list(.init(pullRequests: [details]))[0]
        #expect(pr.summaryLine == "Open · o/r #4182 · +214 −18")
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
