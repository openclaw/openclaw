import OpenClawKit
import SwiftUI
import Testing
import UIKit
@testable import OpenClaw

@Suite struct SwiftUIRenderSmokeTests {
    @MainActor private static func host(_ view: some View, size: CGSize? = nil) -> UIWindow {
        let frame = CGRect(origin: .zero, size: size ?? UIScreen.main.bounds.size)
        let window = UIWindow(frame: frame)
        window.rootViewController = UIHostingController(rootView: view)
        window.makeKeyAndVisible()
        window.rootViewController?.view.setNeedsLayout()
        window.rootViewController?.view.layoutIfNeeded()
        return window
    }

    @Test @MainActor func settingsProTabBuildsAViewHierarchy() {
        let appModel = NodeAppModel()
        let gatewayController = GatewayConnectionController(appModel: appModel, startDiscovery: false)

        let root = SettingsProTab()
            .environment(appModel)
            .environment(appModel.voiceWake)
            .environment(gatewayController)

        _ = Self.host(root)
    }

    @Test @MainActor func settingsProTabBuildsInLightAndDarkMode() {
        for scheme in [ColorScheme.light, ColorScheme.dark] {
            let appModel = NodeAppModel()
            let gatewayController = GatewayConnectionController(appModel: appModel, startDiscovery: false)

            let root = SettingsProTab()
                .environment(appModel)
                .environment(appModel.voiceWake)
                .environment(gatewayController)
                .preferredColorScheme(scheme)

            _ = Self.host(root)
        }
    }

    @Test @MainActor func rootTabsBuildsDeviceOrientationShellMatrix() {
        for scenario in Self.rootTabsShellScenarios() {
            let appModel = NodeAppModel()
            let gatewayController = GatewayConnectionController(appModel: appModel, startDiscovery: false)

            let root = RootTabs()
                .environment(appModel)
                .environment(appModel.voiceWake)
                .environment(gatewayController)
                .environment(\.rootTabsUserInterfaceIdiomOverride, scenario.idiom)
                .environment(\.horizontalSizeClass, scenario.horizontalSizeClass)
                .environment(\.verticalSizeClass, scenario.verticalSizeClass)

            _ = Self.host(root, size: scenario.size)
        }
    }

    @Test @MainActor func rootTabsBuildGatewayStateViewHierarchies() {
        for appModel in Self.rootTabsGatewayStateModels() {
            let gatewayController = GatewayConnectionController(appModel: appModel, startDiscovery: false)

            let root = RootTabs()
                .environment(appModel)
                .environment(appModel.voiceWake)
                .environment(gatewayController)

            _ = Self.host(root)
        }
    }

    @Test @MainActor func gatewayTrustPromptAlertPresentsWhenPromptAppearsAfterInitialRender() async {
        let appModel = NodeAppModel()
        let gatewayController = Self.gatewayControllerWithCapturedTLSFingerprint(appModel: appModel)
        let root = Color.clear
            .gatewayTrustPromptAlert()
            .environment(gatewayController)

        let window = Self.host(root)
        await Self.triggerGatewayTrustPrompt(controller: gatewayController)
        await Self.waitForPresentedAlert(in: window)

        #expect(window.rootViewController?.presentedViewController is UIAlertController)
    }

    @Test @MainActor func rootPromptAlertStackPresentsGatewayTrustPrompt() async {
        let appModel = NodeAppModel()
        let gatewayController = Self.gatewayControllerWithCapturedTLSFingerprint(appModel: appModel)
        let root = Color.clear
            .gatewayTrustPromptAlert()
            .deepLinkAgentPromptAlert()
            .environment(appModel)
            .environment(gatewayController)

        let window = Self.host(root)
        await Self.triggerGatewayTrustPrompt(controller: gatewayController)
        await Self.waitForPresentedAlert(in: window)

        #expect(window.rootViewController?.presentedViewController is UIAlertController)
    }

    @Test @MainActor func rootPromptAlertStackStillPresentsDeepLinkPrompt() async throws {
        let appModel = NodeAppModel()
        appModel._test_setGatewayConnected(true)
        let gatewayController = Self.gatewayControllerWithCapturedTLSFingerprint(appModel: appModel)
        let root = Color.clear
            .gatewayTrustPromptAlert()
            .deepLinkAgentPromptAlert()
            .environment(appModel)
            .environment(gatewayController)

        let window = Self.host(root)
        let url = try #require(URL(string: "openclaw://agent?message=hello%20from%20deep%20link"))
        await appModel.handleDeepLink(url: url)
        await Self.waitForPresentedAlert(in: window)

        #expect(window.rootViewController?.presentedViewController is UIAlertController)
    }

    @MainActor private static func gatewayControllerWithCapturedTLSFingerprint(
        appModel: NodeAppModel)
        -> GatewayConnectionController
    {
        GatewayConnectionController(
            appModel: appModel,
            startDiscovery: false,
            tcpReachabilityProbe: { _, _, _, _ in true },
            tlsFingerprintProbe: { _ in .fingerprint("abc123") })
    }

