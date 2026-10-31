import Foundation
import Testing
@testable import OpenClawChatUI

struct ChatSessionSidebarSnapshotTests {
    @Test(arguments: ["patch", "lifecycle"])
    func `event rows retain omitted session selection and thinking metadata`(reason: String) throws {
        let previous = try self.profiledSession()
        let change = try self.event("""
        {"reason":"\(reason)","phase":"start","session":{
          "key":"agent:main:work","kind":"direct","sessionId":"work-id","updatedAt":200,
          "label":"New label","hasActiveRun":true,"activeRunIds":["run-2"],"status":"running"}}
        """)
        let session = try #require(ChatSessionSidebarModel.applying(
            sessionChange: change, to: [previous])?.first)
        #expect(session.label == "New label")
        #expect(session.model == "session-model")
        #expect(session.modelProvider == "session-provider")
        #expect(session.agentRuntime == previous.agentRuntime)
        #expect(session.thinkingLevels == previous.thinkingLevels)
        #expect(session.thinkingOptions == previous.thinkingOptions)
        #expect(session.thinkingDefault == "high")
        #expect(session.derivedTitle == "Retained title")
        let profile = try #require(OpenClawChatThinkingProfile.resolve(session: session, defaults: nil, model: nil))
        #expect(profile.defaultLevel == "high")
        #expect(profile.levels == previous.thinkingLevels)
    }

    @Test(arguments: ["model", "modelProvider", "agentRuntime", "sessionId"])
    func `changed selection or incarnation does not retain stale thinking capabilities`(field: String) throws {
        let sessionID = field == "sessionId" ? "replacement" : "work-id"
        let value = field == "agentRuntime" ? #"{"id":"replacement"}"# : #""replacement""#
        let selection = field == "sessionId" ? "" : ",\"\(field)\":\(value)"
        let change = try self.event("""
        {"reason":"patch","session":{"key":"agent:main:work","kind":"direct",
          "sessionId":"\(sessionID)"\(selection),"updatedAt":200}}
        """)
        let session = try #require(try ChatSessionSidebarModel.applying(
            sessionChange: change, to: [self.profiledSession()])?.first)
        #expect(session.thinkingLevels == nil)
        #expect(session.thinkingOptions == nil)
        #expect(session.thinkingDefault == nil)
        if field == "sessionId" { #expect(session.model == nil) }
    }

    @Test func `present nulls clear event metadata while omitted fields remain retained`() throws {
        let change = try self.event("""
        {"reason":"patch","session":{"key":"agent:main:work","kind":"direct","sessionId":"work-id",
          "updatedAt":200,"label":null,"thinkingLevels":null,"thinkingOptions":null,"thinkingDefault":null}}
        """)
        let session = try #require(try ChatSessionSidebarModel.applying(
            sessionChange: change, to: [self.profiledSession()])?.first)
        #expect(session.label == nil)
        #expect(session.model == "session-model")
        #expect(session.thinkingLevels == nil)
        #expect(session.thinkingOptions == nil)
        #expect(session.thinkingDefault == nil)
    }

    @Test func `outer clearing tombstones survive row projection and event replay`() throws {
        var previous = try self.profiledSession()
        previous.icon = "book"
        previous.category = "Research"
        previous.snoozedUntil = 1800003600000
        let change = try self.event("""
        {"sessionKey":"agent:main:work","reason":"patch",
          "label":null,"icon":null,"category":null,"snoozedUntil":null,
          "session":{"key":"agent:main:work","kind":"direct",
            "sessionId":"work-id","updatedAt":200}}
        """)
        let replayed = try JSONDecoder().decode(
            OpenClawChatSessionsChangedEvent.self, from: JSONEncoder().encode(change))
        for event in [change, replayed] {
            let session = try #require(ChatSessionSidebarModel.applying(
                sessionChange: event, to: [previous])?.first)
            #expect(session.label == nil)
            #expect(session.icon == nil)
            #expect(session.category == nil)
            #expect(session.snoozedUntil == nil)
            #expect(session.model == previous.model)
            #expect(session.modelProvider == previous.modelProvider)
            #expect(session.agentRuntime == previous.agentRuntime)
            #expect(session.thinkingLevels == previous.thinkingLevels)
            #expect(session.thinkingDefault == previous.thinkingDefault)
        }
    }

    @Test func `new model may supply its own thinking capabilities`() throws {
        let change = try self.event("""
        {"reason":"patch","session":{"key":"agent:main:work","kind":"direct","sessionId":"work-id",
          "updatedAt":200,"model":"new-model","thinkingOptions":["off"],"thinkingDefault":"off"}}
        """)
        let session = try #require(try ChatSessionSidebarModel.applying(
            sessionChange: change, to: [self.profiledSession()])?.first)
        #expect(session.thinkingLevels == nil)
        #expect(session.thinkingOptions == ["off"])
        #expect(session.thinkingDefault == "off")
    }

    @Test func `event replay retains omitted fields and explicit nulls`() throws {
        let change = try self.event("""
        {"reason":"patch","session":{"key":"agent:main:work","kind":"direct","sessionId":"work-id",
          "updatedAt":200,"label":null,"thinkingDefault":null}}
        """)
        let replayed = try JSONDecoder().decode(
            OpenClawChatSessionsChangedEvent.self, from: JSONEncoder().encode(change))
        #expect(replayed.sessionFields == change.sessionFields)
        let session = try #require(try ChatSessionSidebarModel.applying(
            sessionChange: replayed, to: [self.profiledSession()])?.first)
        #expect(session.label == nil)
        #expect(session.thinkingDefault == nil)
        #expect(session.model == "session-model")
        #expect(try session.thinkingLevels == (self.profiledSession()).thinkingLevels)
    }

    private func event(_ json: String) throws -> OpenClawChatSessionsChangedEvent {
        try JSONDecoder().decode(OpenClawChatSessionsChangedEvent.self, from: Data(json.utf8))
    }

    private func profiledSession() throws -> OpenClawChatSessionEntry {
        var session = OpenClawChatSessionEntry(
            key: "agent:main:work",
            kind: "direct",
            updatedAt: 100,
            sessionId: "work-id",
            modelProvider: "session-provider",
            model: "session-model",
            thinkingLevels: [.init(id: "high", label: "High")],
            thinkingOptions: ["high"],
            thinkingDefault: "high",
            label: "Old label")
        session.agentRuntime = try JSONDecoder().decode(
            OpenClawChatAgentRuntime.self, from: Data(#"{"id":"session-runtime"}"#.utf8))
        session.derivedTitle = "Retained title"
        return session
    }

    @Test func `complete session snapshots replace metadata and fence retained observer state`() throws {
        var previous = OpenClawChatSessionEntry(key: "agent:main:work", updatedAt: 100)
        previous.kind = "direct"
        previous.sessionId = "work-id"
        previous.label = "Old label"
        previous.status = "running"
        previous.activeRunIds = ["run-1"]
        previous.observerDigest = .init(
            runId: "run-1", revision: 4, updatedAt: 400, headline: "Live", health: "grinding")
        var row = previous
        row.label = "New label"
        row.category = "Research"
        row.pinned = true
        row.observerDigest = nil
        let changed = try #require(ChatSessionSidebarModel.applying(
            sessionChange: .init(sessionKey: row.key, session: row), to: [previous]))
        #expect(changed[0].label == "New label")
        #expect(changed[0].category == "Research")
        #expect(changed[0].pinned == true)
        #expect(changed[0].observerDigest?.headline == "Live")

        row.status = "completed"
        row.hasActiveRun = false
        row.activeRunIds = []
        let completed = try #require(ChatSessionSidebarModel.applying(
            sessionChange: .init(sessionKey: row.key, session: row), to: changed))
        #expect(completed[0].observerDigest == nil)
        row.sessionId = "replacement-id"
        row.status = "running"
        row.activeRunIds = ["run-1"]
        let replacement = try #require(ChatSessionSidebarModel.applying(
            sessionChange: .init(sessionKey: row.key, session: row), to: changed))
        #expect(replacement[0].observerDigest == nil)
        row.activeRunIds = nil
        let unavailable = try #require(ChatSessionSidebarModel.applying(
            sessionChange: .init(sessionKey: row.key, session: row), to: changed))
        #expect(unavailable[0].activeRunIds == nil)
        #expect(unavailable[0].observerDigest == nil)
    }

    @Test func `global snapshots reject foreign observer digests`() throws {
        var previous = OpenClawChatSessionEntry(
            key: "global", kind: "direct", agentId: "main", updatedAt: 100, sessionId: "global-id")
        previous.status = "running"
        previous.activeRunIds = ["run-1"]
        previous.observerDigest = .init(
            agentId: "main", runId: "run-1", revision: 4, updatedAt: 400, headline: "Main", health: "grinding")
        var row = previous
        row.agentId = "work"
        row.observerDigest = nil
        let changed = try #require(ChatSessionSidebarModel.applying(
            sessionChange: .init(sessionKey: row.key, agentId: "work", session: row),
            to: [previous],
            activeAgentId: "work"))
        #expect(changed[0].agentId == "work")
        #expect(changed[0].observerDigest == nil)
    }

    @Test func `global row snapshots clear a digest from a foreign owner`() throws {
        var previous = OpenClawChatSessionEntry(
            key: "global", kind: "direct", agentId: "main", updatedAt: 100, sessionId: "global-id")
        previous.status = "running"
        previous.activeRunIds = ["run-1"]
        var row = previous
        row.observerDigest = .init(
            agentId: "other", runId: "run-1", revision: 4, updatedAt: 400, headline: "Foreign", health: "grinding")
        let changed = try #require(ChatSessionSidebarModel.applying(
            sessionChange: .init(sessionKey: row.key, agentId: "main", session: row),
            to: [previous],
            activeAgentId: "main"))
        #expect(changed[0].observerDigest == nil)
    }
}
