import AppKit
import Observation
import OpenClawChatUI
import OpenClawDiscovery
import OpenClawIPC
import SwiftUI

enum UIStrings {
    static let welcomeTitle = "Welcome to OpenClaw"
}

enum RemoteOnboardingProbeState: Equatable {
    case idle
    case checking
    case ok(RemoteGatewayProbeSuccess)
    case failed(String)
}

@MainActor
final class OnboardingController {
    static let shared = OnboardingController()
    private var window: NSWindow?

    static func markComplete() {
        UserDefaults.standard.set(true, forKey: onboardingSeenKey)
        UserDefaults.standard.set(currentOnboardingVersion, forKey: onboardingVersionKey)
        AppStateStore.shared.onboardingSeen = true
    }

    func show() {
        if ProcessInfo.processInfo.isNixMode {
            // Nix mode is fully declarative; onboarding would suggest interactive setup that doesn't apply.
            Self.markComplete()
            return
        }
        if let window {
            DockIconManager.shared.temporarilyShowDock()
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let hosting = NSHostingController(rootView: OnboardingView())
        let window = NSWindow(contentViewController: hosting)
        window.title = UIStrings.welcomeTitle
        window.setContentSize(NSSize(width: OnboardingView.windowWidth, height: OnboardingView.windowHeight))
        window.styleMask = [.titled, .closable, .fullSizeContentView]
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = true
        window.center()
        DockIconManager.shared.temporarilyShowDock()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = window
    }

    func close() {
        self.window?.close()
        self.window = nil
    }

    func setWindowCloseEnabled(_ enabled: Bool) {
        self.window?.standardWindowButton(.closeButton)?.isEnabled = enabled
    }

    func restart() {
        self.close()
        self.show()
    }
}

struct OnboardingView: View {
    @State var currentPage = 0
    @State var isRequesting = false
    @State var installingCLI = false
    @State var cliStatus: String?
    @State var copied = false
    @State var monitoringPermissions = false
    @State var monitoringDiscovery = false
    @State var cliInstalled = false
    @State var cliStatusKnown = false
    @State var onboardingVisible = false
    @State var cliInstallLocation: String?
    @State var workspacePath: String = ""
    @State var workspaceStatus: String?
    @State var workspaceApplying = false
    @State var needsBootstrap = false
    @State var didAutoKickoff = false
    @State var showAdvancedConnection = false
    @State var preferredGatewayID: String?
    @State var remoteProbeState: RemoteOnboardingProbeState = .idle
    @State var remoteAuthIssue: RemoteGatewayAuthIssue?
    @State var suppressRemoteProbeReset = false
    @State var gatewayDiscovery: GatewayDiscoveryModel
    @State var onboardingChatModel: OpenClawChatViewModel
    @State var onboardingSkillsModel = SkillsSettingsModel()
    @State var crestodianChat = CrestodianOnboardingChatModel()
    @State var didLoadOnboardingSkills = false
    @State var localGatewayProbe: LocalGatewayProbe?
    @State var defaultsToLocalGateway: Bool
    @Bindable var state: AppState
    var permissionMonitor: PermissionMonitor

    static let windowWidth: CGFloat = 630
    static let windowHeight: CGFloat = 752 // ~+10% to fit full onboarding content

    let pageWidth: CGFloat = Self.windowWidth
    // Sized so the permissions page fits all capabilities without scrolling:
    // 145 (icon header) + 535 + ~60 (nav bar) stays inside windowHeight 752.
    let contentHeight: CGFloat = 535
    let connectionPageIndex = 1
    let cliPageIndex = 2
    let crestodianPageIndex = 3
    let onboardingChatPageIndex = 8

    let permissionsPageIndex = 5
    static func pageOrder(
        for mode: AppState.ConnectionMode,
        showOnboardingChat: Bool,
        requiresCLIInstall: Bool) -> [Int]
    {
        switch mode {
        case .remote:
            // Remote setup doesn't need local gateway/CLI/workspace setup pages,
            // and WhatsApp/Telegram setup is optional.
            return showOnboardingChat ? [0, 1, 5, 8, 9] : [0, 1, 5, 9]
        case .unconfigured:
            return showOnboardingChat ? [0, 1, 8, 9] : [0, 1, 9]
        case .local:
            let setupPages = requiresCLIInstall ? [0, 1, 2, 3, 5] : [0, 1, 3, 5]
            return showOnboardingChat ? setupPages + [8, 9] : setupPages + [9]
        }
    }

    var showOnboardingChat: Bool {
        self.state.connectionMode == .local && self.needsBootstrap
    }

    var selectedConnectionMode: AppState.ConnectionMode {
        if self.isConnectionSelectionBlocking {
            return .local
        }
        return self.state.connectionMode
    }

    var isConnectionSelectionBlocking: Bool {
        self.defaultsToLocalGateway && self.state.connectionMode == .unconfigured
    }

    var pageOrder: [Int] {
        Self.pageOrder(
            for: self.state.connectionMode,
            showOnboardingChat: self.showOnboardingChat,
            requiresCLIInstall: self.state.connectionMode == .local && !self.cliInstalled)
    }

    var pageCount: Int {
        self.pageOrder.count
    }

    var activePageIndex: Int {
        self.activePageIndex(for: self.currentPage)
    }

    var buttonTitle: String {
        self.currentPage == self.pageCount - 1 ? "Finish" : "Next"
    }

    var isCLIBlocking: Bool {
        self.activePageIndex == self.cliPageIndex && !self.cliInstalled
    }

    var canAdvance: Bool {
        !self.isCLIBlocking
    }

    struct LocalGatewayProbe: Equatable {
        let port: Int
        let pid: Int32
        let command: String
        let expected: Bool
    }

    init(
        state: AppState = AppStateStore.shared,
        permissionMonitor: PermissionMonitor = .shared,
        discoveryModel: GatewayDiscoveryModel = GatewayDiscoveryModel(
            localDisplayName: InstanceIdentity.displayName,
            filterLocalGateways: false))
    {
        self.state = state
        self.permissionMonitor = permissionMonitor
        self._defaultsToLocalGateway = State(
            initialValue: !state.onboardingSeen && state.connectionMode == .unconfigured)
        self._gatewayDiscovery = State(initialValue: discoveryModel)
        self._onboardingChatModel = State(
            initialValue: OpenClawChatViewModel(
                sessionKey: "onboarding",
                transport: MacGatewayChatTransport()))
    }
}
