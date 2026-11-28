import Foundation
import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClawChatUI

struct ChatActivityTests {
    @MainActor @Test(arguments: [false, true])
    func childStaysWorkingAcrossSessionWindows(loaded: Bool) async throws {
        let parentKey = "agent:main:dashboard:parent"
        let child = OpenClawChatSessionEntry(
            key: "agent:main:subagent:paused", parentSessionKey: parentKey,
            status: "done", hasActiveRun: false, hasActiveSubagentRun: false, subagentRunState: "paused")
        let parent = OpenClawChatSessionEntry(key: parentKey, childSessions: [child.key])
        let rows = [parent] + (1...100).map { OpenClawChatSessionEntry(key: "other-" + String($0)) } + [child]
        let transport = TestChatTransport(historyResponses: [], listSessionsHook: { query in
            let page = Array(rows.prefix(query.limit ?? rows.count))
            return .init(ts: nil, path: nil, count: page.count, totalCount: rows.count,
                         hasMore: page.count < rows.count, defaults: nil, sessions: page)
        }, listChildSessionsHook: { _ in .init(rows: [child], isComplete: true) })
        let model = OpenClawChatViewModel(sessionKey: parentKey, transport: transport)
        func workingKeys() -> [String] {
            let input = model.activityInput(approvalPending: false, showsProgress: false)
            return ChatActivityRules.pills(input).first { $0.kind == .subagents }?.avatarKeys ?? []
        }

        await model.fetchSessions(limit: 200)
        if loaded { await model.loadActivityChildren(model.activityChildrenRequest) }
        let wide = workingKeys()
        let wideSheet = model.activityChildren.roster.map(\.state)
        let refresh = try #require(model.handleTransportEvent(.sessionsChanged(
            .init(sessionKey: child.key, reason: "subagent-status"))))
        await refresh.value
        let narrow = workingKeys()
        let narrowSheet = model.activityChildren.roster.map(\.state)
        #expect(!model.sessions.contains { $0.key == child.key })
        await model.fetchSessions(limit: 200)
        #expect([wide, narrow, workingKeys()] == [[child.key], [child.key], [child.key]])
        #expect([wideSheet, narrowSheet, model.activityChildren.roster.map(\.state)] == [[.waiting], [.waiting], [.waiting]])
    }

    @MainActor @Test func scopedChildListPopulatesAndRetiresOffWindowChildren() async {
        actor Replies {
            var calls = 0
            func next(parent: String) throws -> OpenClawChatChildSessionsResult {
                self.calls += 1
                if self.calls == 2 { throw URLError(.timedOut) }
                let child = OpenClawChatSessionEntry(
                    key: "child", parentSessionKey: parent, status: "done", subagentRunState: "paused")
                return .init(rows: self.calls == 1 ? [child] : [], isComplete: true)
            }
        }
        let replies = Replies()
        let model = OpenClawChatViewModel(sessionKey: "parent", transport: TestChatTransport(
            historyResponses: [], listChildSessionsHook: { try await replies.next(parent: $0) }))
        let request = model.activityChildrenRequest
        await model.loadActivityChildren(request)
        #expect(model.activityInput(approvalPending: false, showsProgress: false).children.map(\.state) == [.waiting])
        await model.loadActivityChildren(request)
        #expect(model.activityChildren.load == .failed)
        #expect(model.activityChildren.roster.map(\.state) == [.waiting])
        await model.loadActivityChildren(request)
        #expect(model.activityChildren.load == .complete)
        #expect(model.activityChildren.roster.isEmpty)
    }

    private func child(_ key: String, _ state: ChatActivityChild.State) -> ChatActivityChild {
        ChatActivityChild(key: key, name: key, state: state, startedAt: nil, endedAt: nil, runtimeMs: nil, order: 0)
    }

    private func goal(_ status: OpenClawChatSessionGoal.Status = .active) -> OpenClawChatSessionGoal {
        OpenClawChatSessionGoal(id: "g1", objective: "Ship the trip plan", status: status, createdAt: 0, updatedAt: 0)
    }

    #if os(iOS)
    @Test func goalSheetOnlyShowsProgressForABudget() throws {
        func goal(budget: Double?, used: Double = 12000) -> OpenClawChatSessionGoal {
            OpenClawChatSessionGoal(
                id: "g1",
                objective: "Write the plan",
                status: .active,
                createdAt: 0,
                updatedAt: 0,
                tokensUsed: used,
                tokenBudget: budget)
        }
        let budget = try #require(ChatGoalBudget(goal(budget: 50000)))
        #expect(budget.label == "12k of 50k tokens")
        #expect(budget.fraction == 0.24)
        #expect(ChatGoalBudget(goal(budget: 1000))?.fraction == 1)
        #expect(ChatGoalBudget(goal(budget: nil)) == nil)
    }
    #endif

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
        let input = ChatActivityInput(children: [self.child("a", .done), self.child("b", .stopped)])
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

    @Test func `the subagents pill leads with the working children's avatars and sweeps its label`() throws {
        let input = try ChatActivityInput(
            children: ["a", "b", "c", "d"].map { self.child($0, .working) } + [self.child("e", .done)],
            goal: self.goal(),
            plan: self.plan([.inProgress]),
            pullRequests: self.pullRequests(["open"]))
        let pills = ChatActivityRules.pills(input)
        #expect(pills[0].avatarKeys == ["a", "b", "c"])
        #expect(pills[0].label == "4 working")
        #expect(pills.map(\.shimmers) == [true, false, false, false])
        // Each child keeps the web's hue (FNV-1a over UTF-16, mod 360).
        #expect(ChatSubagentAvatarColors.hue("agent:main:subagent:activity-flights") == 311)
        #expect(ChatSubagentAvatarColors.hue("agent:main:subagent:activity-hotels") == 291)
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

    @Test func `goal requests retain the target and send only fields the method accepts`() {
        for action: OpenClawChatGoalMutation.Action in [.pause, .resume, .edit("New plan"), .clear] {
            let mutation = OpenClawChatGoalMutation(
                action: action,
                sessionKey: "agent:main:test",
                agentID: "main",
                sessionID: "s1",
                goalID: "g1")
            let request = mutation.request
            #expect(request.method == (action == .clear ? "sessions.goal.clear" : "sessions.goal.update"))
            #expect(request.params["action"]?.stringValue == (action == .clear ? nil : action.name))
            #expect(request.params["objective"]?.stringValue == (action == .edit("New plan") ? "New plan" : nil))
            #expect(request.params["sessionKey"]?.stringValue == "agent:main:test")
            #expect(request.params["agentId"]?.stringValue == "main")
            #expect(request.params["sessionId"]?.stringValue == "s1")
            #expect(request.params["goalId"]?.stringValue == "g1")
            #expect(request.params["operationId"]?.stringValue == mutation.operationID)
            #expect(request.params["issuedAtMs"]?.value is Int64)
            #expect(request == mutation.request)
        }
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

    @Test func `the PR pill shows live check rollups separately from lifecycle`() {
        let running = self.pill("open", checks: self.checks("pending", running: 4, passed: 8))
        #expect(running.label == "#7")
        #expect(running.pullRequestState == .open)
        #expect(running.checkMark == .running)
        #expect(self.pill("open", checks: self.checks("failing", failed: 1)).checkMark == .failed)
        #expect(self.pill("open", checks: self.checks("passing")).checkMark == nil)
        #expect(self.pill("draft", checks: nil).checkMark == nil)
        let merged = self.pill("merged", checks: self.checks("failing", failed: 1))
        #expect(merged.pullRequestState == .merged)
        #expect(merged.checkMark == nil)
        let stale = self.pill("open", checks: self.checks("failing", failed: 1), status: "unavailable")
        #expect(stale.checkMark == nil)
        #expect(stale.accessibilityLabel.contains("Couldn’t update"))
    }

    @Test func `a passing PR announces its checks without drawing a mark`() {
        let pill = self.pill("draft", checks: self.checks("passing", passed: 12))
        #expect(pill.checkMark == nil)
        #expect(pill.accessibilityLabel == "Pull request #7 in o/r, T, Draft, Checks passed")
    }

    @Test func `a published PR without verified details is listed once and claims no state`() throws {
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
        #expect(locked.pullRequestState == nil)
        #expect(locked.checkMark == nil)
        #expect(locked.accessibilityLabel.contains("Details unavailable"))
        #expect(list[1].title == nil)
        #expect(list[1].branch == "x")
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
        #expect(all.map(\.label).joined(separator: ", ") == "2 failed, 3 running, 4 passed")
        #expect(ChatActivityCheckRow.rows(self.checks("pending")).isEmpty)
        let skipped = OpenClawSessionPullRequestSnapshot.Checks(
            state: "passing",
            passed: 0,
            failed: 0,
            skipped: 2,
            running: 0)
        #expect(ChatActivityCheckRow.rows(skipped) == [.init(kind: .skipped, count: 2)])
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
        var activity = ChatActivityChildren()
        activity.observe(page: [late, other, early, parent, swarm], parentKey: parent.key, advertised: [])
        let children = activity.roster
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

    @Test func `chat message text never shows OpenClaw's internal context`() {
        func user(_ text: String) -> OpenClawChatMessage {
            OpenClawChatMessage(role: "user", content: [.init(type: "text", text: text)], timestamp: 1)
        }
        let wrapped = """
        [Wed 2026-11-25 19:06 PST] <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>
        [Subagent Context] You are running as a subagent.
        <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>
        nested
        <<<END_OPENCLAW_INTERNAL_CONTEXT>>>
        <<<END_OPENCLAW_INTERNAL_CONTEXT>>>

        Draft the packing list.

        <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>
        Begin.
        <<<END_OPENCLAW_INTERNAL_CONTEXT>>>
        """
        #expect(ChatMessageVisibleText.visibleText(in: user(wrapped)) == "Draft the packing list.")
        let onlyContext = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nTask setup\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>"
        #expect(ChatMessageVisibleText.visibleText(in: user(onlyContext)).isEmpty)
        // Text that only mentions a delimiter mid-line stays as written.
        let quoted = "Why does <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> show up?"
        #expect(ChatMessageVisibleText.visibleText(in: user(quoted)) == quoted)
    }

    @Test func `truncated internal context stays out of chat message text`() {
        func user(_ text: String) -> OpenClawChatMessage {
            OpenClawChatMessage(role: "user", content: [.init(type: "text", text: text)], timestamp: 1)
        }
        // Literal first line in the iPhone screenshot, intentionally without a closing delimiter.
        let openingLine = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>"
        for fragment in [openingLine, openingLine + "\nPrivate task setup"] {
            let truncated = user(fragment)
            #expect(ChatMessageVisibleText.visibleText(in: truncated).isEmpty)
        }
        // The escaped spelling is not a delimiter: an authored quotation must not erase the rest of a message.
        let literal = "[[OPENCLAW_INTERNAL_CONTEXT_BEGIN]]\nThis is a quoted example."
        #expect(ChatMessageVisibleText.visibleText(in: user(literal)) == literal)
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
