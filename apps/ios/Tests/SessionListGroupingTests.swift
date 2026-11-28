import Foundation
import OpenClawChatUI
import Testing
@testable import OpenClaw

struct SessionListGroupingTests {
    private static func session(
        _ key: String,
        at time: Double,
        pinned: Bool = false,
        unread: Bool = false,
        running: Bool = false,
        status: String? = nil,
        category: String? = nil) -> OpenClawChatSessionEntry
    {
        var entry = OpenClawChatSessionEntry(key: key, updatedAt: time, label: key)
        entry.pinned = pinned
        entry.unread = unread
        entry.hasActiveRun = running
        entry.status = status
        entry.category = category
        return entry
    }

    private static func layout(_ sections: [SessionListSection]) -> [String] {
        sections.map { section in
            let name = switch section.id {
            case let .group(group): group.rawValue
            case let .category(name): "#\(name)"
            }
            return "\(name): \(section.sessions.map(\.key).joined(separator: ","))"
        }
    }

    @Test func `state wins over pinned and every session sits in one group`() {
        let sessions = [
            Self.session("approval", at: 1, pinned: true, running: true),
            Self.session("failed", at: 2, unread: true, status: "failed"),
            Self.session("seen-failure", at: 3, status: "failed"),
            Self.session("running-pinned", at: 4, pinned: true, running: true),
            Self.session("running", at: 5, running: true),
            Self.session("pinned", at: 6, pinned: true),
            Self.session("unread", at: 7, unread: true),
            Self.session("grouped", at: 8, category: "Work"),
            Self.session("old", at: 0),
        ]
        let sections = SessionListGrouping.sections(
            sessions,
            knownCategories: [],
            needsApproval: { $0.key == "approval" })
        #expect(Self.layout(sections) == [
            "needsYou: failed,approval",
            "working: running,running-pinned",
            "pinned: pinned",
            "#Work: grouped",
            "recent: unread,seen-failure,old",
        ])
    }

    @Test func `needs you and working show only with sessions, stored groups stay as move targets`() {
        let sections = SessionListGrouping.sections(
            [Self.session("a", at: 1)],
            knownCategories: ["Empty"],
            needsApproval: { _ in false })
        #expect(Self.layout(sections) == ["#Empty: ", "recent: a"])
    }

    private static func approval(_ preview: String) -> OpenClawChatAttentionRequest {
        OpenClawChatAttentionRequest(
            id: "a",
            kind: .approval,
            sessionKey: "s",
            agentID: "main",
            createdAtMs: 0,
            expiresAtMs: 1,
            preview: preview)
    }

    @Test func `one state line wins: approval, then failure, then subagents`() {
        var session = Self.session("s", at: 1, unread: true, status: "timeout")
        session.lastRunError = "Timed out after 30 min"
        session.hasActiveSubagentRun = true
        #expect(SessionListGrouping.stateLine(session, approval: Self.approval("gh pr merge 1 --squash"))
            == .needsApproval(command: "gh pr merge 1 --squash"))
        #expect(SessionListGrouping.stateLine(session, approval: Self.approval("  ")) == .needsApproval(command: nil))
        #expect(SessionListGrouping.stateLine(session, approval: nil) == .failed(reason: "Timed out after 30 min"))
        session.unread = false
        #expect(SessionListGrouping.stateLine(session, approval: nil) == .subagentsWorking)
        session.hasActiveSubagentRun = false
        session.hasActiveRun = true
        #expect(SessionListGrouping.stateLine(session, approval: nil) == nil)
        #expect(SessionRowActivityMark(session: session) == .working)
    }

    @Test func `a failure reason reads as one line without repeating Failed`() {
        let multiline = "⚠️ claude-opus is rate-limited.\n\nPick another model."
        #expect(SessionListGrouping.failureReason(multiline, status: "failed")
            == "claude-opus is rate-limited. Pick another model.")
        #expect(SessionListGrouping.failureReason("failed", status: "failed") == nil)
        #expect(SessionListGrouping.failureReason("timeout", status: "timeout") == nil)
        #expect(SessionListGrouping.failureReason(" \n ", status: "failed") == nil)
        #expect(SessionListGrouping.failureReason(nil, status: "failed") == nil)
    }

    @Test func `the header dot stays only for approvals the Needs you section does not list`() {
        let listed = Self.session("listed", at: 2)
        let sections = SessionListGrouping.sections(
            [listed, Self.session("other", at: 1)],
            knownCategories: [],
            needsApproval: { $0.key == "listed" })
        func request(_ key: String?) -> OpenClawChatAttentionRequest {
            OpenClawChatAttentionRequest(
                id: key ?? "none",
                kind: .approval,
                sessionKey: key,
                agentID: "main",
                createdAtMs: 0,
                expiresAtMs: 1,
                preview: "")
        }
        func dot(_ requests: [OpenClawChatAttentionRequest], _ sections: [SessionListSection]) -> Bool {
            SessionListGrouping.hasApprovalOutsideNeedsYou(requests, sections: sections) { $0.sessionKey == $1.key }
        }
        #expect(!dot([request("listed")], sections))
        #expect(dot([request("listed"), request("agent:main:subagent:hidden")], sections))
        #expect(!dot([request(nil)], sections))
        // A scoped list with no Needs you section (Snoozed, Archived, Automations) keeps the dot.
        #expect(dot([request("listed")], sections.filter { $0.id != .group(.needsYou) }))
    }

    @Test func `the Working section and all chat rows use the same run state`() {
        var session = Self.session("r", at: 1, pinned: true, unread: true, running: true, category: "Work")
        #expect(SessionListGrouping.placement(session, needsApproval: false) == .group(.working))
        #expect(SessionRowActivityMark(session: session) == .working)
        session.hasActiveRun = false
        session.hasActiveSubagentRun = true
        #expect(SessionRowActivityMark(session: session) == .working)
        session.hasActiveSubagentRun = false
        #expect(SessionRowActivityMark(session: session) == .unread)
        session.unread = false
        #expect(SessionRowActivityMark(session: session) == .none)
    }

    @Test func `a finger on the list holds moves until it lifts, while new rows still land`() {
        let before = [Self.session("a", at: 2, running: true), Self.session("b", at: 1)]
        let held = CommandSessionsScreen.placements(SessionListGrouping.sections(
            before, knownCategories: [], needsApproval: { _ in false }))
        let after = [Self.session("a", at: 3), Self.session("b", at: 1), Self.session("c", at: 4, running: true)]
        let sections = SessionListGrouping.sections(
            after,
            knownCategories: [],
            needsApproval: { _ in false },
            held: held)
        #expect(Self.layout(sections) == ["working: c,a", "recent: b"])
        let lifted = SessionListGrouping.sections(after, knownCategories: [], needsApproval: { _ in false })
        #expect(Self.layout(lifted) == ["working: c", "recent: a,b"])
    }
}
