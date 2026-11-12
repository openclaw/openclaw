import Foundation
import OpenClawChatUI
import Testing
@testable import OpenClaw

struct CommandCenterTabSessionFilterTests {
    @Test func `cached browsing scopes remain available offline while archives require a connection`() {
        #expect(SessionStatusScope.available(isConnected: false) == [.active, .snoozed, .automations])
        #expect(SessionStatusScope.available(isConnected: true) == [.active, .snoozed, .automations, .archived])
    }

    @Test @MainActor
    func `automation scope preserves selection without leaking archived sessions into active`() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let entries = try JSONDecoder().decode([OpenClawChatSessionEntry].self, from: Data("""
        [
          {"key":"agent:main:cron:daily"},
          {"key":"agent:main:cron:archived","archived":true},
          {"key":"conversation"},
          {"key":"agent:main:main"}
        ]
        """.utf8))
        func keys(_ scope: SessionStatusScope, selected: String? = nil) -> [String] {
            let currentKey = ChatSessionSidebarModel.selectedSessionKey(
                sessions: entries, currentSessionKey: selected ?? "", mainSessionKey: "main", activeAgentID: "main")
            return entries.filter {
                CommandCenterTab.isListedChatSession(
                    $0.key, mainSessionKey: "agent:main:main", defaultSessionKey: "main") &&
                    scope.includes($0, at: now, currentSessionKey: currentKey)
            }.map(\.key)
        }
        #expect(keys(.active) == ["conversation", "agent:main:main"])
        #expect(keys(.active, selected: "cron:daily") == ["agent:main:cron:daily", "conversation", "agent:main:main"])
        #expect(keys(.active, selected: "agent:main:cron:archived") == ["conversation", "agent:main:main"])
        #expect(keys(.automations) == ["agent:main:cron:daily"])
        #expect(keys(.archived) == ["agent:main:cron:archived"])
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

    @Test(arguments: ["main", "work"], [false, true]) @MainActor
    func `all sessions includes one existing main row without changing recent chats`(
        base: String, qualifiedMain: Bool) throws
    {
        let mainKey = "agent:one:\(base)"
        let configuredMain = qualifiedMain ? mainKey : base
        var main = OpenClawChatSessionEntry(key: mainKey, label: "Original topic")
        main.sessionId = "existing-main-history"
        let other = OpenClawChatSessionEntry(key: "agent:one:conversation", label: "Packing")
        let sessions = [
            main, other,
            OpenClawChatSessionEntry(key: "agent:two:\(base)"),
            OpenClawChatSessionEntry(key: "agent:one:\(base):thread:42"),
            OpenClawChatSessionEntry(key: "agent:one:node-device"),
        ] + (qualifiedMain ? [OpenClawChatSessionEntry(key: base)] : [])
        // The configured canonical row wins over its bare alias when both are present.
        let resolvedMain = ChatSessionSidebarModel.selectedSessionKey(
            sessions: sessions, currentSessionKey: configuredMain, mainSessionKey: configuredMain,
            activeAgentID: "one", sessionRoutingContract: "per-sender|\(base)|one")
        let listed = sessions.filter {
            CommandCenterTab.isListedChatSession(
                $0.key, mainSessionKey: resolvedMain, defaultSessionKey: configuredMain)
        }
        #expect(listed.map(\.key) == [mainKey, other.key])
        let row = try #require(listed.first { $0.key == resolvedMain })
        #expect(!CommandCenterTab.isRecentChatSession(row.key, defaultSessionKey: configuredMain))
        #expect(!ChatSessionSidebarModel.canDeleteSession(key: row.key, mainSessionKey: resolvedMain))
        #expect(!ChatSessionSidebarModel.canArchiveSession(row, mainSessionKey: resolvedMain))
        #expect(ChatSessionSidebarModel.canDeleteSession(key: other.key, mainSessionKey: resolvedMain))
        #expect(CommandCenterTab.sessionWorkItem(for: row, currentSessionKey: resolvedMain).state == "open")
        #expect(CommandCenterTab.sessionTitle(main) == "Original topic")
        #expect(CommandCenterTab.sessionTitle(other) == "Packing")
    }

    @Test(arguments: [true, false]) @MainActor
    func `custom main filtering retains the configured base with an incomplete roster`(mainPresent: Bool) {
        let main = OpenClawChatSessionEntry(key: "agent:one:work")
        let other = OpenClawChatSessionEntry(key: "agent:one:conversation")
        let sessions = (mainPresent ? [main] : []) + [
            other, OpenClawChatSessionEntry(key: "agent:one:work:thread:42"),
            OpenClawChatSessionEntry(key: "agent:two:work"),
        ]
        let resolvedMain = ChatSessionSidebarModel.selectedSessionKey(
            sessions: sessions, currentSessionKey: main.key, mainSessionKey: main.key, activeAgentID: "one")
        let listed = sessions.filter {
            CommandCenterTab.isListedChatSession($0.key, mainSessionKey: resolvedMain, defaultSessionKey: main.key)
        }
        #expect(listed.map(\.key) == (mainPresent ? [main.key, other.key] : [other.key]))
        let sidebar = RootSidebarModel.sections(
            sessions: sessions, query: "", currentSessionKey: other.key, mainSessionKey: main.key,
            activeAgentID: "one", groups: [], rosterIsComplete: mainPresent)
        #expect(!sidebar.flatMap(\.nodes).contains { $0.session.key == main.key })
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
