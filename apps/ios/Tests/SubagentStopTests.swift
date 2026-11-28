import Foundation
import Testing
@testable import OpenClawChatUI

struct SubagentStopTests {
    @Test func `continuations keep their tab and pill until the child finishes`() {
        let key = "agent:main:subagent:sample"
        var row = OpenClawChatSessionEntry(key: key, status: "running")
        let snapshots: [(String?, String?, Bool, Bool)] = [
            ("running", "active", true, true), ("waiting", nil, false, true),
            ("done", "paused", false, true), ("running", "active", true, true),
            ("queued", "active", false, true), ("running", "active", true, true),
            ("done", "historical", true, true), ("unrecognized-state", nil, false, true),
            ("interrupted", "interrupted", false, true), (nil, nil, false, true),
            ("done", "unknown-lifecycle", false, true),
            ("done", "historical", false, false), ("completed", nil, false, false),
            ("stopped", nil, false, false), ("killed", "paused", true, false), ("failed", nil, true, false),
            ("timeout", nil, false, false),
        ]
        for (status, lifecycle, activeChildren, running) in snapshots {
            row.status = status
            row.subagentRunState = lifecycle
            row.hasActiveSubagentRun = activeChildren
            let children = ChatActivityChild.roster([row])
            #expect(children.filter(\.isWorking).count == (running ? 1 : 0))
            #expect(children.filter { !$0.isWorking }.count == (running ? 0 : 1))
            #expect(ChatActivityRules.pills(ChatActivityInput(children: children)).first?
                .avatarKeys == (running ? [key] : nil))
        }
    }

    @Test func `a paused child can be stopped without an active turn ID`() throws {
        var row = OpenClawChatSessionEntry(
            key: "agent:worker:subagent:paused",
            status: "done",
            activeRunIds: [],
            subagentRunState: "paused")
        row.sessionId = "sample-session"
        let target = try #require(OpenClawChildStopTarget(row))
        #expect(target.request.method == "sessions.abort")
        #expect(target.request.params["key"]?.value as? String == row.key)
        #expect(target.request.params["agentId"]?.value as? String == "worker")
        #expect(target.request.params["runId"] == nil)
        #expect(!target.allows(scopes: ["operator.read"]))
        row.subagentRunState = "active"
        row.status = "running"
        row.activeRunIds = nil
        #expect(try #require(OpenClawChildStopTarget(row)).request.params["runId"] == nil)
        row.subagentRunState = nil
        #expect(OpenClawChildStopTarget(row) == nil)
    }

    @Test func `exact child run and permission`() throws {
        var row = OpenClawChatSessionEntry(key: "agent:worker:subagent:child", status: "running", activeRunIds: ["run"])
        let target = try #require(OpenClawChildStopTarget(row))
        #expect(target.request.method == "sessions.abort")
        #expect(target.request.params["key"]?.value as? String == row.key)
        #expect(target.request.params["runId"]?.value as? String == "run")
        #expect(target.request.params["agentId"]?.value as? String == "worker")
        #expect(target.allows(scopes: ["operator.write"]))
        #expect(!target.allows(scopes: ["operator.read"]))
        #expect(!target.allows(scopes: ["operator.sessions.write"]))
        row.sharingRole = .owner
        #expect(try #require(OpenClawChildStopTarget(row)).allows(scopes: ["operator.sessions.write"]))
        row.activeRunIds = ["run", "other"]
        #expect(OpenClawChildStopTarget(row) == nil)
        row.activeRunIds = ["run"]
        row.status = "failed"
        #expect(OpenClawChildStopTarget(row) == nil)
    }

    @Test func `already finished is not confirmed stopped`() async throws {
        let row = OpenClawChatSessionEntry(key: "agent:main:subagent:test", status: "running", activeRunIds: ["run"])
        let action = try OpenClawChildStopAction(target: #require(OpenClawChildStopTarget(row))) {
            Data(#"{"ok":true,"abortedRunId":null,"status":"no-active-run"}"#.utf8)
        }
        #expect(try await action.perform().status == .noActiveRun)
    }
}
