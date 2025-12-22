import AppKit
import ClawdisChatUI
import ClawdisIPC
import Combine
import Observation
import SwiftUI

enum UIStrings {
    static let welcomeTitle = "Welcome to Clawdis"
}

@MainActor
final class OnboardingController {
    static let shared = OnboardingController()
    private var window: NSWindow?

    func show() {
        if let window {
            DockIconManager.shared.temporarilyShowDock()
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let hosting = NSHostingController(rootView: OnboardingView())
        let window = NSWindow(contentViewController: hosting)
        window.title = UIStrings.welcomeTitle
        window.setContentSize(NSSize(width: 630, height: 644))
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
}

// swiftlint:disable:next type_body_length
struct OnboardingView: View {
    @Environment(\.openSettings) private var openSettings
    @State private var currentPage = 0
    @State private var isRequesting = false
    @State private var installingCLI = false
    @State private var cliStatus: String?
    @State private var copied = false
    @State private var monitoringPermissions = false
    @State private var monitoringDiscovery = false
    @State private var cliInstalled = false
    @State private var cliInstallLocation: String?
    @State private var workspacePath: String = ""
    @State private var workspaceStatus: String?
    @State private var workspaceApplying = false
    @State private var anthropicAuthPKCE: AnthropicOAuth.PKCE?
    @State private var anthropicAuthCode: String = ""
    @State private var anthropicAuthStatus: String?
    @State private var anthropicAuthBusy = false
    @State private var anthropicAuthConnected = false
    @State private var anthropicAuthDetectedStatus: ClawdisOAuthStore.AnthropicOAuthStatus = .missingFile
    @State private var anthropicAuthAutoDetectClipboard = true
    @State private var anthropicAuthAutoConnectClipboard = true
    @State private var anthropicAuthLastPasteboardChangeCount = NSPasteboard.general.changeCount
    @State private var monitoringAuth = false
    @State private var authMonitorTask: Task<Void, Never>?
    @State private var needsBootstrap = false
    @State private var didAutoKickoff = false
    @State private var showAdvancedConnection = false
    @State private var preferredGatewayID: String?
    @State private var gatewayDiscovery: GatewayDiscoveryModel
    @State private var onboardingChatModel: ClawdisChatViewModel
    @State private var localGatewayProbe: LocalGatewayProbe?
    @Bindable private var state: AppState
    private var permissionMonitor: PermissionMonitor

    private let pageWidth: CGFloat = 630
    private let contentHeight: CGFloat = 420
    private let connectionPageIndex = 1
    private let anthropicAuthPageIndex = 2
    private let onboardingChatPageIndex = 8

    private static let clipboardPoll = Timer.publish(every: 0.4, on: .main, in: .common).autoconnect()
    private let permissionsPageIndex = 5
    static func pageOrder(
        for mode: AppState.ConnectionMode,
        needsBootstrap: Bool) -> [Int]
    {
        switch mode {
        case .remote:
            // Remote setup doesn't need local gateway/CLI/workspace setup pages,
            // and WhatsApp/Telegram setup is optional.
            needsBootstrap ? [0, 1, 5, 8, 9] : [0, 1, 5, 9]
        case .unconfigured:
            needsBootstrap ? [0, 1, 8, 9] : [0, 1, 9]
        case .local:
            needsBootstrap ? [0, 1, 2, 5, 6, 8, 9] : [0, 1, 2, 5, 6, 9]
        }
    }

    private var pageOrder: [Int] {
        Self.pageOrder(for: self.state.connectionMode, needsBootstrap: self.needsBootstrap)
    }

    private var pageCount: Int { self.pageOrder.count }
    private var activePageIndex: Int {
        self.activePageIndex(for: self.currentPage)
    }

    private var buttonTitle: String { self.currentPage == self.pageCount - 1 ? "Finish" : "Next" }
    private var devLinkCommand: String {
        let bundlePath = Bundle.main.bundlePath
        return "ln -sf '\(bundlePath)/Contents/Resources/Relay/clawdis' /usr/local/bin/clawdis"
    }

    private struct LocalGatewayProbe: Equatable {
        let port: Int
        let pid: Int32
        let command: String
        let expected: Bool
    }

    init(
        state: AppState = AppStateStore.shared,
        permissionMonitor: PermissionMonitor = .shared,
        discoveryModel: GatewayDiscoveryModel = GatewayDiscoveryModel())
    {
        self.state = state
        self.permissionMonitor = permissionMonitor
        self._gatewayDiscovery = State(initialValue: discoveryModel)
        self._onboardingChatModel = State(
            initialValue: ClawdisChatViewModel(
                sessionKey: "onboarding",
                transport: MacGatewayChatTransport()))
    }

    var body: some View {
        VStack(spacing: 0) {
            GlowingClawdisIcon(size: 130, glowIntensity: 0.28)
                .offset(y: 10)
                .frame(height: 145)

            GeometryReader { _ in
                HStack(spacing: 0) {
                    ForEach(self.pageOrder, id: \.self) { pageIndex in
                        self.pageView(for: pageIndex)
                            .frame(width: self.pageWidth)
                    }
                }
                .offset(x: CGFloat(-self.currentPage) * self.pageWidth)
                .animation(
                    .interactiveSpring(response: 0.5, dampingFraction: 0.86, blendDuration: 0.25),
                    value: self.currentPage)
                .frame(height: self.contentHeight, alignment: .top)
                .clipped()
            }
            .frame(height: self.contentHeight)

            Spacer(minLength: 0)
            self.navigationBar
        }
        .frame(width: self.pageWidth, height: 644)
        .background(Color(NSColor.windowBackgroundColor))
        .onAppear {
            self.currentPage = 0
            self.updateMonitoring(for: 0)
        }
        .onChange(of: self.currentPage) { _, newValue in
            self.updateMonitoring(for: self.activePageIndex(for: newValue))
        }
        .onChange(of: self.state.connectionMode) { _, _ in
            let oldActive = self.activePageIndex
            self.reconcilePageForModeChange(previousActivePageIndex: oldActive)
            self.updateDiscoveryMonitoring(for: self.activePageIndex)
        }
        .onChange(of: self.needsBootstrap) { _, _ in
            if self.currentPage >= self.pageOrder.count {
                self.currentPage = max(0, self.pageOrder.count - 1)
            }
        }
        .onDisappear {
            self.stopPermissionMonitoring()
            self.stopDiscovery()
            self.stopAuthMonitoring()
        }
        .task {
            await self.refreshPerms()
            self.refreshCLIStatus()
            self.loadWorkspaceDefaults()
            self.ensureDefaultWorkspace()
            self.refreshAnthropicOAuthStatus()
            self.refreshBootstrapStatus()
            self.preferredGatewayID = BridgeDiscoveryPreferences.preferredStableID()
        }
    }

    private func activePageIndex(for pageCursor: Int) -> Int {
        guard !self.pageOrder.isEmpty else { return 0 }
        let clamped = min(max(0, pageCursor), self.pageOrder.count - 1)
        return self.pageOrder[clamped]
    }

    private func reconcilePageForModeChange(previousActivePageIndex: Int) {
        if let exact = self.pageOrder.firstIndex(of: previousActivePageIndex) {
            withAnimation { self.currentPage = exact }
            return
        }
        if let next = self.pageOrder.firstIndex(where: { $0 > previousActivePageIndex }) {
            withAnimation { self.currentPage = next }
            return
        }
        withAnimation { self.currentPage = max(0, self.pageOrder.count - 1) }
    }

    @ViewBuilder
    private func pageView(for pageIndex: Int) -> some View {
        switch pageIndex {
        case 0:
            self.welcomePage()
        case 1:
            self.connectionPage()
        case 2:
            self.anthropicAuthPage()
        case 5:
            self.permissionsPage()
        case 6:
            self.cliPage()
        case 8:
            self.onboardingChatPage()
        case 9:
            self.readyPage()
        default:
            EmptyView()
        }
    }

    private func welcomePage() -> some View {
        self.onboardingPage {
            VStack(spacing: 22) {
                Text("Welcome to Clawdis")
                    .font(.largeTitle.weight(.semibold))
                Text("Clawdis is a powerful personal AI assistant that can connect to WhatsApp or Telegram.")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                    .frame(maxWidth: 560)
                    .fixedSize(horizontal: false, vertical: true)

                self.onboardingCard(spacing: 10, padding: 14) {
                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.title3.weight(.semibold))
                            .foregroundStyle(Color(nsColor: .systemOrange))
                            .frame(width: 22)
                            .padding(.top, 1)

                        VStack(alignment: .leading, spacing: 6) {
                            Text("Security notice")
                                .font(.headline)
                            Text(
                                "The connected AI agent (e.g. Claude) can trigger powerful actions on your Mac, " +
                                    "including running commands, reading/writing files, and capturing screenshots — " +
                                    "depending on the permissions you grant.\n\n" +
                                    "Only enable Clawdis if you understand the risks and trust the prompts and " +
                                    "integrations you use.")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .frame(maxWidth: 520)
            }
            .padding(.top, 16)
        }
    }

    private func connectionPage() -> some View {
        self.onboardingPage {
            Text("Choose your Gateway")
                .font(.largeTitle.weight(.semibold))
            Text(
                "Clawdis uses a single Gateway that stays running. Pick this Mac, " +
                    "connect to a discovered bridge nearby for pairing, or configure later.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .frame(maxWidth: 520)
                .fixedSize(horizontal: false, vertical: true)

            self.onboardingCard(spacing: 12, padding: 14) {
                VStack(alignment: .leading, spacing: 10) {
                    let localSubtitle: String = {
                        guard let probe = self.localGatewayProbe else {
                            return "Gateway starts automatically on this Mac."
                        }
                        let base = probe.expected
                            ? "Existing gateway detected"
                            : "Port \(probe.port) already in use"
                        let command = probe.command.isEmpty ? "" : " (\(probe.command) pid \(probe.pid))"
                        return "\(base)\(command). Will attach."
                    }()
                    self.connectionChoiceButton(
                        title: "This Mac",
                        subtitle: localSubtitle,
                        selected: self.state.connectionMode == .local)
                    {
                        self.selectLocalGateway()
                    }

                    Divider().padding(.vertical, 4)

                    HStack(spacing: 8) {
                        Image(systemName: "dot.radiowaves.left.and.right")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(self.gatewayDiscovery.statusText)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        if self.gatewayDiscovery.gateways.isEmpty {
                            ProgressView().controlSize(.small)
                        }
                        Spacer(minLength: 0)
                    }

                    if self.gatewayDiscovery.gateways.isEmpty {
                        Text("Searching for nearby bridges…")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(.leading, 4)
                    } else {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Nearby bridges (pairing only)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .padding(.leading, 4)
                            ForEach(self.gatewayDiscovery.gateways.prefix(6)) { gateway in
                                self.connectionChoiceButton(
                                    title: gateway.displayName,
                                    subtitle: self.gatewaySubtitle(for: gateway),
                                    selected: self.isSelectedGateway(gateway))
                                {
                                    self.selectRemoteGateway(gateway)
                                }
                            }
                        }
                        .padding(8)
                        .background(
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .fill(Color(NSColor.controlBackgroundColor)))
                    }

                    self.connectionChoiceButton(
                        title: "Configure later",
                        subtitle: "Don’t start the Gateway yet.",
                        selected: self.state.connectionMode == .unconfigured)
                    {
                        self.selectUnconfiguredGateway()
                    }

                    Button(self.showAdvancedConnection ? "Hide Advanced" : "Advanced…") {
                        withAnimation(.spring(response: 0.25, dampingFraction: 0.9)) {
                            self.showAdvancedConnection.toggle()
                        }
                        if self.showAdvancedConnection, self.state.connectionMode != .remote {
                            self.state.connectionMode = .remote
                        }
                    }
                    .buttonStyle(.link)

                    if self.showAdvancedConnection {
                        let labelWidth: CGFloat = 110
                        let fieldWidth: CGFloat = 320

                        VStack(alignment: .leading, spacing: 10) {
                            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 8) {
                                GridRow {
                                    Text("SSH target")
                                        .font(.callout.weight(.semibold))
                                        .frame(width: labelWidth, alignment: .leading)
                                    TextField("user@host[:port]", text: self.$state.remoteTarget)
                                        .textFieldStyle(.roundedBorder)
                                        .frame(width: fieldWidth)
                                }
                                GridRow {
                                    Text("Identity file")
                                        .font(.callout.weight(.semibold))
                                        .frame(width: labelWidth, alignment: .leading)
                                    TextField("/Users/you/.ssh/id_ed25519", text: self.$state.remoteIdentity)
                                        .textFieldStyle(.roundedBorder)
                                        .frame(width: fieldWidth)
                                }
                                GridRow {
                                    Text("Project root")
                                        .font(.callout.weight(.semibold))
                                        .frame(width: labelWidth, alignment: .leading)
                                    TextField("/home/you/Projects/clawdis", text: self.$state.remoteProjectRoot)
                                        .textFieldStyle(.roundedBorder)
                                        .frame(width: fieldWidth)
                                }
                                GridRow {
                                    Text("CLI path")
                                        .font(.callout.weight(.semibold))
                                        .frame(width: labelWidth, alignment: .leading)
                                    TextField("/Applications/Clawdis.app/.../clawdis", text: self.$state.remoteCliPath)
                                        .textFieldStyle(.roundedBorder)
                                        .frame(width: fieldWidth)
                                }
                            }

                            Text("Tip: keep Tailscale enabled so your gateway stays reachable.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        .transition(.opacity.combined(with: .move(edge: .top)))
                    }
                }
            }
        }
    }

    private func selectLocalGateway() {
        self.state.connectionMode = .local
        self.preferredGatewayID = nil
        self.showAdvancedConnection = false
        BridgeDiscoveryPreferences.setPreferredStableID(nil)
    }

    private func selectUnconfiguredGateway() {
        self.state.connectionMode = .unconfigured
        self.preferredGatewayID = nil
        self.showAdvancedConnection = false
        BridgeDiscoveryPreferences.setPreferredStableID(nil)
    }

    private func selectRemoteGateway(_ gateway: GatewayDiscoveryModel.DiscoveredGateway) {
        self.preferredGatewayID = gateway.stableID
        BridgeDiscoveryPreferences.setPreferredStableID(gateway.stableID)

        if let host = gateway.tailnetDns ?? gateway.lanHost {
            let user = NSUserName()
            self.state.remoteTarget = GatewayDiscoveryModel.buildSSHTarget(
                user: user,
                host: host,
                port: gateway.sshPort)
        }
        self.state.remoteCliPath = gateway.cliPath ?? ""

        self.state.connectionMode = .remote
        MacNodeModeCoordinator.shared.setPreferredBridgeStableID(gateway.stableID)
    }

    private func gatewaySubtitle(for gateway: GatewayDiscoveryModel.DiscoveredGateway) -> String? {
        if let host = gateway.tailnetDns ?? gateway.lanHost {
            let portSuffix = gateway.sshPort != 22 ? " · ssh \(gateway.sshPort)" : ""
            return "\(host)\(portSuffix)"
        }
        return "Bridge pairing only"
    }

    private func isSelectedGateway(_ gateway: GatewayDiscoveryModel.DiscoveredGateway) -> Bool {
        guard self.state.connectionMode == .remote else { return false }
        let preferred = self.preferredGatewayID ?? BridgeDiscoveryPreferences.preferredStableID()
        return preferred == gateway.stableID
    }

    private func connectionChoiceButton(
        title: String,
        subtitle: String?,
        selected: Bool,
        action: @escaping () -> Void) -> some View
    {
        Button {
            withAnimation(.spring(response: 0.25, dampingFraction: 0.9)) {
                action()
            }
        } label: {
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.callout.weight(.semibold))
                        .lineLimit(1)
                        .truncationMode(.tail)
                    if let subtitle {
                        Text(subtitle)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                Spacer(minLength: 0)
                if selected {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(Color.accentColor)
                } else {
                    Image(systemName: "arrow.right.circle")
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(selected ? Color.accentColor.opacity(0.12) : Color.clear))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(
                        selected ? Color.accentColor.opacity(0.45) : Color.clear,
                        lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private func anthropicAuthPage() -> some View {
        self.onboardingPage {
            Text("Connect Claude")
                .font(.largeTitle.weight(.semibold))
            Text("Give your model the token it needs!")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 540)
                .fixedSize(horizontal: false, vertical: true)
            Text("Clawdis supports any model — we strongly recommend Opus 4.5 for the best experience.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 540)
                .fixedSize(horizontal: false, vertical: true)

            self.onboardingCard(spacing: 12, padding: 16) {
                HStack(alignment: .center, spacing: 10) {
                    Circle()
                        .fill(self.anthropicAuthConnected ? Color.green : Color.orange)
                        .frame(width: 10, height: 10)
                    Text(self.anthropicAuthConnected ? "Claude connected (OAuth)" : "Not connected yet")
                        .font(.headline)
                    Spacer()
                }

                if !self.anthropicAuthConnected {
                    Text(self.anthropicAuthDetectedStatus.shortDescription)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Text(
                    "This lets Clawdis use Claude immediately. Credentials are stored at " +
                        "`~/.clawdis/credentials/oauth.json` (owner-only). You can redo this anytime.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: 12) {
                    Text(ClawdisOAuthStore.oauthURL().path)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)

                    Spacer()

                    Button("Reveal") {
                        NSWorkspace.shared.activateFileViewerSelecting([ClawdisOAuthStore.oauthURL()])
                    }
                    .buttonStyle(.bordered)

                    Button("Refresh") {
                        self.refreshAnthropicOAuthStatus()
                    }
                    .buttonStyle(.bordered)
                }

                Divider().padding(.vertical, 2)

                HStack(spacing: 12) {
                    Button {
                        self.startAnthropicOAuth()
                    } label: {
                        if self.anthropicAuthBusy {
                            ProgressView()
                        } else {
                            Text("Open Claude sign-in (OAuth)")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(self.anthropicAuthBusy)
                }

                if self.anthropicAuthPKCE != nil {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Paste the `code#state` value")
                            .font(.headline)
                        TextField("code#state", text: self.$anthropicAuthCode)
                            .textFieldStyle(.roundedBorder)

                        Toggle("Auto-detect from clipboard", isOn: self.$anthropicAuthAutoDetectClipboard)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .disabled(self.anthropicAuthBusy)

                        Toggle("Auto-connect when detected", isOn: self.$anthropicAuthAutoConnectClipboard)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .disabled(self.anthropicAuthBusy)

                        Button("Connect") {
                            Task { await self.finishAnthropicOAuth() }
                        }
                        .buttonStyle(.bordered)
                        .disabled(
                            self.anthropicAuthBusy ||
                                self.anthropicAuthCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                    .onReceive(Self.clipboardPoll) { _ in
                        self.pollAnthropicClipboardIfNeeded()
                    }
                }

                self.onboardingCard(spacing: 8, padding: 12) {
                    Text("API key (advanced)")
                        .font(.headline)
                    Text(
                        "You can also use an Anthropic API key, but this UI is instructions-only for now " +
                            "(GUI apps don’t automatically inherit your shell env vars like `ANTHROPIC_API_KEY`).")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .shadow(color: .clear, radius: 0)
                .background(Color.clear)

                if let status = self.anthropicAuthStatus {
                    Text(status)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func startAnthropicOAuth() {
        guard !self.anthropicAuthBusy else { return }
        self.anthropicAuthBusy = true
        defer { self.anthropicAuthBusy = false }

        do {
            let pkce = try AnthropicOAuth.generatePKCE()
            self.anthropicAuthPKCE = pkce
            let url = AnthropicOAuth.buildAuthorizeURL(pkce: pkce)
            NSWorkspace.shared.open(url)
            self.anthropicAuthStatus = "Browser opened. After approving, paste the `code#state` value here."
        } catch {
            self.anthropicAuthStatus = "Failed to start OAuth: \(error.localizedDescription)"
        }
    }

    @MainActor
    private func finishAnthropicOAuth() async {
        guard !self.anthropicAuthBusy else { return }
        guard let pkce = self.anthropicAuthPKCE else { return }
        self.anthropicAuthBusy = true
        defer { self.anthropicAuthBusy = false }

        guard let parsed = AnthropicOAuthCodeState.parse(from: self.anthropicAuthCode) else {
            self.anthropicAuthStatus = "OAuth failed: missing or invalid code/state."
            return
        }

        do {
            let creds = try await AnthropicOAuth.exchangeCode(
                code: parsed.code,
                state: parsed.state,
                verifier: pkce.verifier)
            try ClawdisOAuthStore.saveAnthropicOAuth(creds)
            self.refreshAnthropicOAuthStatus()
            self.anthropicAuthStatus = "Connected. Clawdis can now use Claude."
        } catch {
            self.anthropicAuthStatus = "OAuth failed: \(error.localizedDescription)"
        }
    }

    private func pollAnthropicClipboardIfNeeded() {
        guard self.currentPage == self.anthropicAuthPageIndex else { return }
        guard self.anthropicAuthPKCE != nil else { return }
        guard !self.anthropicAuthBusy else { return }
        guard self.anthropicAuthAutoDetectClipboard else { return }

        let pb = NSPasteboard.general
        let changeCount = pb.changeCount
        guard changeCount != self.anthropicAuthLastPasteboardChangeCount else { return }
        self.anthropicAuthLastPasteboardChangeCount = changeCount

        guard let raw = pb.string(forType: .string), !raw.isEmpty else { return }
        guard let parsed = AnthropicOAuthCodeState.parse(from: raw) else { return }
        guard let pkce = self.anthropicAuthPKCE, parsed.state == pkce.verifier else { return }

        let next = "\(parsed.code)#\(parsed.state)"
        if self.anthropicAuthCode != next {
            self.anthropicAuthCode = next
            self.anthropicAuthStatus = "Detected `code#state` from clipboard."
        }

        guard self.anthropicAuthAutoConnectClipboard else { return }
        Task { await self.finishAnthropicOAuth() }
    }

    private func refreshAnthropicOAuthStatus() {
        _ = ClawdisOAuthStore.importLegacyAnthropicOAuthIfNeeded()
        let status = ClawdisOAuthStore.anthropicOAuthStatus()
        self.anthropicAuthDetectedStatus = status
        self.anthropicAuthConnected = status.isConnected
    }

    private func permissionsPage() -> some View {
        self.onboardingPage {
            Text("Grant permissions")
                .font(.largeTitle.weight(.semibold))
            Text("These macOS permissions let Clawdis automate apps and capture context on this Mac.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
                .fixedSize(horizontal: false, vertical: true)

            self.onboardingCard(spacing: 8, padding: 12) {
                ForEach(Capability.allCases, id: \.self) { cap in
                    PermissionRow(
                        capability: cap,
                        status: self.permissionMonitor.status[cap] ?? false,
                        compact: true)
                    {
                        Task { await self.request(cap) }
                    }
                }

                HStack(spacing: 12) {
                    Button {
                        Task { await self.refreshPerms() }
                    } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .help("Refresh status")
                    if self.isRequesting {
                        ProgressView()
                            .controlSize(.small)
                    }
                }
                .padding(.top, 4)
            }
        }
    }

    private func cliPage() -> some View {
        self.onboardingPage {
            Text("Install the helper CLI")
                .font(.largeTitle.weight(.semibold))
            Text("Optional, but recommended: link `clawdis` so scripts can reach the local gateway.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
                .fixedSize(horizontal: false, vertical: true)

            self.onboardingCard(spacing: 10) {
                HStack(spacing: 12) {
                    Button {
                        Task { await self.installCLI() }
                    } label: {
                        let title = self.cliInstalled ? "Reinstall CLI" : "Install CLI"
                        ZStack {
                            Text(title)
                                .opacity(self.installingCLI ? 0 : 1)
                            if self.installingCLI {
                                ProgressView()
                                    .controlSize(.mini)
                            }
                        }
                        .frame(minWidth: 120)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(self.installingCLI)

                    Button(self.copied ? "Copied" : "Copy dev link") {
                        self.copyToPasteboard(self.devLinkCommand)
                    }
                    .disabled(self.installingCLI)

                    if self.cliInstalled, let loc = self.cliInstallLocation {
                        Label("Installed at \(loc)", systemImage: "checkmark.circle.fill")
                            .font(.footnote)
                            .foregroundStyle(.green)
                    }
                }

                if let cliStatus {
                    Text(cliStatus)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else if !self.cliInstalled, self.cliInstallLocation == nil {
                    Text(
                        """
                        We install into /usr/local/bin and /opt/homebrew/bin.
                        Rerun anytime if you move the build output.
                        """)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func workspacePage() -> some View {
        self.onboardingPage {
            Text("Agent workspace")
                .font(.largeTitle.weight(.semibold))
            Text(
                "Clawdis runs the agent from a dedicated workspace so it can load `AGENTS.md` " +
                    "and write files there without mixing into your other projects.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 560)
                .fixedSize(horizontal: false, vertical: true)

            self.onboardingCard(spacing: 10) {
                if self.state.connectionMode == .remote {
                    Text("Remote gateway detected")
                        .font(.headline)
                    Text(
                        "Create the workspace on the remote host (SSH in first). " +
                            "The macOS app can’t write files on your gateway over SSH yet.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)

                    Button(self.copied ? "Copied" : "Copy setup command") {
                        self.copyToPasteboard(self.workspaceBootstrapCommand)
                    }
                    .buttonStyle(.bordered)
                } else {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Workspace folder")
                            .font(.headline)
                        TextField(
                            AgentWorkspace.displayPath(for: ClawdisConfigFile.defaultWorkspaceURL()),
                            text: self.$workspacePath)
                            .textFieldStyle(.roundedBorder)

                        HStack(spacing: 12) {
                            Button {
                                Task { await self.applyWorkspace() }
                            } label: {
                                if self.workspaceApplying {
                                    ProgressView()
                                } else {
                                    Text("Create workspace")
                                }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(self.workspaceApplying)

                            Button("Open folder") {
                                let url = AgentWorkspace.resolveWorkspaceURL(from: self.workspacePath)
                                NSWorkspace.shared.open(url)
                            }
                            .buttonStyle(.bordered)
                            .disabled(self.workspaceApplying)

                            Button("Save in config") {
                                let url = AgentWorkspace.resolveWorkspaceURL(from: self.workspacePath)
                                ClawdisConfigFile.setInboundWorkspace(AgentWorkspace.displayPath(for: url))
                                self.workspaceStatus = "Saved to ~/.clawdis/clawdis.json (inbound.workspace)"
                            }
                            .buttonStyle(.bordered)
                            .disabled(self.workspaceApplying)
                        }
                    }

                    if let workspaceStatus {
                        Text(workspaceStatus)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    } else {
                        Text(
                            "Tip: edit AGENTS.md in this folder to shape the assistant’s behavior. " +
                                "For backup, make the workspace a private git repo so your agent’s " +
                                "“memory” is versioned.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
            }
        }
    }

    private func onboardingChatPage() -> some View {
        VStack(spacing: 16) {
            Text("Meet your agent")
                .font(.largeTitle.weight(.semibold))
            Text(
                "This is a dedicated onboarding chat. Your agent will introduce itself, " +
                    "learn who you are, and help you connect WhatsApp or Telegram if you want.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
                .fixedSize(horizontal: false, vertical: true)

            self.onboardingCard(padding: 8) {
                ClawdisChatView(viewModel: self.onboardingChatModel, style: .onboarding)
                    .frame(maxHeight: .infinity)
            }
            .frame(maxHeight: .infinity)
        }
        .padding(.horizontal, 28)
        .frame(width: self.pageWidth, height: self.contentHeight, alignment: .top)
    }

    private func readyPage() -> some View {
        self.onboardingPage {
            Text("All set")
                .font(.largeTitle.weight(.semibold))
            self.onboardingCard {
                if self.state.connectionMode == .unconfigured {
                    self.featureRow(
                        title: "Configure later",
                        subtitle: "Pick Local or Remote in Settings → General whenever you’re ready.",
                        systemImage: "gearshape")
                    Divider()
                        .padding(.vertical, 6)
                }
                if self.state.connectionMode == .remote {
                    self.featureRow(
                        title: "Remote gateway checklist",
                        subtitle: """
                        On your gateway host: install/update the `clawdis` package and make sure credentials exist
                        (typically `~/.clawdis/credentials/oauth.json`). Then connect again if needed.
                        """,
                        systemImage: "network")
                    Divider()
                        .padding(.vertical, 6)
                }
                self.featureRow(
                    title: "Open the menu bar panel",
                    subtitle: "Click the Clawdis menu bar icon for quick chat and status.",
                    systemImage: "bubble.left.and.bubble.right")
                self.featureActionRow(
                    title: "Connect WhatsApp or Telegram",
                    subtitle: "Open Settings → Connections to link providers and monitor status.",
                    systemImage: "link")
                {
                    self.openSettings(tab: .connections)
                }
                self.featureRow(
                    title: "Try Voice Wake",
                    subtitle: "Enable Voice Wake in Settings for hands-free commands with a live transcript overlay.",
                    systemImage: "waveform.circle")
                self.featureRow(
                    title: "Use the panel + Canvas",
                    subtitle: "Open the menu bar panel for quick chat; the agent can show previews " +
                        "and richer visuals in Canvas.",
                    systemImage: "rectangle.inset.filled.and.person.filled")
                self.featureActionRow(
                    title: "Give your agent more powers",
                    subtitle: "Enable optional skills (Peekaboo, oracle, camsnap, …) from Settings → Skills.",
                    systemImage: "sparkles")
                {
                    self.openSettings(tab: .skills)
                }
                Toggle("Launch at login", isOn: self.$state.launchAtLogin)
                    .onChange(of: self.state.launchAtLogin) { _, newValue in
                        AppStateStore.updateLaunchAtLogin(enabled: newValue)
                    }
            }
        }
    }

    private func openSettings(tab: SettingsTab) {
        SettingsTabRouter.request(tab)
        self.openSettings()
        NotificationCenter.default.post(name: .clawdisSelectSettingsTab, object: tab)
    }

    private var navigationBar: some View {
        HStack(spacing: 20) {
            ZStack(alignment: .leading) {
                Button(action: {}, label: {
                    Label("Back", systemImage: "chevron.left").labelStyle(.iconOnly)
                })
                .buttonStyle(.plain)
                .opacity(0)
                .disabled(true)

                if self.currentPage > 0 {
                    Button(action: self.handleBack, label: {
                        Label("Back", systemImage: "chevron.left")
                            .labelStyle(.iconOnly)
                    })
                    .buttonStyle(.plain)
                    .foregroundColor(.secondary)
                    .opacity(0.8)
                    .transition(.opacity.combined(with: .scale(scale: 0.9)))
                }
            }
            .frame(minWidth: 80, alignment: .leading)

            Spacer()

            HStack(spacing: 8) {
                ForEach(0..<self.pageCount, id: \.self) { index in
                    Button {
                        withAnimation { self.currentPage = index }
                    } label: {
                        Circle()
                            .fill(index == self.currentPage ? Color.accentColor : Color.gray.opacity(0.3))
                            .frame(width: 8, height: 8)
                    }
                    .buttonStyle(.plain)
                }
            }

            Spacer()

            Button(action: self.handleNext) {
                Text(self.buttonTitle)
                    .frame(minWidth: 88)
            }
            .keyboardShortcut(.return)
            .buttonStyle(.borderedProminent)
        }
        .padding(.horizontal, 28)
        .padding(.bottom, 13)
        .frame(minHeight: 60, alignment: .bottom)
    }

    private func onboardingPage(@ViewBuilder _ content: () -> some View) -> some View {
        VStack(spacing: 16) {
            content()
            Spacer()
        }
        .padding(.horizontal, 28)
        .frame(width: self.pageWidth, alignment: .top)
    }

    private func onboardingCard(
        spacing: CGFloat = 12,
        padding: CGFloat = 16,
        @ViewBuilder _ content: () -> some View) -> some View
    {
        VStack(alignment: .leading, spacing: spacing) {
            content()
        }
        .padding(padding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color(NSColor.controlBackgroundColor))
                .shadow(color: .black.opacity(0.06), radius: 8, y: 3))
    }

    private func featureRow(title: String, subtitle: String, systemImage: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: systemImage)
                .font(.title3.weight(.semibold))
                .foregroundStyle(Color.accentColor)
                .frame(width: 26)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.headline)
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }

    private func featureActionRow(
        title: String,
        subtitle: String,
        systemImage: String,
        action: @escaping () -> Void) -> some View
    {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: systemImage)
                .font(.title3.weight(.semibold))
                .foregroundStyle(Color.accentColor)
                .frame(width: 26)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.headline)
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Button("Open Settings → Skills", action: action)
                    .buttonStyle(.link)
                    .padding(.top, 2)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
    }

    private func handleBack() {
        withAnimation {
            self.currentPage = max(0, self.currentPage - 1)
        }
    }

    private func handleNext() {
        if self.currentPage < self.pageCount - 1 {
            withAnimation { self.currentPage += 1 }
        } else {
            self.finish()
        }
    }

    private func finish() {
        UserDefaults.standard.set(true, forKey: "clawdis.onboardingSeen")
        UserDefaults.standard.set(currentOnboardingVersion, forKey: onboardingVersionKey)
        OnboardingController.shared.close()
    }

    @MainActor
    private func refreshPerms() async {
        await self.permissionMonitor.refreshNow()
    }

    @MainActor
    private func request(_ cap: Capability) async {
        guard !self.isRequesting else { return }
        self.isRequesting = true
        defer { isRequesting = false }
        _ = await PermissionManager.ensure([cap], interactive: true)
        await self.refreshPerms()
    }

    private func updatePermissionMonitoring(for pageIndex: Int) {
        let shouldMonitor = pageIndex == self.permissionsPageIndex
        if shouldMonitor, !self.monitoringPermissions {
            self.monitoringPermissions = true
            PermissionMonitor.shared.register()
        } else if !shouldMonitor, self.monitoringPermissions {
            self.monitoringPermissions = false
            PermissionMonitor.shared.unregister()
        }
    }

    private func updateDiscoveryMonitoring(for pageIndex: Int) {
        let isConnectionPage = pageIndex == self.connectionPageIndex
        let shouldMonitor = isConnectionPage
        if shouldMonitor, !self.monitoringDiscovery {
            self.monitoringDiscovery = true
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 550_000_000)
                guard self.monitoringDiscovery else { return }
                self.gatewayDiscovery.start()
                await self.refreshLocalGatewayProbe()
            }
        } else if !shouldMonitor, self.monitoringDiscovery {
            self.monitoringDiscovery = false
            self.gatewayDiscovery.stop()
        }
    }

    private func updateMonitoring(for pageIndex: Int) {
        self.updatePermissionMonitoring(for: pageIndex)
        self.updateDiscoveryMonitoring(for: pageIndex)
        self.updateAuthMonitoring(for: pageIndex)
        self.maybeKickoffOnboardingChat(for: pageIndex)
    }

    private func stopPermissionMonitoring() {
        guard self.monitoringPermissions else { return }
        self.monitoringPermissions = false
        PermissionMonitor.shared.unregister()
    }

    private func stopDiscovery() {
        guard self.monitoringDiscovery else { return }
        self.monitoringDiscovery = false
        self.gatewayDiscovery.stop()
    }

    private func updateAuthMonitoring(for pageIndex: Int) {
        let shouldMonitor = pageIndex == self.anthropicAuthPageIndex && self.state.connectionMode == .local
        if shouldMonitor, !self.monitoringAuth {
            self.monitoringAuth = true
            self.startAuthMonitoring()
        } else if !shouldMonitor, self.monitoringAuth {
            self.stopAuthMonitoring()
        }
    }

    private func startAuthMonitoring() {
        self.refreshAnthropicOAuthStatus()
        self.authMonitorTask?.cancel()
        self.authMonitorTask = Task {
            while !Task.isCancelled {
                await MainActor.run { self.refreshAnthropicOAuthStatus() }
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
    }

    private func stopAuthMonitoring() {
        self.monitoringAuth = false
        self.authMonitorTask?.cancel()
        self.authMonitorTask = nil
    }

    private func installCLI() async {
        guard !self.installingCLI else { return }
        self.installingCLI = true
        defer { installingCLI = false }
        await CLIInstaller.install { message in
            await MainActor.run { self.cliStatus = message }
        }
        self.refreshCLIStatus()
    }

    private func refreshCLIStatus() {
        let installLocation = CLIInstaller.installedLocation()
        self.cliInstallLocation = installLocation
        self.cliInstalled = installLocation != nil
    }

    private func refreshLocalGatewayProbe() async {
        let port = GatewayEnvironment.gatewayPort()
        let desc = await PortGuardian.shared.describe(port: port)
        await MainActor.run {
            guard let desc else {
                self.localGatewayProbe = nil
                return
            }
            let command = desc.command.trimmingCharacters(in: .whitespacesAndNewlines)
            let expectedTokens = ["node", "clawdis", "tsx", "pnpm", "bun"]
            let lower = command.lowercased()
            let expected = expectedTokens.contains { lower.contains($0) }
            self.localGatewayProbe = LocalGatewayProbe(
                port: port,
                pid: desc.pid,
                command: command,
                expected: expected)
        }
    }

    private func copyToPasteboard(_ text: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)
        self.copied = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { self.copied = false }
    }

    private func loadWorkspaceDefaults() {
        guard self.workspacePath.isEmpty else { return }
        let configured = ClawdisConfigFile.inboundWorkspace()
        let url = AgentWorkspace.resolveWorkspaceURL(from: configured)
        self.workspacePath = AgentWorkspace.displayPath(for: url)
        self.refreshBootstrapStatus()
    }

    private func ensureDefaultWorkspace() {
        guard self.state.connectionMode == .local else { return }
        let configured = ClawdisConfigFile.inboundWorkspace()
        let url = AgentWorkspace.resolveWorkspaceURL(from: configured)
        switch AgentWorkspace.bootstrapSafety(for: url) {
        case .safe:
            do {
                _ = try AgentWorkspace.bootstrap(workspaceURL: url)
                if (configured ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    ClawdisConfigFile.setInboundWorkspace(AgentWorkspace.displayPath(for: url))
                }
            } catch {
                self.workspaceStatus = "Failed to create workspace: \(error.localizedDescription)"
            }
        case let .unsafe(reason):
            self.workspaceStatus = "Workspace not touched: \(reason)"
        }
        self.refreshBootstrapStatus()
    }

    private func refreshBootstrapStatus() {
        let url = AgentWorkspace.resolveWorkspaceURL(from: self.workspacePath)
        self.needsBootstrap = AgentWorkspace.needsBootstrap(workspaceURL: url)
        if self.needsBootstrap {
            self.didAutoKickoff = false
        }
    }

    private var workspaceBootstrapCommand: String {
        let template = AgentWorkspace.defaultTemplate().trimmingCharacters(in: .whitespacesAndNewlines)
        return """
        mkdir -p ~/.clawdis/workspace
        cat > ~/.clawdis/workspace/AGENTS.md <<'EOF'
        \(template)
        EOF
        """
    }

    private func applyWorkspace() async {
        guard !self.workspaceApplying else { return }
        self.workspaceApplying = true
        defer { self.workspaceApplying = false }

        do {
            let url = AgentWorkspace.resolveWorkspaceURL(from: self.workspacePath)
            if case let .unsafe(reason) = AgentWorkspace.bootstrapSafety(for: url) {
                self.workspaceStatus = "Workspace not created: \(reason)"
                return
            }
            _ = try AgentWorkspace.bootstrap(workspaceURL: url)
            self.workspacePath = AgentWorkspace.displayPath(for: url)
            self.workspaceStatus = "Workspace ready at \(self.workspacePath)"
            self.refreshBootstrapStatus()
        } catch {
            self.workspaceStatus = "Failed to create workspace: \(error.localizedDescription)"
        }
    }

    private func maybeKickoffOnboardingChat(for pageIndex: Int) {
        guard pageIndex == self.onboardingChatPageIndex else { return }
        guard self.needsBootstrap else { return }
        guard !self.didAutoKickoff else { return }
        self.didAutoKickoff = true

        Task { @MainActor in
            for _ in 0..<20 {
                if !self.onboardingChatModel.isLoading { break }
                try? await Task.sleep(nanoseconds: 200_000_000)
            }
            guard self.onboardingChatModel.messages.isEmpty else { return }
            let kickoff =
                "Hi! I just installed Clawdis and you’re my brand‑new agent. " +
                "Please start the first‑run ritual from BOOTSTRAP.md, ask one question at a time, " +
                "and before we talk about WhatsApp/Telegram, visit soul.md with me to craft SOUL.md: " +
                "ask what matters to me and how you should be. Then guide me through choosing " +
                "how we should talk (web‑only, WhatsApp, or Telegram)."
            self.onboardingChatModel.input = kickoff
            self.onboardingChatModel.send()
        }
    }
}

private struct GlowingClawdisIcon: View {
    let size: CGFloat
    let glowIntensity: Double
    let enableFloating: Bool

    @State private var breathe = false

    init(size: CGFloat = 148, glowIntensity: Double = 0.35, enableFloating: Bool = true) {
        self.size = size
        self.glowIntensity = glowIntensity
        self.enableFloating = enableFloating
    }

    var body: some View {
        let glowBlurRadius: CGFloat = 18
        let glowCanvasSize: CGFloat = self.size + 56
        ZStack {
            Circle()
                .fill(
                    LinearGradient(
                        colors: [
                            Color.accentColor.opacity(self.glowIntensity),
                            Color.blue.opacity(self.glowIntensity * 0.6),
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing))
                .frame(width: glowCanvasSize, height: glowCanvasSize)
                .padding(glowBlurRadius)
                .blur(radius: glowBlurRadius)
                .scaleEffect(self.breathe ? 1.08 : 0.96)
                .opacity(0.84)

            Image(nsImage: NSApp.applicationIconImage)
                .resizable()
                .frame(width: self.size, height: self.size)
                .clipShape(RoundedRectangle(cornerRadius: self.size * 0.22, style: .continuous))
                .shadow(color: .black.opacity(0.18), radius: 14, y: 6)
                .scaleEffect(self.breathe ? 1.02 : 1.0)
        }
        .frame(
            width: glowCanvasSize + (glowBlurRadius * 2),
            height: glowCanvasSize + (glowBlurRadius * 2))
        .onAppear {
            guard self.enableFloating else { return }
            withAnimation(Animation.easeInOut(duration: 3.6).repeatForever(autoreverses: true)) {
                self.breathe.toggle()
            }
        }
    }
}
