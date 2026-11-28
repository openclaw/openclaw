import Foundation
import OpenClawChatUI
import Testing
@testable import OpenClaw

@MainActor
struct RootSearchRankingTests {
    private static func page(_ title: String, kind: RootSearchPage.Kind = .page) -> RootSearchPage {
        RootSearchPage(id: title, title: title, systemImage: "doc", kind: kind, target: .newChat)
    }

    private static func session(_ key: String, label: String, updatedAt: Double) -> OpenClawChatSessionEntry {
        OpenClawChatSessionEntry(key: key, updatedAt: updatedAt, label: label)
    }

    @Test func `pages rank exact then prefix then contains, alphabetical inside a rank`() {
        let base = ["Skill Workshop", "Usage", "Sessions"].map { Self.page($0) }
        let catalog = ["Skills", "speech skills", "Azure skill", "skill"].map { Self.page($0, kind: .skill) }
        let titles = RootSearchRanking.pages(base: base, catalog: catalog, query: "skill").map(\.title)
        #expect(titles == ["skill", "Skill Workshop", "Skills", "Azure skill", "speech skills"])
    }

    @Test func `catalog matches stop at ten while commands are never cut`() {
        let catalog = (0..<14).map { Self.page("Plugin \($0)", kind: .plugin) }
        let pages = RootSearchRanking.pages(base: [Self.page("Plugins")], catalog: catalog, query: "plugin")
        #expect(pages.count == 11)
        #expect(pages.first?.title == "Plugins")
    }

    @Test func `sessions put an exact title first, then the most recent`() {
        let sessions = [
            Self.session("a", label: "Speech practice", updatedAt: 3),
            Self.session("b", label: "speech", updatedAt: 1),
            Self.session("c", label: "Wedding speech draft", updatedAt: 5),
            Self.session("d", label: "Grocery list", updatedAt: 9),
        ]
        #expect(RootSearchRanking.sessions(sessions, query: "Speech").map(\.key) == ["b", "c", "a"])
    }

    @Test func `messages skip sessions already found by title and keep one row per session`() {
        let sessions = [
            Self.session("a", label: "Trip plan", updatedAt: 1),
            Self.session("b", label: "Grocery list", updatedAt: 2),
            Self.session("c", label: "Speech notes", updatedAt: 3),
        ]
        let hits = [
            RootSearchTranscriptHit(sessionKey: "a", snippet: "turn on  speech\nfor walking", score: 0.4),
            RootSearchTranscriptHit(sessionKey: "b", snippet: "add items by speech", score: 0.9),
            RootSearchTranscriptHit(sessionKey: "a", snippet: "second hit", score: 0.3),
            RootSearchTranscriptHit(sessionKey: "c", snippet: "speech", score: 1),
            RootSearchTranscriptHit(sessionKey: "missing", snippet: "speech", score: 2),
        ]
        let messages = RootSearchRanking.messages(hits: hits, sessions: sessions, excluding: ["c"])
        #expect(messages.map(\.session.key) == ["b", "a"])
        #expect(messages.last?.snippet == "turn on speech for walking")
    }

    @Test func allResultsShowPagesThenSessionsThenMessages() {
        var results = RootSearchScreen.Results(
            pages: [Self.page("Notes")],
            sessions: [Self.session("a", label: "Notes", updatedAt: 2)],
            messages: [RootSearchMessage(session: Self.session("b", label: "Draft", updatedAt: 1), snippet: "Notes")],
            messagePhase: .done)
        #expect(results.allSections == [.pages, .sessions, .messages])
        results.pages.removeAll()
        #expect(results.allSections == [.sessions, .messages])
    }

    @Test func `a tab shows a number only above zero once its search returned`() {
        #expect(RootSearchRanking.tabCount(0, isSettled: true) == nil)
        #expect(RootSearchRanking.tabCount(3, isSettled: false) == nil)
        #expect(RootSearchRanking.tabCount(3, isSettled: true) == 3)
    }

    @Test func `the message search reports loading from the first keystroke it will ask about`() {
        let model = RootSearchModel()
        model.query = "s"
        #expect(model.messagePhase == .idle)
        model.query = "sp"
        #expect(model.messagePhase == .loading)
        model.setOffline(true)
        #expect(model.messagePhase == .idle)
    }
}
