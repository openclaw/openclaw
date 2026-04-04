import Testing
@testable import OpenClaw

struct HoverHUDPresentationTests {
    @Test func `cases CTA follows the current loop state`() {
        #expect(HoverHUDCasesPresentation.primaryActionTitle(activeCaseCount: 2, pendingTrialCount: 1) == "Review Open Cases")
        #expect(HoverHUDCasesPresentation.primaryActionTitle(activeCaseCount: 1, pendingTrialCount: 0) == "Review Focus Case")
        #expect(HoverHUDCasesPresentation.primaryActionTitle(activeCaseCount: 0, pendingTrialCount: 3) == "Review Trial Queue")
        #expect(HoverHUDCasesPresentation.primaryActionTitle(activeCaseCount: 0, pendingTrialCount: 0) == "Open Casebook")
    }

    @Test func `cases tab badge reflects open loops before queued trials`() {
        #expect(HoverHUDCasesPresentation.tabBadgeText(activeCaseCount: 3, pendingTrialCount: 2) == "3 Open")
        #expect(HoverHUDCasesPresentation.tabBadgeText(activeCaseCount: 1, pendingTrialCount: 0) == "Open")
        #expect(HoverHUDCasesPresentation.tabBadgeText(activeCaseCount: 0, pendingTrialCount: 2) == "Queued")
        #expect(HoverHUDCasesPresentation.tabBadgeText(activeCaseCount: 0, pendingTrialCount: 0) == nil)
    }

    @Test func `compact CTA prioritizes repair then supervision then chat`() {
        let linking = HoverHUDCompactPresentation.primaryAction(
            healthState: .linkingNeeded,
            activeCaseCount: 1,
            pendingTrialCount: 0,
            hasLiveActivity: true)
        #expect(linking.kind == .settings)
        #expect(linking.title == "Open Settings")

        let focusedCase = HoverHUDCompactPresentation.primaryAction(
            healthState: .ok,
            activeCaseCount: 1,
            pendingTrialCount: 0,
            hasLiveActivity: true)
        #expect(focusedCase.kind == .cases)
        #expect(focusedCase.title == "Review Case")

        let refresh = HoverHUDCompactPresentation.primaryAction(
            healthState: .unknown,
            activeCaseCount: 0,
            pendingTrialCount: 0,
            hasLiveActivity: false)
        #expect(refresh.kind == .refresh)
        #expect(refresh.title == "Refresh Status")

        let liveChat = HoverHUDCompactPresentation.primaryAction(
            healthState: .ok,
            activeCaseCount: 0,
            pendingTrialCount: 0,
            hasLiveActivity: true)
        #expect(liveChat.kind == .chat)
        #expect(liveChat.title == "Continue Chat")
    }

    @Test func `chat presentation teaches first click when the desk is quiet`() {
        #expect(
            HoverHUDChatPresentation.headline(
                hasLiveActivity: false,
                activeCaseCount: 0,
                pendingTrialCount: 0) == "Start in chat")
        #expect(
            HoverHUDChatPresentation.moodLine(
                hasLiveActivity: false,
                activeCaseCount: 0,
                pendingTrialCount: 0) == "Start here when the desk is quiet")
        #expect(
            HoverHUDChatPresentation.detail(
                hasLiveActivity: false,
                activeCaseCount: 0,
                pendingTrialCount: 0,
                currentLabel: nil) == "Open chat to begin a new supervision pass.")
    }

    @Test func `chat presentation stays contextual for live and case-driven states`() {
        #expect(
            HoverHUDChatPresentation.headline(
                hasLiveActivity: true,
                activeCaseCount: 0,
                pendingTrialCount: 0) == "Conversation stays in reach")
        #expect(
            HoverHUDChatPresentation.detail(
                hasLiveActivity: true,
                activeCaseCount: 0,
                pendingTrialCount: 0,
                currentLabel: "Main seat · Persona drift") == "Main seat · Persona drift")
        #expect(
            HoverHUDChatPresentation.headline(
                hasLiveActivity: false,
                activeCaseCount: 1,
                pendingTrialCount: 0) == "Chat can add context")
    }

    @Test func `chat secondary action follows state instead of always pointing at cases`() {
        let quiet = HoverHUDChatPresentation.secondaryAction(
            healthState: .ok,
            activeCaseCount: 0,
            pendingTrialCount: 0)
        #expect(quiet.kind == .refresh)
        #expect(quiet.title == "Check Pulse")

        let focusedCase = HoverHUDChatPresentation.secondaryAction(
            healthState: .ok,
            activeCaseCount: 1,
            pendingTrialCount: 0)
        #expect(focusedCase.kind == .cases)
        #expect(focusedCase.title == "Review Case")

        let linking = HoverHUDChatPresentation.secondaryAction(
            healthState: .linkingNeeded,
            activeCaseCount: 0,
            pendingTrialCount: 0)
        #expect(linking.kind == .settings)
        #expect(linking.title == "Open Settings")
    }
}
