import OpenClawChatUI
import Testing
@testable import OpenClaw

struct CommandSessionGroupingTests {
    @Test func `groups pinned categories and ungrouped in display order`() {
        let sections = CommandSessionGrouping.sections(from: [
            self.entry("ungrouped", activity: 2),
            self.entry("beta", category: "Beta", activity: 3),
            self.entry("alpha-old", category: "Alpha", activity: 1),
            self.entry("pinned", category: "Beta", pinned: true, activity: 4),
            self.entry("alpha-new", category: "Alpha", activity: 5),
        ])

        #expect(sections.map(\.id) == [
            .pinned,
            .category("Alpha"),
            .category("Beta"),
            .ungrouped,
        ])
        #expect(sections[0].entries.map(\.key) == ["pinned"])
        #expect(sections[1].entries.map(\.key) == ["alpha-new", "alpha-old"])
        #expect(sections[3].showsHeader)
    }

    @Test func `hides ungrouped header without category sections`() {
        let sections = CommandSessionGrouping.sections(from: [self.entry("plain", activity: 1)])

        #expect(sections.count == 1)
        #expect(sections[0].id == .ungrouped)
        #expect(!sections[0].showsHeader)
    }

    @Test func `preview puts pinned sessions before recent activity`() {
        let entries = CommandSessionGrouping.previewOrder([
            self.entry("recent", activity: 20),
            self.entry("pinned-old", pinned: true, activity: 1),
            self.entry("older", activity: 10),
        ])

        #expect(entries.map(\.key) == ["pinned-old", "recent", "older"])
    }

    @Test func `preview selection keeps the open chat visible past the cap`() {
        let entries = [
            self.entry("a", activity: 40),
            self.entry("b", activity: 30),
            self.entry("c", activity: 20),
            self.entry("current", activity: 10),
        ]

        let selection = CommandSessionGrouping.previewSelection(entries, currentKey: "current")
        #expect(selection.map(\.key) == ["current", "a", "b"])

        // Natural order wins when the current session already fits the cap.
        let natural = CommandSessionGrouping.previewSelection(entries, currentKey: "a")
        #expect(natural.map(\.key) == ["a", "b", "c"])

        // Unknown or empty keys fall back to the plain capped ordering.
        let fallback = CommandSessionGrouping.previewSelection(entries, currentKey: "")
        #expect(fallback.map(\.key) == ["a", "b", "c"])
    }

    private func entry(
        _ key: String,
        category: String? = nil,
        pinned: Bool = false,
        activity: Double) -> OpenClawChatSessionEntry
    {
        OpenClawChatSessionEntry(
            key: key,
            kind: nil,
            displayName: nil,
            surface: nil,
            subject: nil,
            room: nil,
            space: nil,
            updatedAt: nil,
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
            category: category,
            pinned: pinned,
            lastActivityAt: activity)
    }
}
