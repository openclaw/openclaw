import Foundation
import Testing
@testable import OpenClaw

struct CanvasDashboardSnapshotTests {
    @Test func `cron runs become compact dashboard cards`() {
        let nowMs = Int(Date().timeIntervalSince1970 * 1000)
        let entry = CronRunLogEntry(
            ts: nowMs,
            jobId: "daily-news",
            jobName: "Daily news brief",
            action: "run",
            status: "success",
            error: nil,
            summary: "Found three useful stories and prepared a short summary for the user.",
            runAtMs: nowMs,
            durationMs: 1420,
            nextRunAtMs: nil)

        let payload = CanvasDashboardSnapshot.build(
            gatewayLabel: "Running",
            gatewayCaption: "Local gateway is serving Canvas.",
            activeAgentName: "Main",
            talkLabel: "Standby",
            talkCaption: "Voice is ready.",
            cronRuns: [entry],
            localSource: nil,
            localSourceUpdatedAt: nil,
            now: Date(timeIntervalSince1970: TimeInterval(nowMs) / 1000))

        #expect(payload.cronRuns.first?.title == "Daily news brief")
        #expect(payload.cronRuns.first?.caption?.contains("Found three useful stories") == true)
        #expect(payload.today.contains { $0.kicker == "Automation" })
        #expect(payload.seriousSuggestion.title.contains("BlueBubbles"))
        #expect(payload.funSuggestion.title.contains("image generation"))
    }

    @Test func `failed cron run is promoted to attention`() {
        let nowMs = Int(Date().timeIntervalSince1970 * 1000)
        let entry = CronRunLogEntry(
            ts: nowMs,
            jobId: "sync",
            jobName: "Sync Notion",
            action: "run",
            status: "failed",
            error: "Token expired and needs attention.",
            summary: nil,
            runAtMs: nowMs,
            durationMs: 300,
            nextRunAtMs: nil)

        let payload = CanvasDashboardSnapshot.build(
            gatewayLabel: "Running",
            gatewayCaption: "Local gateway is serving Canvas.",
            activeAgentName: "Main",
            talkLabel: "Standby",
            talkCaption: "Voice is ready.",
            cronRuns: [entry],
            localSource: CanvasDashboardLocalSource(
                notion: [],
                today: [],
                attention: [],
                seriousSuggestion: nil,
                funSuggestion: nil),
            localSourceUpdatedAt: nil,
            now: Date(timeIntervalSince1970: TimeInterval(nowMs) / 1000))

        #expect(payload.nextLabel == "Check automation")
        #expect(payload.attention.first?.title == "Automation needs attention")
        #expect(payload.attention.first?.caption?.contains("Token expired") == true)
    }

    @Test func `local source freshness appears in today`() {
        let now = Date(timeIntervalSince1970: 1_700_000_600)
        let updatedAt = Date(timeIntervalSince1970: 1_700_000_300)
        let source = CanvasDashboardLocalSource(
            notion: [
                CanvasDashboardCard(
                    kicker: "Notion",
                    title: "Thomas Dashboard",
                    caption: "Pinned source",
                    status: nil,
                    badge: nil,
                    name: nil,
                    id: nil,
                    isActive: nil),
            ],
            today: [],
            attention: [],
            seriousSuggestion: nil,
            funSuggestion: nil)

        let payload = CanvasDashboardSnapshot.build(
            gatewayLabel: "Running",
            gatewayCaption: "Local gateway is serving Canvas.",
            activeAgentName: "Main",
            talkLabel: "Standby",
            talkCaption: "Voice is ready.",
            cronRuns: [],
            localSource: source,
            localSourceUpdatedAt: updatedAt,
            now: now)

        #expect(payload.today.contains { $0.kicker == "Notion sync" })
        #expect(payload.today.first { $0.kicker == "Notion sync" }?.caption?.contains("1 Notion cards") == true)
    }

    @Test func `open action queue items become attention and next action cards`() {
        let now = Date(timeIntervalSince1970: 1_700_000_600)
        let action = CanvasActionQueueItem(
            id: "act_1",
            title: "Draft the BlueBubbles summary",
            caption: "Turn the Notion article into a message that waits for approval.",
            kind: "draft",
            source: "notion",
            priority: "high",
            status: "open",
            createdAtMs: 1_700_000_000_000,
            updatedAtMs: 1_700_000_500_000,
            dueAtMs: nil,
            actionLabel: "Draft message")

        let payload = CanvasDashboardSnapshot.build(
            gatewayLabel: "Running",
            gatewayCaption: "Local gateway is serving Canvas.",
            activeAgentName: "Main",
            talkLabel: "Standby",
            talkCaption: "Voice is ready.",
            cronRuns: [],
            actionItems: [action],
            localSource: nil,
            localSourceUpdatedAt: nil,
            now: now)

        #expect(payload.nextLabel == "Draft message")
        #expect(payload.nextCaption.contains("BlueBubbles"))
        #expect(payload.attention.first?.id == "act_1")
        #expect(payload.attention.first?.kicker == "Notion")
        #expect(payload.actions.first?.title == "Draft the BlueBubbles summary")
    }
}
