import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawChatUI

#if os(macOS)
@MainActor struct ChatSessionHoverCardProjectionTests {
    private func row(_ fields: String) throws -> OpenClawChatSessionEntry {
        try JSONDecoder().decode(OpenClawChatSessionEntry.self, from: Data(fields.utf8))
    }

    @Test func `attribution uses creator and distinct participants without self`() throws {
        let row = try self.row(#"""
        {"key":"agent:main:release-plan","owner":{"actor":{"type":"human","id":"assigned","label":"Assigned owner"}},
         "createdActor":{"type":"human","id":"creator","label":"Ada","identity":{"type":"profile","id":"ada"}},
         "participants":[{"identity":{"type":"profile","id":"stale"},"label":"Old page"}],
         "expandedParticipants":[{"identity":{"type":"profile","id":"ada"},"label":"Ada"},
          {"identity":{"type":"profile","id":"viewer"},"label":"Me"},
          {"identity":{"type":"profile","id":"bob"},"label":"Bob"},
          {"identity":{"type":"profile","id":"bob"},"label":"Duplicate"}],"participantCount":5}
        """#)
        let attribution = try #require(ChatSessionHoverCardProjection.attribution(row, selfID: "viewer"))
        #expect(attribution.primary.label == "Ada")
        #expect(attribution.primaryIsCreator)
        #expect(attribution.others.map(\.label) == ["Bob"])
        #expect(attribution.participantCount == 3)
        #expect(attribution.visibleOthers.map(\.label) == ["Bob"])
        #expect(attribution.hiddenAvatarCount == 2)
        var withoutCreator = row
        withoutCreator.createdActor = try JSONDecoder().decode(
            OpenClawChatSessionEntry.CreatedActor.self,
            from: Data(#"{"type":"system"}"#.utf8))
        let fallback = try #require(ChatSessionHoverCardProjection.attribution(withoutCreator, selfID: "viewer"))
        #expect(fallback.primary.label == "Ada")
        #expect(!fallback.primaryIsCreator)
        #expect(fallback.others.map(\.label) == ["Bob"])
        #expect(fallback.participantCount == 3)
    }

    @Test(arguments: [
        (59499.0, "59s"), (59500.0, "1m"), (3_570_000.0, "1h"),
        (86_400_000.0, "1d"), (604_800_000.0, "1w"), (2_419_200_000.0, "1mo"), (31_536_000_000.0, "1y"),
    ]) func `creation age uses web calendar and nested rounding`(milliseconds: Double, expected: String) {
        // No clock wait: the reference time is fixed and the formatter's English contract is explicit.
        guard Locale.current.language.languageCode?.identifier == "en" else { return }
        #expect(ChatSessionHoverCardProjection
            .age(0, now: Date(timeIntervalSince1970: milliseconds / 1000)) == expected)
    }

    @Test func `channel origin rejects foreign metadata and opaque direct I ds`() throws {
        let row = try self.row(#"""
        {"key":"agent:main:whatsapp:direct:+15555550123","label":"Contact","channel":"whatsapp","chatType":"direct",
         "origin":{"provider":"whatsapp","nativeDirectUserId":"opaque@lid","from":"opaque@lid","label":"Contact"},
         "deliveryContext":{"channel":"whatsapp","accountId":"work"}}
        """#)
        let channel = try #require(ChatSessionHoverCardProjection.channel(row))
        #expect(channel.label == "WhatsApp")
        #expect(channel.details == ["Direct chat", "Via work"])
        var foreign = row
        foreign.origin = ["provider": .init("telegram"), "label": .init("Foreign label"), "threadId": .init(99)]
        foreign.deliveryContext = ["channel": .init("telegram"), "accountId": .init("Foreign account")]
        #expect(ChatSessionHoverCardProjection.channel(foreign)?.details == ["Direct chat", "+15555550123"])
    }

    @Test func `channel topics and addresses retain wire identity`() throws {
        let telegram = try self.row(#"""
        {"key":"agent:main:telegram:group:-42:topic:7","label":"Ship release","channel":"telegram","chatType":"group",
         "origin":{"provider":"telegram","label":"Research id:-42 topic:7","threadId":7,"accountId":"personal"}}
        """#)
        #expect(ChatSessionHoverCardProjection.channel(telegram)?.details == [
            "Topic 7",
            "Research",
            "Via personal",
        ])
        let matrix = try self.row(#"""
        {"key":"agent:main:matrix:direct:@alex:example.test","label":"Alex","channel":"matrix","chatType":"direct"}
        """#)
        #expect(ChatSessionHoverCardProjection.channel(matrix)?.details == ["Direct chat", "@alex:example.test"])
        let local = try self.row(#"""
        {"key":"agent:main:main","channel":"telegram","origin":{"provider":"telegram","label":"Delivery only"}}
        """#)
        #expect(ChatSessionHoverCardProjection.channel(local) == nil)
    }

    @Test func `workspace uses repository identity and preserves remote locality`() throws {
        var row = try self.row(#"""
        {"key":"agent:main:release-plan","execNode":"remote","execCwd":"/work/project",
         "worktree":{"repoRoot":"/unrelated/local","branch":"openclaw/stale"},
         "repository":{"url":"https://example.test/team/project.git","branch":"openclaw/remote"}}
        """#)
        #expect(ChatSessionHoverCardProjection.context(row).map(\.text) == ["project", "openclaw/remote"])
        #expect(ChatSessionHoverCardProjection.context(row).first?.detail == "Project: /work/project")
        #expect(ChatSessionHoverCardProjection.context(row).first?.label == "Project: project")
        row.repository = nil
        #expect(ChatSessionHoverCardProjection.context(row).map(\.text) == ["project"])
        row.execNode = nil
        row.spawnedCwd = "/local/task"
        #expect(ChatSessionHoverCardProjection.context(row).map(\.text) == ["local", "stale"])
    }

    @Test func `channel fallback normalizes declared name before matching recorded origin`() throws {
        let row = try self.row(#"""
        {"key":"custom:direct:peer","channel":" WhatsApp ","chatType":"direct","accountId":"work",
         "origin":{"provider":"whatsapp","from":"15555550123@s.whatsapp.net"}}
        """#)
        #expect(ChatSessionHoverCardProjection.channel(row)?.details == ["Direct chat", "+15555550123", "Via work"])
    }

    @Test func `progress prefers running then pending and pauses prior run steps`() throws {
        var row = try self
            .row(#"{"key":"agent:main:release-plan","status":"running","hasActiveRun":true,"startedAt":1000}"#)
        let card = try JSONDecoder().decode(ProgressCard.self, from: Data(#"""
        {"sessionKey":"agent:main:release-plan","revision":3,"updatedAt":2000,"markdown":"Ready",
         "steps":[{"step":"Earlier","status":"completed"},{"step":"Next","status":"pending"},
                  {"step":"Current","status":"in_progress"}]}
        """#.utf8))
        let active = try #require(ChatSessionHoverCardProjection.headsUp(card, session: row))
        #expect(active.step == "Current")
        #expect(active.completed == 1 && active.total == 3 && !active.paused)
        row.status = "done"
        #expect(ChatSessionHoverCardProjection.headsUp(card, session: row) == nil)
        row.startedAt = 3000
        #expect(ChatSessionHoverCardProjection.headsUp(card, session: row)?.paused == true)
        row.status = "running"
        row.startedAt = 1000
        row.hasActiveRun = false
        #expect(ChatSessionHoverCardProjection.headsUp(card, session: row)?.paused == true)
    }

    @Test func `notepad presence suppresses preview while errors stay independent`() throws {
        let row = try self
            .row(#"{"key":"agent:main:release-plan","label":"Release plan","lastMessagePreview":"  Latest answer  "}"#)
        let card = try JSONDecoder().decode(ProgressCard.self, from: Data(#"""
        {"sessionKey":"agent:main:release-plan","revision":1,"updatedAt":2000,"markdown":"  "}
        """#.utf8))
        let absent = ChatSessionHoverCardProjection.copy(row, card: nil, error: "Build failed")
        #expect(absent.title == "Release plan" && absent.preview == "Latest answer")
        #expect(absent.error == "Build failed" && absent.notepad == nil)
        let blank = ChatSessionHoverCardProjection.copy(row, card: card, error: "Build failed")
        #expect(blank.preview == nil && blank.notepad == nil && blank.error == "Build failed")
    }

    @Test func `card preserves PR order while menu prefers active work and links describe checks and diff`() throws {
        let snapshot = try JSONDecoder().decode(OpenClawSessionPullRequestSnapshot.self, from: Data(#"""
        {"pullRequests":[{"number":42,"owner":"team","repo":"project","branch":"release","title":"Merged change",
         "url":"https://github.com/team/project/pull/42","state":"merged","additions":8,"deletions":3,
         "checks":{"state":"passing","passed":2,"failed":0,"skipped":0,"running":0}},
         {"number":43,"owner":"team","repo":"project","branch":"next","title":"Next change",
         "url":"https://github.com/team/project/pull/43","state":"open"}],"rateLimited":true,"status":"rate-limited"}
        """#.utf8))
        #expect(snapshot.pullRequests.first?.number == 42)
        #expect(snapshot.menuPullRequest?.number == 43)
        #expect(snapshot.pullRequests.first?.accessibilityLabel ==
            "Pull request #42, Merged, Merged change, CI checks passing, +8, −3")
        #expect(ChatSessionHoverCardProjection.pullRequestNotice(snapshot.status)?.contains("out of date") == true)
        #expect(ChatSessionHoverCardProjection.pullRequestNotice("ready") == nil)
    }
}
#endif
