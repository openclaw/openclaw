import Foundation
import OpenClawDiscovery
import SwiftUI
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct OnboardingViewSmokeTests {
    @Test func `onboarding view builds body`() {
        let state = AppState(preview: true)
        let view = OnboardingView(
            state: state,
            permissionMonitor: PermissionMonitor.shared,
            discoveryModel: GatewayDiscoveryModel(localDisplayName: InstanceIdentity.displayName))
        _ = view.body
    }

    @Test func `page order omits workspace and identity steps`() {
        let order = OnboardingView.pageOrder(for: .local, showOnboardingChat: false)
        #expect(!order.contains(7))
        #expect(order.contains(3))
    }

    @Test func `page order omits onboarding chat when identity known`() {
        let order = OnboardingView.pageOrder(for: .local, showOnboardingChat: false)
        #expect(!order.contains(8))
    }

    @Test func `fresh installs require security acknowledgement before advancing`() {
        let defaults = UserDefaults.standard
        let previous = defaults.object(forKey: onboardingSecurityAcknowledgedKey)
        defaults.removeObject(forKey: onboardingSecurityAcknowledgedKey)
        defer {
            if let previous {
                defaults.set(previous, forKey: onboardingSecurityAcknowledgedKey)
            } else {
                defaults.removeObject(forKey: onboardingSecurityAcknowledgedKey)
            }
        }

        let freshState = AppState(preview: true)
        freshState.onboardingSeen = false
        let freshView = OnboardingView(
            state: freshState,
            permissionMonitor: PermissionMonitor.shared,
            discoveryModel: GatewayDiscoveryModel(localDisplayName: InstanceIdentity.displayName))

        #expect(freshView.isSecurityNoticeBlocking)
        #expect(!freshView.canAdvance)

        defaults.set(true, forKey: onboardingSecurityAcknowledgedKey)

        let acknowledgedState = AppState(preview: true)
        acknowledgedState.onboardingSeen = false
        let acknowledgedView = OnboardingView(
            state: acknowledgedState,
            permissionMonitor: PermissionMonitor.shared,
            discoveryModel: GatewayDiscoveryModel(localDisplayName: InstanceIdentity.displayName))

        #expect(!acknowledgedView.isSecurityNoticeBlocking)
        #expect(acknowledgedView.canAdvance)
    }

    @Test func `existing onboarded users keep their acknowledgement`() {
        #expect(OnboardingView.resolveSecurityNoticeAcknowledged(
            onboardingSeen: true,
            storedAcknowledgement: false))
        #expect(!OnboardingView.resolveSecurityNoticeAcknowledged(
            onboardingSeen: false,
            storedAcknowledgement: false))
    }

    @Test func `select remote gateway clears stale ssh target when endpoint unresolved`() async {
        let override = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-config-\(UUID().uuidString)")
            .appendingPathComponent("openclaw.json")
            .path

        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": override]) {
            let state = AppState(preview: true)
            state.remoteTransport = .ssh
            state.remoteTarget = "user@old-host:2222"
            let view = OnboardingView(
                state: state,
                permissionMonitor: PermissionMonitor.shared,
                discoveryModel: GatewayDiscoveryModel(localDisplayName: InstanceIdentity.displayName))
            let gateway = GatewayDiscoveryModel.DiscoveredGateway(
                displayName: "Unresolved",
                serviceHost: nil,
                servicePort: nil,
                lanHost: "txt-host.local",
                tailnetDns: "txt-host.ts.net",
                sshPort: 22,
                gatewayPort: 18789,
                cliPath: "/tmp/openclaw",
                stableID: UUID().uuidString,
                debugID: UUID().uuidString,
                isLocal: false)

            view.selectRemoteGateway(gateway)
            #expect(state.remoteTarget.isEmpty)
        }
    }
}
