import Foundation
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

    @Test func `joined claw finishes an unfinished first run into its dashboard`() {
        // Regression: a Mac joined over OpenClaw ID reopened setup on the AI page, whose
        // admin-only Gateway check its member key cannot pass, and Next stayed disabled.
        for seen in [false, true] {
            var events: [String] = []
            OnboardingFirstRun.presentIfNeeded(
                connectionMode: .remote,
                onboardingSeen: seen,
                onboardingVersion: 0,
                joinedClaw: true,
                markComplete: { events.append("complete") },
                show: { events.append("show") },
                openDashboard: { events.append("dashboard") })
            #expect(events == (seen ? [] : ["complete", "dashboard"]))
        }
    }

    @Test func `joined claw is only the remote primary the OpenClaw ID route serves`() {
        let serves: (URL) -> Bool = { $0.host == "claw.example" }
        #expect(MacOpenClawIDJoinCompletion.primaryIsJoinedClaw(
            mode: .remote, remoteUrl: "wss://claw.example", serves: serves))
        #expect(!MacOpenClawIDJoinCompletion.primaryIsJoinedClaw(
            mode: .remote, remoteUrl: "wss://other.example", serves: serves))
        #expect(!MacOpenClawIDJoinCompletion.primaryIsJoinedClaw(
            mode: .local, remoteUrl: "wss://claw.example", serves: serves))
    }

    @Test func `joined claw onboarding has no AI setup page`() {
        let aiSetup = OnboardingFirstRun.Page.aiSetup.rawValue
        #expect(!OnboardingView.pageOrder(for: .remote, requiresCLIInstall: false, joinedClaw: true)
            .contains(aiSetup))
        #expect(OnboardingView.pageOrder(for: .remote, requiresCLIInstall: false).contains(aiSetup))
    }

    @Test func `superseded dashboard open reads as reconnecting with OpenClaw ID guidance`() {
        // Regression: a joined Mac showed "Swift.CancellationError error 1" and SSH tunnel advice.
        let superseded = DashboardManager.failureCopy(error: CancellationError(), joinedClaw: true)
        #expect(superseded.title == "Reconnecting to the Gateway")
        #expect(!superseded.message.contains("CancellationError"))
        #expect(!superseded.detail.contains("Reset Remote Tunnel"))
        #expect(superseded.detail.contains("OpenClaw ID"))
        let failed = DashboardManager.failureCopy(error: URLError(.timedOut), joinedClaw: false)
        #expect(failed.title == "Dashboard unavailable")
        #expect(failed.detail.contains("Reset Remote Tunnel"))
    }

    @Test func `joining a claw closes setup before switching the primary, then opens the dashboard`() async {
        var events: [String] = []
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            MacOpenClawIDJoinCompletion.finish(
                claw: "claw.example",
                markOnboardingComplete: { events.append("complete") },
                closeOnboarding: { events.append("close") },
                selectPrimary: { events.append("primary:\($0)") },
                refreshEndpoint: { events.append("refresh") },
                openDashboard: {
                    events.append("dashboard")
                    done.resume()
                })
        }
        #expect(events == ["complete", "close", "primary:claw.example", "refresh", "dashboard"])
    }
}
