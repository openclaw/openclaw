import Foundation
import Testing
@testable import OpenClawChatUI

@MainActor
struct ChatSessionSidebarModelTests {
    private func entry(
        key: String,
        displayName: String? = nil,
        updatedAt: Double? = nil,
        pinned: Bool? = nil,
        archived: Bool? = nil) -> OpenClawChatSessionEntry
    {
        OpenClawChatSessionEntry(
            key: key,
            kind: nil,
            displayName: displayName,
            surface: nil,
            subject: nil,
            room: nil,
            space: nil,
            updatedAt: updatedAt,
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
            pinned: pinned,
            archived: archived)
    }

    @Test func `pinned sessions get their own section, rest sorted by recency`() {
        let sections = ChatSessionSidebarModel.sections(
            sessions: [
                self.entry(key: "a", updatedAt: 100),
                self.entry(key: "b", updatedAt: 300, pinned: true),
                self.entry(key: "c", updatedAt: 200),
            ],
            currentSessionKey: "a",
            query: "")

        #expect(sections.map(\.id) == ["pinned", "recent"])
        #expect(sections[0].sessions.map(\.key) == ["b"])
        #expect(sections[1].sessions.map(\.key) == ["c", "a"])
        #expect(sections[1].title == "Recent")
    }

    @Test func `single unpinned section carries no title`() {
        let sections = ChatSessionSidebarModel.sections(
            sessions: [self.entry(key: "a", updatedAt: 100)],
            currentSessionKey: "a",
            query: "")

        #expect(sections.count == 1)
        #expect(sections[0].title == nil)
    }

    @Test func `hides onboarding and archived sessions, keeps the active one`() {
        let sections = ChatSessionSidebarModel.sections(
            sessions: [
                self.entry(key: "agent:main:onboarding", updatedAt: 500),
                self.entry(key: "gone", updatedAt: 400, archived: true),
                self.entry(key: "main", updatedAt: 300),
            ],
            currentSessionKey: "main",
            query: "")

        #expect(sections.flatMap(\.sessions).map(\.key) == ["main"])
    }

    @Test func `active session gets a placeholder row before lists load`() {
        let sections = ChatSessionSidebarModel.sections(
            sessions: [],
            currentSessionKey: "agent:main:main",
            query: "")

        #expect(sections.flatMap(\.sessions).map(\.key) == ["agent:main:main"])
    }

    @Test func `main aliases select the resolved row without adding a placeholder`() {
        let sessions = [self.entry(key: "agent:default:main", updatedAt: 100)]
        let sections = ChatSessionSidebarModel.sections(
            sessions: sessions,
            currentSessionKey: "main",
            mainSessionKey: "agent:default:main",
            activeAgentID: "default",
            query: "")

        #expect(sections.flatMap(\.sessions).map(\.key) == ["agent:default:main"])
        #expect(ChatSessionSidebarModel.selectedSessionKey(
            sessions: sessions,
            currentSessionKey: "main",
            mainSessionKey: "agent:default:main",
            activeAgentID: "default") == "agent:default:main")
    }

    @Test func `global aliases select their agent wrapped row`() {
        let sessions = [
            self.entry(key: "global", updatedAt: 200),
            self.entry(key: "agent:ops:global", updatedAt: 100, archived: true),
        ]
        let sections = ChatSessionSidebarModel.sections(
            sessions: sessions,
            currentSessionKey: "global",
            mainSessionKey: "agent:main:main",
            activeAgentID: "ops",
            query: "")

        #expect(ChatSessionSidebarModel.selectedSessionKey(
            sessions: sessions,
            currentSessionKey: "global",
            mainSessionKey: "agent:main:main",
            activeAgentID: "ops") == "agent:ops:global")
        #expect(sections.flatMap(\.sessions).map(\.key) == ["agent:ops:global"])
    }

    @Test func `query filters on display name and key`() {
        let sections = ChatSessionSidebarModel.sections(
            sessions: [
                self.entry(key: "agent:main:research", displayName: "Deep Research", updatedAt: 200),
                self.entry(key: "agent:main:main", updatedAt: 100),
            ],
            currentSessionKey: "agent:main:main",
            query: "research")

        #expect(sections.flatMap(\.sessions).map(\.key) == ["agent:main:research"])
    }

    @Test func `session keys render as human names`() {
        #expect(ChatSessionSidebarModel.displayName(forKey: "agent:main:main") == "main")
        #expect(ChatSessionSidebarModel.displayName(forKey: "agent:ops:standup") == "standup (ops)")
        #expect(ChatSessionSidebarModel.displayName(forKey: "global") == "global")
    }

    @Test func `display name prefers explicit names over key prettifying`() {
        let named = self.entry(key: "agent:main:x", displayName: "  Weekly Sync  ")
        #expect(ChatSessionSidebarModel.displayName(for: named) == "Weekly Sync")

        let unnamed = self.entry(key: "agent:main:x")
        #expect(ChatSessionSidebarModel.displayName(for: unnamed) == "x")
    }

    @Test func `delete excludes main aliases and allows ordinary or selected global sessions`() {
        let mainKey = "agent:default:main"

        #expect(!ChatSessionSidebarModel.canDeleteSession(key: "main", mainSessionKey: mainKey))
        #expect(!ChatSessionSidebarModel.canDeleteSession(key: "GLOBAL", mainSessionKey: mainKey))
        #expect(!ChatSessionSidebarModel.canDeleteSession(key: mainKey, mainSessionKey: mainKey))
        #expect(ChatSessionSidebarModel.canDeleteSession(key: "scratch", mainSessionKey: mainKey))
        #expect(ChatSessionSidebarModel.canDeleteSession(
            key: "agent:other:global",
            mainSessionKey: mainKey))
    }
}
