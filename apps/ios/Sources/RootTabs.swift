import SwiftUI
import UIKit

struct RootTabs: View {
    @EnvironmentObject private var appModel: NodeAppModel
    @State private var isConnectingPulse: Bool = false

    var body: some View {
        TabView {
            ScreenTab()
                .tabItem { Label("Screen", systemImage: "rectangle.and.hand.point.up.left") }

            VoiceTab()
                .tabItem { Label("Voice", systemImage: "mic") }

            SettingsTab()
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
        .background(TabBarControllerAccessor { tabBarController in
            guard let item = tabBarController.tabBar.items?[Self.settingsTabIndex] else { return }
            item.badgeValue = ""
            item.badgeColor = self.settingsBadgeColor
        })
        .onAppear { self.updateConnectingPulse(for: self.bridgeIndicatorState) }
        .onChange(of: self.bridgeIndicatorState) { _, newValue in
            self.updateConnectingPulse(for: newValue)
        }
    }

    private enum BridgeIndicatorState {
        case connected
        case connecting
        case disconnected
    }

    private static let settingsTabIndex = 2

    private var bridgeIndicatorState: BridgeIndicatorState {
        if self.appModel.bridgeServerName != nil { return .connected }
        if self.appModel.bridgeStatusText.localizedCaseInsensitiveContains("connecting") { return .connecting }
        return .disconnected
    }

    private var settingsBadgeColor: UIColor {
        switch self.bridgeIndicatorState {
        case .connected:
            UIColor.systemGreen
        case .connecting:
            UIColor.systemYellow.withAlphaComponent(self.isConnectingPulse ? 1.0 : 0.6)
        case .disconnected:
            UIColor.systemRed
        }
    }

    private func updateConnectingPulse(for state: BridgeIndicatorState) {
        guard state == .connecting else {
            withAnimation(.easeOut(duration: 0.2)) { self.isConnectingPulse = false }
            return
        }

        guard !self.isConnectingPulse else { return }
        withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) {
            self.isConnectingPulse = true
        }
    }
}

private struct TabBarControllerAccessor: UIViewControllerRepresentable {
    let onResolve: (UITabBarController) -> Void

    func makeUIViewController(context: Context) -> ResolverViewController {
        ResolverViewController(onResolve: self.onResolve)
    }

    func updateUIViewController(_ uiViewController: ResolverViewController, context: Context) {
        uiViewController.onResolve = self.onResolve
        uiViewController.resolveIfPossible()
    }
}

private final class ResolverViewController: UIViewController {
    var onResolve: (UITabBarController) -> Void

    init(onResolve: @escaping (UITabBarController) -> Void) {
        self.onResolve = onResolve
        super.init(nibName: nil, bundle: nil)
        self.view.isHidden = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        self.resolveIfPossible()
    }

    func resolveIfPossible() {
        guard let tabBarController = self.tabBarController else { return }
        self.onResolve(tabBarController)
    }
}
