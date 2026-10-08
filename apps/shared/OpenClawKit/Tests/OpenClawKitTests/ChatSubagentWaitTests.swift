import Foundation
import Testing
@testable import OpenClawChatUI

@Suite("ChatSubagentWait")
struct ChatSubagentWaitTests {
    private func session(
        _ key: String,
        running: Bool = false,
        helperRunning: Bool? = nil,
        parent: String? = nil) -> OpenClawChatSessionEntry
    {
        var entry = OpenClawChatSessionEntry(key: key)
        entry.hasActiveRun = running
        entry.hasActiveSubagentRun = helperRunning
        entry.parentSessionKey = parent
        return entry
    }

    @Test func `an idle chat with one running helper names that helper`() {
        let parent = self.session("parent", helperRunning: true)
        let sessions = [
            parent,
            self.session("child", running: true, parent: "parent"),
            self.session("other", running: true),
        ]
        let wait = ChatSubagentWait.resolve(session: parent, sessions: sessions, runActive: false)
        #expect(wait?.child?.key == "child")
        #expect(wait?.child?.name == "child")
    }

    @Test func `two running helpers are not named`() {
        let parent = self.session("parent", helperRunning: true)
        let sessions = [
            parent,
            self.session("a", running: true, parent: "parent"),
            self.session("b", running: true, parent: "parent"),
        ]
        let wait = ChatSubagentWait.resolve(session: parent, sessions: sessions, runActive: false)
        #expect(wait != nil)
        #expect(wait?.child == nil)
    }

    @Test func `no wait while the chat itself runs or when no helper runs`() {
        let waiting = self.session("parent", helperRunning: true)
        #expect(ChatSubagentWait.resolve(session: waiting, sessions: [waiting], runActive: true) == nil)
        let busy = self.session("parent", running: true, helperRunning: true)
        #expect(ChatSubagentWait.resolve(session: busy, sessions: [busy], runActive: false) == nil)
        let idle = self.session("parent")
        #expect(ChatSubagentWait.resolve(session: idle, sessions: [idle], runActive: false) == nil)
    }

    @Test func `unloaded children still show a generic wait`() {
        let parent = self.session("parent", helperRunning: true)
        let wait = ChatSubagentWait.resolve(session: parent, sessions: [parent], runActive: false)
        #expect(wait != nil)
        #expect(wait?.child == nil)
    }

    @Test func `archived sessions are not shown as waiting or as helpers`() {
        var parent = self.session("parent", helperRunning: true)
        parent.archived = true
        #expect(ChatSubagentWait.resolve(session: parent, sessions: [parent], runActive: false) == nil)
        parent.archived = false
        var child = self.session("child", running: true, parent: "parent")
        child.archived = true
        let wait = ChatSubagentWait.resolve(session: parent, sessions: [parent, child], runActive: false)
        #expect(wait != nil)
        #expect(wait?.child == nil)
    }

    @Test func `spawnedBy and childSessions identify helpers without a parent key`() {
        var parent = self.session("parent", helperRunning: true)
        var child = self.session("child", running: true)
        child.spawnedBy = "parent"
        #expect(ChatSubagentWait.resolve(session: parent, sessions: [parent, child], runActive: false)?.child?
            .key == "child")
        child.spawnedBy = nil
        parent.childSessions = ["child"]
        #expect(ChatSubagentWait.resolve(session: parent, sessions: [parent, child], runActive: false)?.child?
            .key == "child")
        child.parentSessionKey = "other"
        #expect(ChatSubagentWait.resolve(session: parent, sessions: [parent, child], runActive: false)?.child == nil)
    }

    @Test func `status-only helpers are named but terminal and explicitly idle helpers are not`() {
        let parent = self.session("parent", helperRunning: true)
        var child = self.session("child", parent: "parent")
        child.hasActiveRun = nil
        for status in ["running", "queued"] {
            child.status = status
            #expect(ChatSubagentWait.resolve(session: parent, sessions: [parent, child], runActive: false)?.child?
                .key == "child")
        }
        child.hasActiveRun = false
        #expect(ChatSubagentWait.resolve(session: parent, sessions: [parent, child], runActive: false)?.child == nil)
        child.hasActiveRun = true
        child.status = "done"
        #expect(ChatSubagentWait.resolve(session: parent, sessions: [parent, child], runActive: false)?.child == nil)
        var busyParent = parent
        busyParent.status = "running"
        busyParent.hasActiveRun = nil
        #expect(ChatSubagentWait.resolve(session: busyParent, sessions: [busyParent], runActive: false) == nil)
        #expect(ChatSubagentWait.resolve(session: nil, sessions: [], runActive: false) == nil)
    }
}