    @MainActor private static func triggerGatewayTrustPrompt(controller: GatewayConnectionController) async {
        let host = "gateway-\(UUID().uuidString).example.com"
        let port = 18789
        let stableID = "manual|\(host.lowercased())|\(port)"
        defer { GatewayTLSStore.clearFingerprint(stableID: stableID) }
        GatewayTLSStore.clearFingerprint(stableID: stableID)
        await controller.connectManual(host: host, port: port, useTLS: true)
    }

    @Test @MainActor func phoneControlHubBuildsGatewayStateViewHierarchies() {
        for appModel in Self.rootTabsGatewayStateModels() {
            let root = RootTabsPhoneControlHub(
                groups: RootTabs.phoneControlGroups,
                initialDestination: nil,
                openRootDestination: { _ in })
                .environment(appModel)

            _ = Self.host(root)
        }
    }

    @Test @MainActor func phoneControlHubBuildsLandscapeCompactState() {
        let appModel = NodeAppModel()
        let root = RootTabsPhoneControlHub(
            groups: RootTabs.phoneControlGroups,
            initialDestination: nil,
            openRootDestination: { _ in })
            .environment(appModel)
            .environment(\.horizontalSizeClass, .regular)
            .environment(\.verticalSizeClass, .compact)

        _ = Self.host(root)
    }

    @Test @MainActor func routedSidebarScreensBuildOfflineStates() {
        let appModel = NodeAppModel()
        let screens: [AnyView] = [
            AnyView(CommandCenterTab(openChat: {}, openSettings: {})),
            AnyView(IPadActivityScreen(openChat: {}, openSettings: {})),
            AnyView(OpenClawDocsScreen()),
            AnyView(IPadWorkboardScreen(openChat: {}, openSettings: {})),
            AnyView(IPadSkillWorkshopScreen(openSettings: {})),
            AnyView(AgentProTab(directRoute: .agents)),
            AnyView(AgentProTab(directRoute: .instances)),
            AnyView(CommandSessionsScreen(openChat: {})),
            AnyView(AgentProTab(directRoute: .dreaming)),
            AnyView(AgentProTab(directRoute: .usage)),
            AnyView(AgentProTab(directRoute: .cron)),
        ]

        for screen in screens {
            let root = NavigationStack { screen }
                .environment(appModel)
            _ = Self.host(root)
        }
    }

    @Test @MainActor func taskScreensBuildPhoneLandscapeCompactStates() {
        let appModel = NodeAppModel()
        let screens: [AnyView] = [
            AnyView(IPadWorkboardScreen(openChat: {}, openSettings: {})),
            AnyView(IPadSkillWorkshopScreen(openSettings: {})),
        ]

        for screen in screens {
            let root = NavigationStack { screen }
                .environment(appModel)
                .environment(\.horizontalSizeClass, .regular)
                .environment(\.verticalSizeClass, .compact)

            _ = Self.host(root)
        }
    }

    @Test @MainActor func voiceWakeWordsViewBuildsAViewHierarchy() {
        let appModel = NodeAppModel()
        let root = NavigationStack { VoiceWakeWordsSettingsView() }
            .environment(appModel)
        _ = Self.host(root)
    }

    @Test @MainActor func voiceWakeToastBuildsAViewHierarchy() {
        let root = VoiceWakeToast(command: "openclaw: do something")
        _ = Self.host(root)
    }

    @MainActor private static func waitForPresentedAlert(in window: UIWindow) async {
        for _ in 0 ..< 10 {
            if window.rootViewController?.presentedViewController != nil { return }
            await Task.yield()
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
    }

    @MainActor private static func rootTabsGatewayStateModels() -> [NodeAppModel] {
        let offlineModel = NodeAppModel()

        let connectingModel = NodeAppModel()
        connectingModel.gatewayStatusText = "Connecting..."

        let connectedModel = NodeAppModel()
        connectedModel.enterAppleReviewDemoMode()

        let errorModel = NodeAppModel()
        errorModel.gatewayStatusText = "Gateway error: connection refused"

        return [offlineModel, connectingModel, connectedModel, errorModel]
    }

    private static func rootTabsShellScenarios() -> [RootTabsShellScenario] {
        [
            RootTabsShellScenario(
                idiom: .phone,
                size: CGSize(width: 393, height: 852),
                horizontalSizeClass: .compact,
                verticalSizeClass: .regular),
            RootTabsShellScenario(
                idiom: .phone,
                size: CGSize(width: 852, height: 393),
                horizontalSizeClass: .regular,
                verticalSizeClass: .compact),
            RootTabsShellScenario(
                idiom: .pad,
                size: CGSize(width: 1024, height: 1366),
                horizontalSizeClass: .regular,
                verticalSizeClass: .regular),
            RootTabsShellScenario(
                idiom: .pad,
                size: CGSize(width: 1366, height: 1024),
                horizontalSizeClass: .regular,
                verticalSizeClass: .regular),
        ]
    }

    private struct RootTabsShellScenario {
        let idiom: UIUserInterfaceIdiom
        let size: CGSize
        let horizontalSizeClass: UserInterfaceSizeClass
        let verticalSizeClass: UserInterfaceSizeClass
    }
}
