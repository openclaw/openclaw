import SwiftUI

#if DEBUG
#Preview(
    "Shell iPhone portrait",
    traits: .fixedLayout(width: 393, height: 852),
    .portrait)
{
    RootTabsPreviewHost()
}

#Preview(
    "Shell iPhone drawer open",
    traits: .fixedLayout(width: 393, height: 852),
    .portrait)
{
    RootTabsPreviewHost(sidebarVisible: true)
}

#Preview(
    "Shell iPhone connected",
    traits: .fixedLayout(width: 393, height: 852),
    .portrait)
{
    RootTabsPreviewHost(gatewayState: .connected)
}

#Preview(
    "Shell iPhone gateway error",
    traits: .fixedLayout(width: 393, height: 852),
    .portrait)
{
    RootTabsPreviewHost(gatewayState: .error)
}

#Preview(
    "Shell iPhone landscape",
    traits: .fixedLayout(width: 852, height: 393),
    .landscapeLeft)
{
    RootTabsPreviewHost()
        .environment(\.horizontalSizeClass, .regular)
        .environment(\.verticalSizeClass, .compact)
}

#Preview(
    "Shell iPad portrait drawer",
    traits: .fixedLayout(width: 1024, height: 1366),
    .portrait)
{
    RootTabsPreviewHost()
}

#Preview(
    "Shell iPad landscape split",
    traits: .fixedLayout(width: 1366, height: 1024),
    .landscapeLeft)
{
    RootTabsPreviewHost(gatewayState: .connected)
}

#Preview(
    "Shell iPad connecting",
    traits: .fixedLayout(width: 1366, height: 1024),
    .landscapeLeft)
{
    RootTabsPreviewHost(gatewayState: .connecting)
}

#Preview(
    "Shell iPad gateway error",
    traits: .fixedLayout(width: 1366, height: 1024),
    .landscapeLeft)
{
    RootTabsPreviewHost(gatewayState: .error)
}

private struct RootTabsPreviewHost: View {
    @State private var appearanceModel = AppAppearanceModel()
    @State private var appModel: NodeAppModel
    @State private var gatewayController: GatewayConnectionController
    private let sidebarVisible: Bool?

    init(
        gatewayState: RootTabsPreviewGatewayState = .offline,
        sidebarVisible: Bool? = nil)
    {
        let appModel = NodeAppModel()
        gatewayState.apply(to: appModel)
        self.sidebarVisible = sidebarVisible
        _appModel = State(initialValue: appModel)
        _gatewayController = State(
            initialValue: GatewayConnectionController(appModel: appModel, startDiscovery: false))
    }

    var body: some View {
        RootTabs(initialSidebarVisibility: self.sidebarVisible)
            .environment(self.appearanceModel)
            .environment(self.appModel)
            .environment(self.appModel.voiceWake)
            .environment(self.gatewayController)
    }
}

private enum RootTabsPreviewGatewayState {
    case offline
    case connecting
    case connected
    case error

    @MainActor
    func apply(to appModel: NodeAppModel) {
        switch self {
        case .offline:
            break
        case .connecting:
            appModel.gatewayStatusText = "Connecting..."
        case .connected:
            appModel.enterAppleReviewDemoMode()
        case .error:
            appModel.gatewayStatusText = "Gateway error: connection refused"
        }
    }
}

#endif
