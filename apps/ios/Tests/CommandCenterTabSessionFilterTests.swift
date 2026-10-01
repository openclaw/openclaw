import Foundation
import OpenClawChatUI
import Testing
@testable import OpenClaw

struct CommandCenterTabSessionFilterTests {
    @Test func `cached browsing scopes remain available offline while archives require a connection`() {
        #expect(SessionStatusScope.available(isConnected: false) == [.active, .snoozed])
        #expect(SessionStatusScope.available(isConnected: true) == [.active, .snoozed, .archived])
    }

    @Test func `status scopes separate future snoozes and archives while expired snoozes return to active`() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let entries = try JSONDecoder().decode([OpenClawChatSessionEntry].self, from: Data("""
        [
          {"key":"awake"},
          {"key":"later","snoozedUntil":1800000060000},
          {"key":"expired","snoozedUntil":1799999999999},
          {"key":"boundary","snoozedUntil":1800000000000},
          {"key":"archived","archived":true},
          {"key":"archived-snooze","archived":true,"snoozedUntil":1800000060000}
        ]
        """.utf8))

        let active = entries.filter { SessionStatusScope.active.includes($0, at: now) }
        #expect(active.map(\.key) == ["awake", "expired", "boundary"])
        #expect(entries.filter { SessionStatusScope.snoozed.includes($0, at: now) }.map(\.key) == ["later"])
        #expect(entries.filter { SessionStatusScope.archived.includes($0, at: now) }.map(\.key) == [
            "archived", "archived-snooze",
        ])
        let sections = CommandSessionGrouping.sections(from: active)
        #expect(sections.flatMap(\.entries).map(\.key).sorted() == ["awake", "boundary", "expired"])
        #expect(CommandCenterTab.sessionDetail(entries[1], now: now).hasPrefix("Wakes "))
        #expect(!CommandCenterTab.sessionDetail(entries[2], now: now).hasPrefix("Wakes "))
    }

    @Test func `hides direct agent device sessions`() {
        #expect(!CommandCenterTab.isRecentChatSession("main", defaultSessionKey: "main"))
        #expect(!CommandCenterTab.isRecentChatSession("agent:main:main", defaultSessionKey: "main"))
        #expect(!CommandCenterTab.isRecentChatSession("agent:rust-claw:main", defaultSessionKey: "main"))
        #expect(!CommandCenterTab.isRecentChatSession("agent:main:node-0b88d67b7e42", defaultSessionKey: "main"))
        #expect(!CommandCenterTab.isRecentChatSession("agent:main:work", defaultSessionKey: "work"))
        #expect(!CommandCenterTab.isRecentChatSession("main", defaultSessionKey: "agent:rust-claw:work"))
        #expect(!CommandCenterTab.isRecentChatSession("global", defaultSessionKey: "agent:rust-claw:work"))
        #expect(!CommandCenterTab.isRecentChatSession("node-0b88d67b7e42", defaultSessionKey: "agent:rust-claw:work"))
        #expect(!CommandCenterTab.isRecentChatSession("work", defaultSessionKey: "agent:rust-claw:work"))
        #expect(!CommandCenterTab.isRecentChatSession("agent:main:work", defaultSessionKey: "agent:rust-claw:work"))
        #expect(!CommandCenterTab.isRecentChatSession("agent:main:main:thread:42", defaultSessionKey: "main"))
        #expect(!CommandCenterTab.isRecentChatSession("agent:support:main:thread:1234:42", defaultSessionKey: "main"))
        #expect(!CommandCenterTab.isRecentChatSession(
            "agent:main:node-0b88d67b7e42:thread:42",
            defaultSessionKey: "main"))
        #expect(!CommandCenterTab.isRecentChatSession("agent:main:work:thread:42", defaultSessionKey: "work"))
        #expect(!CommandCenterTab.isRecentChatSession(
            "agent:main:work:thread:42",
            defaultSessionKey: "agent:rust-claw:work"))
    }

    @Test func `keeps agent scoped channel and cron sessions`() {
        #expect(CommandCenterTab.isRecentChatSession(
            "agent:main:signal:direct:+15555550123",
            defaultSessionKey: "main"))
        #expect(CommandCenterTab.isRecentChatSession(
            "agent:rust-claw:mattermost:channel:abc123",
            defaultSessionKey: "main"))
        #expect(CommandCenterTab.isRecentChatSession(
            "agent:rust-claw:cron:3cd2eb6f-b8a5-4db7-b74a-f6a3f7eab3d3",
            defaultSessionKey: "main"))
        #expect(CommandCenterTab.isRecentChatSession(
            "agent:main:slack:channel:c1:thread:123",
            defaultSessionKey: "main"))
    }

    @Test func `prefers generated display names over ios key placeholders`() {
        func entry(
            key: String,
            displayName: String? = nil,
            label: String? = nil,
            autoLabel: String? = nil) -> OpenClawChatSessionEntry
        {
            OpenClawChatSessionEntry(
                key: key,
                kind: nil,
                displayName: displayName,
                surface: nil,
                subject: nil,
                room: nil,
                space: nil,
                updatedAt: 1,
                sessionId: nil,
                systemSent: nil,
                abortedLastRun: nil,
                thinkingLevel: nil,
                verboseLevel: nil,
                inputTokens: nil,
                outputTokens: nil,
                totalTokens: nil,
                modelProvider: nil,
                model: nil,
                contextTokens: nil,
                label: label,
                autoLabel: autoLabel)
        }

        #expect(
            CommandCenterTab.sessionTitle(
                entry(key: "agent:main:ios-abc123", displayName: "Compare session naming"))
                == "Compare session naming")
        #expect(CommandCenterTab.sessionTitle(entry(key: "agent:main:ios-abc123")) == "iOS chat")
        #expect(
            CommandCenterTab.sessionTitle(
                entry(
                    key: "agent:main:ios-abc123",
                    displayName: "Compare session naming",
                    label: "My thread"))
                == "My thread")

        let nodeKey = "agent:main:node-1234567890ab"
        let autoLabel = "OpenClaw App · Pixel · 1234567890ab"
        #expect(CommandCenterTab.sessionTitle(entry(key: nodeKey, autoLabel: autoLabel)) == autoLabel)
        #expect(
            CommandCenterTab.sessionTitle(
                entry(key: nodeKey, displayName: "Compare session naming", autoLabel: autoLabel))
                == "Compare session naming")
        let manualLabel = "OpenClaw App · Release planning · 1234567890ab"
        #expect(
            CommandCenterTab.sessionTitle(
                entry(key: nodeKey, displayName: "Compare session naming", label: manualLabel, autoLabel: autoLabel))
                == manualLabel)
    }
}
