import Foundation
import Testing
@testable import OpenClaw

@MainActor
struct OnboardingPageTests {
    @Test(arguments: [AppState.ConnectionMode.unconfigured, .local, .remote])
    func `verified node setup finishes without configuring or opening an operator connection`(
        existingMode: AppState.ConnectionMode) async throws
    {
        let state = AppState(preview: true)
        state.onboardingSeen = true
        state.connectionMode = existingMode
        var handoffs: [OnboardingDashboardHandoff] = []
        let view = OnboardingView(
            state: state,
            openClawIDService: NodeCompletionFixture(),
            dashboardHandoffOpener: { handoffs.append($0) })
        await view.beginNodeInvitation()?.value
        #expect(view.canAdvanceFromFind == (existingMode == .remote))
        #expect(view.findPageAdvanceDecision.shouldProbe == (existingMode == .remote))
        await view.openClawID.perform(.checkApproval)?.value
        try #require(view.canAdvanceFromFind)
        #expect(view.findPageAdvanceDecision == .init(canAdvance: true, shouldProbe: false))
        if existingMode == .remote, ProcessInfo.processInfo.environment["OPENCLAW_ONBOARDING_RENDER_DIR"] != nil {
            try OnboardingRenderTests.capture(
                view.navigationBar,
                name: "node-completion-navigation",
                label: "Verified node FIXTURE · unrelated remote primary · no live enrollment",
                output: OnboardingRenderTests.outputDirectory())
        }
        view.openClawID.cancel()
        #expect(view.canAdvanceFromFind)
        #expect(view.pageOrder == [0, 1, 4, 9])
        #expect(!view.isAISetupBlocking)
        #expect(state.connectionMode == existingMode)
        await view.beginNodeInvitation()?.value
        #expect(view.canAdvanceFromFind == (existingMode == .remote))
        #expect(view.findPageAdvanceDecision.shouldProbe == (existingMode == .remote))
        await view.openClawID.perform(.checkApproval)?.value
        #expect(view.canAdvanceFromFind)
        #expect(view.finish())
        #expect(handoffs.isEmpty)
    }

    @Test
    func `unavailable invitation entry preserves an existing browser completion`() {
        let view = OnboardingView(
            state: AppState(preview: true),
            openClawIDService: UnavailableOnboardingOpenClawIDService())
        view.savedBrowserGatewayName = "Existing browser Gateway"
        #expect(view.beginNodeInvitation() == nil)
        #expect(view.savedBrowserGatewayName == "Existing browser Gateway")
        #expect(view.canAdvanceFromFind)
    }

    @Test(arguments: zip([0, 1, 2, 3, 4, 5], [0, 1, 2, 2, 3, 4]))
    func `removing preparation preserves the semantic page instead of skipping AI`(cursor: Int, expected: Int) {
        #expect(OnboardingView.pageCursor(
            preserving: cursor, from: [0, 1, 2, 3, 5, 9], to: [0, 1, 3, 5, 9]) == expected)
    }

    @Test(arguments: zip([-1, 0, 1, 2, 3, Int.max], [0, 0, 1, 2, 2, 2]))
    func `pager stays on a visible page after the installed CLI page disappears`(cursor: Int, expected: Int) {
        // AI setup starts at cursor 3 while the CLI probe is pending. Once
        // installed, the three-page flow must still render its final page.
        #expect(OnboardingView.visiblePageCursor(cursor, pageCount: 3) == expected)
    }
}

@MainActor
private struct NodeCompletionFixture: OnboardingOpenClawIDService {
    let unavailableReason: String? = nil

    func start(_: OnboardingOpenClawIDIntent) async throws -> OnboardingOpenClawIDStep {
        .nodeConnection(claw: "node-fixture", connected: false)
    }

    func perform(_: OnboardingOpenClawIDAction) async throws -> OnboardingOpenClawIDStep {
        .nodeConnection(claw: "node-fixture", connected: true)
    }

    func cancel() {}
}
