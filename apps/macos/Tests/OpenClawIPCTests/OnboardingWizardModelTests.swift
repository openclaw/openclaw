import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct OnboardingWizardModelTests {
    @Test func `skip wizard for legacy gateway auth config`() {
        let root: [String: Any] = [
            "gateway": [
                "auth": [
                    "token": "legacy-token",
                ],
            ],
        ]

        #expect(OnboardingWizardModel.shouldSkipWizard(root: root))
    }

    @Test func `do not skip wizard for empty config`() {
        #expect(OnboardingWizardModel.shouldSkipWizard(root: [:]) == false)
    }

    @Test func `node mode keeps connecting for configured installs after onboarding refresh`() {
        let root: [String: Any] = [
            "gateway": [
                "auth": [
                    "token": "legacy-token",
                ],
            ],
        ]

        #expect(
            MacNodeModeCoordinator.shouldConnectNodeMode(
                onboardingSeen: true,
                onboardingVersion: currentOnboardingVersion - 1,
                root: root))
        #expect(
            MacNodeModeCoordinator.shouldConnectNodeMode(
                onboardingSeen: false,
                onboardingVersion: 0,
                root: root))
    }

    @Test func `node mode blocks truly unconfigured installs until onboarding is current`() {
        #expect(
            MacNodeModeCoordinator.shouldConnectNodeMode(
                onboardingSeen: false,
                onboardingVersion: 0,
                root: [:]) == false)
        #expect(
            MacNodeModeCoordinator.shouldConnectNodeMode(
                onboardingSeen: true,
                onboardingVersion: currentOnboardingVersion,
                root: [:]))
    }
}
