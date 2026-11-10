import Foundation

/// Native first run asks where to run before any Gateway setup or dashboard handoff.
@MainActor
enum OnboardingFirstRun {
    enum Page: Int {
        case welcome = 0, connection = 1, runtime = 2, aiSetup = 3
    }

    static func presentIfNeeded(
        connectionMode: AppState.ConnectionMode,
        onboardingSeen: Bool,
        onboardingVersion: Int,
        markComplete: () -> Void,
        show: () -> Void)
    {
        if connectionMode != .unconfigured, onboardingSeen {
            markComplete()
        } else if onboardingVersion < currentOnboardingVersion || !onboardingSeen {
            show()
        }
    }
}
