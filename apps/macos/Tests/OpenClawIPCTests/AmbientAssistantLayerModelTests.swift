import Testing
@testable import OpenClaw

struct AmbientAssistantLayerModelTests {
    @Test func `default snapshot is safe and local`() {
        let snapshot = AmbientAssistantSurfaceSnapshot.default

        #expect(snapshot.context.frontApp == "Current app")
        #expect(snapshot.context.permissionSummaries.contains("Screen: optional"))
        #expect(snapshot.capabilities.contains(where: { $0.id == "gateway.health" && $0.availability == .available }))
        #expect(snapshot.proposals.first?.approvalState == .notRequired)
        #expect(snapshot.receipt.summary == "No recent ambient actions")
        #expect(snapshot.liveCards.map(\.id) == ["chat", "schedule", "automation"])
    }

    @Test func `tone maps to symbol and status names`() {
        #expect(AmbientAssistantTone.ready.symbolName == "sparkles")
        #expect(AmbientAssistantTone.blocked.symbolName == "exclamationmark.triangle")
        #expect(AmbientAssistantTone.working.statusLabel == "Working")
    }

    @Test func `live inputs become proactive chat schedule and automation cards`() {
        let snapshot = AmbientAssistantSnapshotBuilder.makeSnapshot(inputs: AmbientAssistantLiveInputs(
            frontApp: "Xcode",
            sessionLabel: "agent:main:main session",
            gatewayLabel: "Gateway healthy",
            deviceLabel: "Mac local",
            permissionSummaries: ["Screen: granted", "Accessibility: granted"],
            chat: AmbientAssistantChatSummary(
                lastUserText: "Can you deploy this?",
                lastAssistantText: "I can build, verify, and deploy it now.",
                messages: [
                    AmbientAssistantChatMessage(role: .user, text: "Can you deploy this?", isPending: false),
                    AmbientAssistantChatMessage(role: .assistant, text: "I can build, verify, and deploy it now.", isPending: false),
                ],
                isAwaitingResponse: false,
                error: nil),
            schedule: AmbientAssistantScheduleSummary(
                authorizationLabel: "Calendar granted · Reminders granted",
                items: [
                    AmbientAssistantScheduleItem(title: "Standup", dueLabel: "Today 09:30", source: "Calendar"),
                    AmbientAssistantScheduleItem(title: "Send invoice", dueLabel: "Today", source: "Reminder"),
                ],
                error: nil),
            automation: AmbientAssistantAutomationSummary(
                schedulerLabel: "Cron enabled · 2 jobs",
                latestTitle: "Daily news brief",
                latestDetail: "5m ago: Sent digest to Thomas.",
                latestTone: .success,
                error: nil),
            workLabel: nil))

        #expect(snapshot.context.frontApp == "Xcode")
        #expect(snapshot.status.detail == "Ready for a prompt or slash command")
        #expect(snapshot.liveCards.map(\.id) == ["chat", "schedule", "automation"])
        #expect(snapshot.liveCards[0].detail.contains("I can build"))
        #expect(snapshot.liveCards[1].detail.contains("Standup"))
        #expect(snapshot.liveCards[2].detail.contains("Daily news brief"))
        #expect(snapshot.chatMessages.map(\.role) == [.user, .assistant])
        #expect(snapshot.chatMessages.last?.text == "I can build, verify, and deploy it now.")
        #expect(snapshot.receipt.summary == "Daily news brief")
    }

    @Test func `live inputs surface missing permissions and failed automation`() {
        let snapshot = AmbientAssistantSnapshotBuilder.makeSnapshot(inputs: AmbientAssistantLiveInputs(
            frontApp: "System Settings",
            sessionLabel: "main session",
            gatewayLabel: "Gateway local",
            deviceLabel: "Mac local",
            permissionSummaries: ["Screen: optional"],
            chat: AmbientAssistantChatSummary(
                lastUserText: "Ping",
                lastAssistantText: nil,
                messages: [
                    AmbientAssistantChatMessage(role: .user, text: "Ping", isPending: true),
                ],
                isAwaitingResponse: true,
                error: nil),
            schedule: AmbientAssistantScheduleSummary(
                authorizationLabel: "Calendar permission needed · Reminders permission needed",
                items: [],
                error: nil),
            automation: AmbientAssistantAutomationSummary(
                schedulerLabel: "Cron enabled · 3 jobs",
                latestTitle: "Sync Notion",
                latestDetail: "2m ago: Token expired.",
                latestTone: .error,
                error: nil),
            workLabel: "Running tool browser.open"))

        #expect(snapshot.status.detail == "Running tool browser.open")
        #expect(snapshot.status.tone == .working)
        #expect(snapshot.liveCards[0].tone == .working)
        #expect(snapshot.chatMessages.first?.isPending == true)
        #expect(snapshot.liveCards[1].tone == .waitingForApproval)
        #expect(snapshot.liveCards[2].tone == .error)
        #expect(snapshot.proposals.first?.title == "Review failed automation")
    }
}
