import Testing
@testable import OpenClaw

@MainActor
struct OnboardingFirstRunTests {
    @Test(arguments: [AppState.ConnectionMode.unconfigured, .local, .remote])
    func `unseen first run presents native choice without marking onboarding complete`(mode: AppState.ConnectionMode) {
        var presented = false
        var completed = false
        OnboardingFirstRun.presentIfNeeded(
            connectionMode: mode,
            onboardingSeen: false,
            onboardingVersion: 0,
            markComplete: { completed = true },
            show: { presented = true })
        #expect(presented)
        #expect(!completed)
    }

    @Test(arguments: [AppState.ConnectionMode.unconfigured, .local, .remote])
    func `completed setup is not presented again including Set up later`(mode: AppState.ConnectionMode) {
        var presented = false
        OnboardingFirstRun.presentIfNeeded(
            connectionMode: mode,
            onboardingSeen: true,
            onboardingVersion: currentOnboardingVersion,
            markComplete: {},
            show: { presented = true })
        #expect(!presented)
    }
}
