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

    @Test func `the header carries the state, so a row drops the mark it would repeat`() {
        let running = Self.session("r", at: 1, running: true)
        #expect(SessionListGrouping.mark(running, needsApproval: false, in: .working) == .none)
        #expect(SessionListGrouping.mark(running, needsApproval: false, in: .recent) == .working)
        let failed = Self.session("f", at: 1, unread: true, status: "failed")
        #expect(SessionListGrouping.mark(failed, needsApproval: false, in: .needsYou) == .failed)
        #expect(SessionListGrouping.mark(running, needsApproval: true, in: .needsYou) == .needsApproval)
        #expect(SessionListGrouping.mark(Self.session("u", at: 1, unread: true), needsApproval: false, in: .recent) ==
            .unread)
    }

    @Test func `a row shows the spinner or the unread dot, never both`() {
        #expect(SessionRowActivityMark(isWorking: true, isUnread: true) == .working)
        #expect(SessionRowActivityMark(isWorking: false, isUnread: true) == .unread)
        #expect(SessionRowActivityMark(isWorking: false, isUnread: false) == .none)
        // The Gateway marks a session unread when its run starts; it shows no dot until the run stops.
        let running = Self.session("r", at: 1, unread: true, running: true)
        #expect(SessionListGrouping.mark(running, needsApproval: false, in: .recent) == .working)
        #expect(SessionListGrouping.mark(running, needsApproval: false, in: .working) == .none)
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
