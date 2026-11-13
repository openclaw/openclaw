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
        joinedClaw: Bool = false,
        markComplete: () -> Void,
        show: () -> Void,
        openDashboard: () -> Void = {})
    {
        // A Mac whose primary is its OpenClaw ID claw has nothing to set up here: the claw owns AI
        // and Gateway setup, which a member key cannot run. An unfinished first run (such as a join
        // interrupted before completion) finishes into the claw's dashboard.
        if joinedClaw {
            if !onboardingSeen {
                markComplete()
                openDashboard()
            }
        } else if connectionMode != .unconfigured, onboardingSeen {
            markComplete()
        } else if onboardingVersion < currentOnboardingVersion || !onboardingSeen {
            show()
        }
    }
}
