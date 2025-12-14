import SwiftUI
import Testing
import UIKit
@testable import Clawdis

@Suite struct SwiftUIRenderSmokeTests {
    @MainActor private static func host(_ view: some View) -> UIWindow {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = UIHostingController(rootView: view)
        window.makeKeyAndVisible()
        window.rootViewController?.view.setNeedsLayout()
        window.rootViewController?.view.layoutIfNeeded()
        return window
    }

    @Test @MainActor func settingsTabBuildsAViewHierarchy() {
        let appModel = NodeAppModel()
        let bridgeController = BridgeConnectionController(appModel: appModel, startDiscovery: false)

        let root = SettingsTab()
            .environmentObject(appModel)
            .environmentObject(appModel.voiceWake)
            .environmentObject(bridgeController)

        _ = Self.host(root)
    }

    @Test @MainActor func rootTabsBuildAViewHierarchy() {
        let appModel = NodeAppModel()
        let bridgeController = BridgeConnectionController(appModel: appModel, startDiscovery: false)

        let root = RootTabs()
            .environmentObject(appModel)
            .environmentObject(appModel.voiceWake)
            .environmentObject(bridgeController)

        _ = Self.host(root)
    }

    @Test @MainActor func voiceTabBuildsAViewHierarchy() {
        let appModel = NodeAppModel()

        let root = VoiceTab()
            .environmentObject(appModel)
            .environmentObject(appModel.voiceWake)

        _ = Self.host(root)
    }

    @Test @MainActor func voiceWakeWordsViewBuildsAViewHierarchy() {
        let appModel = NodeAppModel()
        let root = NavigationStack { VoiceWakeWordsSettingsView() }
            .environmentObject(appModel)
        _ = Self.host(root)
    }

    @Test @MainActor func chatSheetBuildsAViewHierarchy() {
        let appModel = NodeAppModel()
        let bridge = BridgeSession()
        let root = ChatSheet(bridge: bridge, sessionKey: "test")
            .environmentObject(appModel)
            .environmentObject(appModel.voiceWake)
        _ = Self.host(root)
    }

    @Test @MainActor func voiceWakeToastBuildsAViewHierarchy() {
        let root = VoiceWakeToast(command: "clawdis: do something")
        _ = Self.host(root)
    }
}
