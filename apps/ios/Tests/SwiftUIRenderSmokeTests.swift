import OpenClawKit
import SwiftUI
import Testing
import UIKit
@testable import OpenClaw

struct SwiftUIRenderSmokeTests {
    @MainActor private static func host(_ view: some View, size: CGSize? = nil) -> UIWindow {
        let frame = CGRect(origin: .zero, size: size ?? UIScreen.main.bounds.size)
        let window = UIWindow(frame: frame)
        window.rootViewController = UIHostingController(rootView: view)
        window.makeKeyAndVisible()
        window.rootViewController?.view.setNeedsLayout()
        window.rootViewController?.view.layoutIfNeeded()
        return window
    }

    @Test @MainActor func `settings pro tab builds A view hierarchy`() {
        let appModel = NodeAppModel()
        let gatewayController = GatewayConnectionController(appModel: appModel, startDiscovery: false)

        let root = SettingsProTab()
            .environment(AppAppearanceModel())
            .environment(appModel)
            .environment(appModel.voiceWake)
            .environment(gatewayController)

        _ = Self.host(root)
    }

    @Test @MainActor func `settings pro tab builds in light and dark mode`() {
        for scheme in [ColorScheme.light, ColorScheme.dark] {
            let appModel = NodeAppModel()
            let gatewayController = GatewayConnectionController(appModel: appModel, startDiscovery: false)

            let root = SettingsProTab()
                .environment(AppAppearanceModel())
                .environment(appModel)
                .environment(appModel.voiceWake)
                .environment(gatewayController)
                .preferredColorScheme(scheme)

            _ = Self.host(root)
        }
    }

    @Test @MainActor func `settings About destination builds in light and dark mode`() {
        for scheme in [ColorScheme.light, ColorScheme.dark] {
            let appModel = NodeAppModel()
            let gatewayController = GatewayConnectionController(appModel: appModel, startDiscovery: false)

            let root = SettingsProTab(directRoute: .about)
                .environment(AppAppearanceModel())
                .environment(appModel)
                .environment(appModel.voiceWake)
                .environment(gatewayController)
                .preferredColorScheme(scheme)

            _ = Self.host(root, size: CGSize(width: 393, height: 852))
        }
    }

    @Test @MainActor func `settings Licenses destination builds in light and dark mode`() {
        var windows: [UIWindow] = []
        defer { windows.forEach { $0.isHidden = true } }

        for scheme in [ColorScheme.light, ColorScheme.dark] {
            let appModel = NodeAppModel()
            let gatewayController = GatewayConnectionController(appModel: appModel, startDiscovery: false)

            let root = SettingsProTab(directRoute: .licenses)
                .environment(AppAppearanceModel())
                .environment(appModel)
                .environment(appModel.voiceWake)
                .environment(gatewayController)
                .preferredColorScheme(scheme)

            windows.append(Self.host(root, size: CGSize(width: 393, height: 852)))
        }
    }

    @Test @MainActor func `settings pro tab appearance row builds for all preferences`() throws {
        for preference in AppAppearancePreference.allCases {
            let suiteName = "OpenClawTests.appearance.\(preference.rawValue).\(UUID().uuidString)"
            let defaults = try #require(UserDefaults(suiteName: suiteName))
            defer { defaults.removePersistentDomain(forName: suiteName) }
            defaults.set(preference.rawValue, forKey: AppAppearancePreference.storageKey)

            let appModel = NodeAppModel()
            let gatewayController = GatewayConnectionController(appModel: appModel, startDiscovery: false)

            let root = SettingsProTab()
                .defaultAppStorage(defaults)
                .environment(AppAppearanceModel(userDefaults: defaults))
                .environment(appModel)
                .environment(appModel.voiceWake)
                .environment(gatewayController)

            _ = Self.host(root)
        }
    }

    @Test @MainActor func `hosted push relay disclosure builds A view hierarchy`() {
        for typeSize in [DynamicTypeSize.large, .accessibility5] {
            let root = HostedPushRelayDisclosureSheet(
                message: "Enabling this sends delivery data through OpenClaw's hosted push relay.",
                onContinue: {})
                .environment(\.dynamicTypeSize, typeSize)

            _ = Self.host(root, size: CGSize(width: 402, height: 450))
        }
    }

    @Test @MainActor func `root tabs builds device orientation shell matrix`() {
        for scenario in Self.rootTabsShellScenarios() {
            let appModel = NodeAppModel()
            let gatewayController = GatewayConnectionController(appModel: appModel, startDiscovery: false)

            let root = RootTabs()
                .environment(AppAppearanceModel())
                .environment(appModel)
                .environment(appModel.voiceWake)
                .environment(gatewayController)
                .environment(\.rootTabsUserInterfaceIdiomOverride, scenario.idiom)
                .environment(\.horizontalSizeClass, scenario.horizontalSizeClass)
                .environment(\.verticalSizeClass, scenario.verticalSizeClass)

            _ = Self.host(root, size: scenario.size)
        }
    }

    @Test @MainActor func `root tabs build gateway state view hierarchies`() {
        for appModel in Self.rootTabsGatewayStateModels() {
            let gatewayController = GatewayConnectionController(appModel: appModel, startDiscovery: false)

            let root = RootTabs()
                .environment(AppAppearanceModel())
                .environment(appModel)
                .environment(appModel.voiceWake)
                .environment(gatewayController)

            _ = Self.host(root)
        }
    }

    @Test @MainActor func `gateway trust prompt alert presents when prompt appears after initial render`() async {
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

    @Test @MainActor func `root prompt alert stack presents gateway trust prompt`() async {
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

    @Test @MainActor func `root prompt alert stack still presents deep link prompt`() async throws {
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

    @Test @MainActor func `phone control hub builds gateway state view hierarchies`() {
        for appModel in Self.rootTabsGatewayStateModels() {
            let root = RootTabsPhoneControlHub(
                groups: RootTabs.phoneControlGroups,
                initialDestination: nil,
                navigationRequest: nil,
                openRootDestination: { _ in },
                openChatFromControlDetail: { _ in })
                .environment(appModel)

            _ = Self.host(root)
        }
    }

    @Test @MainActor func `phone control hub builds landscape compact state`() {
        let appModel = NodeAppModel()
        let root = RootTabsPhoneControlHub(
            groups: RootTabs.phoneControlGroups,
            initialDestination: nil,
            navigationRequest: nil,
            openRootDestination: { _ in },
            openChatFromControlDetail: { _ in })
            .environment(appModel)
            .environment(\.horizontalSizeClass, .regular)
            .environment(\.verticalSizeClass, .compact)

        _ = Self.host(root)
    }

    @Test @MainActor func `routed sidebar screens build offline states`() {
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

    @Test @MainActor func `task screens build phone landscape compact states`() {
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

    @Test @MainActor func `voice wake words view builds A view hierarchy`() {
        let appModel = NodeAppModel()
        let root = NavigationStack { VoiceWakeWordsSettingsView() }
            .environment(appModel)
        _ = Self.host(root)
    }

    @Test @MainActor func `voice wake toast builds A view hierarchy`() {
        let root = VoiceWakeToast(command: "openclaw: do something")
        _ = Self.host(root)
    }

    @MainActor private static func waitForPresentedAlert(in window: UIWindow) async {
        for _ in 0..<10 {
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
