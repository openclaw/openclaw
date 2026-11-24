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

    @Test func `retired claw opens recovery instead of first run or preferred experience after restart`() {
        for seen in [false, true] {
            var events: [String] = []
            OnboardingFirstRun.presentIfNeeded(
                connectionMode: .unconfigured,
                onboardingSeen: seen,
                onboardingVersion: 0,
                removedClaw: true,
                markComplete: { events.append("complete") },
                show: { events.append("show") },
                openDashboard: { events.append("dashboard") },
                showRemoval: { events.append("recovery") })
            #expect(events == ["recovery"])
        }
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

    @Test func `joining a claw commits the primary before completing setup and opening the dashboard`() async throws {
        var events: [String] = []
        try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
            do { try MacOpenClawIDJoinCompletion.finish(
                claw: "claw.example",
                markOnboardingComplete: { events.append("complete") },
                closeOnboarding: { events.append("close") },
                selectPrimary: { events.append("primary:\($0)") },
                refreshEndpoint: { events.append("refresh") },
                openDashboard: {
                    events.append("dashboard")
                    done.resume()
                }) } catch { done.resume(throwing: error) }
        }
        #expect(events == ["primary:claw.example", "complete", "close", "refresh", "dashboard"])
    }

    @Test func `failed migration preserves credentials and leaves join incomplete`() async throws {
        let configPath = TestIsolation.tempConfigPath()
        defer { try? FileManager.default.removeItem(atPath: configPath) }
        try await TestIsolation.withIsolatedState(env: ["OPENCLAW_CONFIG_PATH": configPath]) {
            let original: [String: Any] = ["gateway": ["mode": "remote", "remote": [
                "url": "wss://previous.example", "token": "existing-token", "password": "existing-password",
            ]]]
            try JSONSerialization.data(withJSONObject: original).write(to: URL(fileURLWithPath: configPath))
            var attempts = 0
            let state = AppState(preview: true, gatewayConfigSaver: { _, _ in
                attempts += 1
                return false
            })
            state._testEnableGatewayConfigSync()
            var effects: [String] = []
            #expect(throws: PrimaryGatewayControlError.persistenceFailed) {
                try MacOpenClawIDJoinCompletion.finish(
                    claw: "claw.example",
                    markOnboardingComplete: { effects.append("complete") },
                    closeOnboarding: { effects.append("close") },
                    selectPrimary: { try MacOpenClawIDJoinCompletion.selectPrimary($0, state: state) },
                    refreshEndpoint: { effects.append("refresh") },
                    openDashboard: { effects.append("dashboard") })
            }
            await Task.yield()
            #expect(attempts == 1)
            #expect(effects.isEmpty)
            #expect(state.remoteToken == "existing-token")
            #expect(state.remoteUrl == "wss://previous.example")
            let remote = (OpenClawConfigFile.loadDict()["gateway"] as? [String: Any])?["remote"] as? [String: Any]
            #expect(remote?["token"] as? String == "existing-token")
            #expect(remote?["password"] as? String == "existing-password")
        }
    }
}
