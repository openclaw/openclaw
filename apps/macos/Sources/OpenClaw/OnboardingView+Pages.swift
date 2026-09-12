import AppKit
import OpenClawDiscovery
import OpenClawKit
import SwiftUI

extension OnboardingView {
    @ViewBuilder
    func pageView(for pageIndex: Int, contentHeight: CGFloat) -> some View {
        switch pageIndex {
        case 0:
            self.welcomePage()
        case 1:
            self.connectionPage()
        case 2:
            self.cliPage()
        case 3:
            self.aiSetupPage(contentHeight: contentHeight)
        case 9:
            self.readyPage()
        default:
            EmptyView()
        }
    }

    func welcomePage() -> some View {
        onboardingPage {
            VStack(spacing: 18) {
                VStack(spacing: 8) {
                    Text("Welcome to OpenClaw")
                        .font(.largeTitle.weight(.semibold))
                    Text("Your personal AI assistant, living on your own Mac.")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                }
                Text(
                    "It answers questions, works with your files and apps, and can chat with you " +
                        "on WhatsApp or Telegram. Setup takes about two minutes.")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 520)
                    .fixedSize(horizontal: false, vertical: true)

                self.onboardingCard(spacing: 14, padding: 16) {
                    self.featureRow(
                        title: "Ask, create, and automate",
                        subtitle: "Give your assistant tasks and let it help across your Mac.",
                        systemImage: "sparkles")
                    self.featureRow(
                        title: "Chat wherever you like",
                        subtitle: "This app, WhatsApp, Telegram, Discord, Slack — your choice.",
                        systemImage: "bubble.left.and.bubble.right.fill")
                    self.featureRow(
                        title: "Stay in control",
                        subtitle: "Everything runs where you decide, with permissions you grant.",
                        systemImage: "hand.raised.fill")
                }
                .frame(maxWidth: 520)

                Label {
                    Text(
                        "OpenClaw can take actions using the permissions and services you enable. " +
                            "Review prompts and only connect tools you trust.")
                } icon: {
                    Image(systemName: "info.circle")
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: 500, alignment: .leading)
            }
            .padding(.top, 8)
        }
    }

    func connectionPage() -> some View {
        onboardingPage {
            Text("Where should your assistant live?")
                .font(.largeTitle.weight(.semibold))
            Text(
                "Most people pick this Mac — OpenClaw installs everything and keeps it " +
                    "running in the background. You can change this anytime in Settings.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
                .fixedSize(horizontal: false, vertical: true)

            self.onboardingCard(spacing: 12, padding: 14) {
                VStack(alignment: .leading, spacing: 10) {
                    self.connectionChoiceButton(
                        title: "On this Mac",
                        badge: "Recommended",
                        subtitle: self.localGatewaySubtitle,
                        systemImage: "laptopcomputer",
                        selected: self.selectedConnectionMode == .local)
                    {
                        self.selectLocalGateway()
                    }

                    self.connectionChoiceButton(
                        title: "On another computer",
                        badge: nil,
                        subtitle: self.remoteChoiceSubtitle,
                        systemImage: "network",
                        selected: self.selectedConnectionMode == .remote)
                    {
                        self.handleRemoteSelection()
                    }

                    if self.showRemoteChoices || self.selectedConnectionMode == .remote {
                        self.gatewayDiscoverySection()

                        if self.state.connectionMode == .remote {
                            self.remoteConnectionSection()
                        } else {
                            Button("Change connection…") { self.showConnectionEditor = true }
                        }
                    }

                    self.connectionChoiceButton(
                        title: "Connect to an existing Gateway",
                        badge: nil,
                        subtitle: "Enter its address and sign in with your browser.",
                        systemImage: "globe",
                        selected: false)
                    {
                        self.showBrowserGateway = true
                    }
                }
            }

            GatewayConfigConflictRecoveryView(state: self.state)

            HStack {
                Spacer(minLength: 0)
                Button("Set up later") {
                    self.selectUnconfiguredGateway()
                }
                .buttonStyle(.link)
                .font(.callout)
                .foregroundStyle(self.selectedConnectionMode == .unconfigured ? Color.accentColor : .secondary)
                .help("Skip Gateway setup for now; pick Local or Remote later in the Connection window.")
                Spacer(minLength: 0)
            }
            if self.selectedConnectionMode == .unconfigured {
                Text("OK — OpenClaw won’t start anything yet. Pick Local or Remote later in the Connection window.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .multilineTextAlignment(.center)
            }
        }
        .disabled(self.installingCLI)
        .sheet(isPresented: self.$showBrowserGateway) {
            GatewayProfileEditor { _ in
                self.finish(openPrimaryDashboard: false)
            }
        }
        .sheet(isPresented: self.$showConnectionEditor) {
            PrimaryGatewayConnectionEditor(state: self.state, onSave: self.didSaveRemoteConnection)
        }
        .onChange(of: self.state.connectionMode) { _, newValue in
            // The root view's mode observer calls handleConnectionModeChange(), which
            // retires route-owned AI/OpenClaw state. This nested observer owns probe copy only.
            guard Self.shouldResetRemoteProbeFeedback(
                for: newValue,
                suppressReset: self.suppressRemoteProbeReset)
            else { return }
            self.resetRemoteProbeFeedback()
        }
        .onChange(of: state.remoteTransport) { _, _ in
            self.retireGatewayStateForRemoteEndpointEdit()
        }
        .onChange(of: state.remoteTarget) { _, _ in
            self.retireGatewayStateForRemoteEndpointEdit()
        }
        .onChange(of: state.remoteUrl) { _, _ in
            self.retireGatewayStateForRemoteEndpointEdit()
        }
        .onChange(of: state.remoteToken) { _, _ in
            self.retireGatewayStateForRemoteEndpointEdit()
        }
        .onChange(of: state.remoteIdentity) { _, _ in
            self.retireGatewayStateForRemoteEndpointEdit()
        }
    }

    private var localGatewaySubtitle: String {
        guard let probe = localGatewayProbe else {
            return "Private to this computer. Installs and starts automatically."
        }
        return probe.subtitle
    }

    private var remoteChoiceSubtitle: String {
        Self.remoteChoiceSubtitle(discoveredGatewayCount: gatewayDiscovery.gateways.count)
    }

    static func remoteChoiceSubtitle(discoveredGatewayCount count: Int) -> String {
        if count > 0 {
            return count == 1
                ? String(localized: "1 gateway found on your network — click for connection instructions.")
                : String(
                    format: String(
                        localized: "%lld gateways found on your network — click for connection instructions."),
                    count)
        }
        return "For advanced setups — use a gateway that runs elsewhere."
    }

    @ViewBuilder
    private func gatewayDiscoverySection() -> some View {
        // Quiet by design: discovery runs in the background and must not make
        // the page read as "loading" — no spinner, just a status line.
        if gatewayDiscovery.gateways.isEmpty {
            HStack(spacing: 8) {
                Image(systemName: "dot.radiowaves.left.and.right")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                Text("No gateways found on your network yet.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button("Look again") {
                    self.gatewayDiscovery.refreshRemoteFallbackNow(timeoutSeconds: 5.0)
                }
                .buttonStyle(.link)
                .font(.caption)
                .help("Retry discovery (Bonjour + Tailscale DNS-SD).")
                Spacer(minLength: 0)
            }
            .padding(.leading, 4)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(self.gatewayDiscovery.gateways.prefix(6)) { gateway in
                    self.connectionChoiceButton(
                        title: gateway.displayName,
                        badge: nil,
                        subtitle: self.gatewaySubtitle(for: gateway),
                        systemImage: "desktopcomputer",
                        monospacedSubtitle: true,
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
    }

    func retireGatewayStateForRemoteEndpointEdit() {
        self.resetRemoteProbeFeedback()
        // A committed route or credential change retires work for the old connection,
        // but keeps the durable setup lease for the next explicit probe.
        resetGatewayBoundAIState()
    }

    private var remoteProbePreflightMessage: String? {
        switch state.remoteTransport {
        case .direct:
            let trimmedUrl = state.remoteUrl.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmedUrl.isEmpty {
                return "Open connection setup and enter a trusted Gateway address or setup code."
            }
            if GatewayRemoteConfig.normalizeGatewayUrl(trimmedUrl) == nil {
                return GatewayRemoteConfig.directGatewayUrlValidationMessage
            }
            return nil
        case .ssh:
            let trimmedTarget = state.remoteTarget.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmedTarget.isEmpty {
                return "Open connection setup and enter your trusted SSH target."
            }
            return CommandResolver.sshTargetValidationMessage(trimmedTarget)
        }
    }

    private var canProbeRemoteConnection: Bool {
        self.remoteProbePreflightMessage == nil && !self.remoteProbeState.isChecking
    }

    private func remoteConnectionSection() -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Remote connection")
                        .font(.callout.weight(.semibold))
                    Text("Verify OpenClaw can reach this gateway.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Button {
                    Task { await self.probeRemoteConnection(advanceOnSuccess: false) }
                } label: {
                    if self.remoteProbeState.isChecking {
                        ProgressView()
                            .controlSize(.small)
                            .frame(minWidth: 120)
                    } else {
                        Text("Check connection")
                            .frame(minWidth: 120)
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!self.canProbeRemoteConnection)
            }

            // Probe feedback sits with the Check connection button it explains,
            // above the form rows, so grid growth never pushes it out of view.
            if let message = self.remoteProbePreflightMessage, !self.remoteProbeState.isChecking {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            self.remoteProbeStatusView()

            if let issue = self.remoteAuthIssue {
                self.remoteAuthPromptView(issue: issue)
            }

            Button("Change connection…") { self.showConnectionEditor = true }
        }
        .padding(12)
        .background(
            // controlBackgroundColor matches the card fill, so the hairline
            // stroke is what makes this read as a contained panel.
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color(NSColor.controlBackgroundColor))
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(Color(NSColor.separatorColor))))
    }

    @ViewBuilder
    private func remoteProbeStatusView() -> some View {
        switch remoteProbeState {
        case .idle:
            EmptyView()
        case .checking:
            Text("Checking remote gateway…")
                .font(.caption)
                .foregroundStyle(.secondary)
        case let .ok(_, success):
            VStack(alignment: .leading, spacing: 2) {
                Label(success.title, systemImage: "checkmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.green)
                if let detail = success.detail {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        case let .failed(_, message):
            if remoteAuthIssue == nil {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func remoteAuthPromptView(issue: RemoteGatewayAuthIssue) -> some View {
        let promptStyle = Self.remoteAuthPromptStyle(for: issue)
        return HStack(alignment: .top, spacing: 10) {
            Image(systemName: promptStyle.systemImage)
                .font(.caption.weight(.semibold))
                .foregroundStyle(promptStyle.tint)
                .frame(width: 16, alignment: .center)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 4) {
                Text(issue.title)
                    .font(.caption.weight(.semibold))
                Text(.init(issue.body))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let footnote = issue.footnote {
                    Text(.init(footnote))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    @MainActor
    var remoteGatewayProbeInput: RemoteGatewayProbeInput {
        RemoteGatewayProbeInput(
            transport: state.remoteTransport,
            target: state.remoteTransport == .direct ? state.remoteUrl : state.remoteTarget,
            token: state.remoteToken)
    }

    func probeRemoteConnection(advanceOnSuccess: Bool) async {
        let input = self.remoteGatewayProbeInput
        let attemptID = UUID()
        self.remoteProbeAttemptID = attemptID
        let originalMode = state.connectionMode
        if originalMode != .remote {
            // Reuse the shared remote endpoint stack for probing without committing the user's mode choice.
            if self.remoteProbeTemporaryRestoreMode == nil {
                self.remoteProbeTemporaryRestoreMode = originalMode
                configuredGatewayProbe.beginTemporaryConnectionCheck()
            }
            state.connectionMode = .remote
        }
        remoteProbeState = .checking(input)
        remoteAuthIssue = nil
        defer {
            if Self.ownsRemoteGatewayProbeAttempt(
                attemptID: attemptID,
                currentAttemptID: self.remoteProbeAttemptID)
            {
                self.remoteProbeAttemptID = nil
                self.finishTemporaryRemoteProbeIfNeeded()
            }
        }
        let result = await RemoteGatewayProbe.run()
        guard Self.shouldAcceptRemoteGatewayProbeResult(
            attemptID: attemptID,
            currentAttemptID: self.remoteProbeAttemptID,
            probeState: self.remoteProbeState,
            expectedInput: input,
            currentInput: self.remoteGatewayProbeInput)
        else {
            return
        }
        switch result {
        case let .ready(success):
            remoteProbeState = .ok(input, success)
            if advanceOnSuccess,
               state.connectionMode == .remote,
               activePageIndex == connectionPageIndex
            {
                self.handleNext()
            }
        case let .authIssue(issue):
            remoteAuthIssue = issue
            remoteProbeState = .failed(input, issue.statusMessage)
        case let .failed(message):
            remoteProbeState = .failed(input, message)
        }
    }

    func resetRemoteProbeFeedback() {
        remoteProbeAttemptID = nil
        self.finishTemporaryRemoteProbeIfNeeded()
        remoteProbeState = .idle
        remoteAuthIssue = nil
    }

    private func finishTemporaryRemoteProbeIfNeeded() {
        guard let restoreMode = self.remoteProbeTemporaryRestoreMode else { return }
        self.remoteProbeTemporaryRestoreMode = nil
        self.suppressRemoteProbeReset = true
        self.state.connectionMode = restoreMode
        self.suppressRemoteProbeReset = false
        self.configuredGatewayProbe.endTemporaryConnectionCheck()
    }

    static func ownsRemoteGatewayProbeAttempt(
        attemptID: UUID,
        currentAttemptID: UUID?) -> Bool
    {
        currentAttemptID == attemptID
    }

    static func shouldAcceptRemoteGatewayProbeResult(
        attemptID: UUID,
        currentAttemptID: UUID?,
        probeState: RemoteOnboardingProbeState,
        expectedInput: RemoteGatewayProbeInput,
        currentInput: RemoteGatewayProbeInput) -> Bool
    {
        self.ownsRemoteGatewayProbeAttempt(attemptID: attemptID, currentAttemptID: currentAttemptID) &&
            probeState == .checking(expectedInput) &&
            currentInput == expectedInput
    }

    static func remoteAuthPromptStyle(
        for issue: RemoteGatewayAuthIssue)
        -> (systemImage: String, tint: Color)
    {
        switch issue {
        case .tokenRequired:
            ("key.fill", .orange)
        case .tokenMismatch:
            ("exclamationmark.triangle.fill", .orange)
        case .gatewayTokenNotConfigured:
            ("wrench.and.screwdriver.fill", .orange)
        case .setupCodeExpired:
            ("qrcode.viewfinder", .orange)
        case .passwordRequired:
            ("lock.slash.fill", .orange)
        case .pairingRequired:
            ("link.badge.plus", .orange)
        }
    }

    static func shouldResetRemoteProbeFeedback(
        for connectionMode: AppState.ConnectionMode,
        suppressReset: Bool) -> Bool
    {
        !suppressReset && connectionMode != .remote
    }

    func gatewaySubtitle(for gateway: GatewayDiscoveryModel.DiscoveredGateway) -> String? {
        if state.remoteTransport == .direct {
            return GatewayDiscoveryHelpers.directUrl(for: gateway) ?? "Gateway pairing only"
        }
        if let target = GatewayDiscoveryHelpers.sshTarget(for: gateway),
           let parsed = CommandResolver.parseSSHTarget(target)
        {
            let portSuffix = parsed.port != 22 ? " · ssh \(parsed.port)" : ""
            return "\(parsed.host)\(portSuffix)"
        }
        return "Gateway pairing only"
    }

    func isSelectedGateway(_ gateway: GatewayDiscoveryModel.DiscoveredGateway) -> Bool {
        guard state.connectionMode == .remote else { return false }
        return effectivePreferredGatewayID == gateway.stableID
    }

    func connectionChoiceButton(
        title: String,
        badge: String? = nil,
        subtitle: String?,
        systemImage: String? = nil,
        monospacedSubtitle: Bool = false,
        selected: Bool,
        action: @escaping () -> Void) -> some View
    {
        Button {
            withAnimation(.spring(response: 0.25, dampingFraction: 0.9)) {
                action()
            }
        } label: {
            HStack(alignment: .center, spacing: 12) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(selected ? Color.accentColor : Color.secondary)
                        .frame(width: 26)
                }
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(title)
                            .font(.callout.weight(.semibold))
                            .lineLimit(1)
                            .truncationMode(.tail)
                        if let badge {
                            Text(badge)
                                .font(.caption2.weight(.semibold))
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Capsule().fill(Color.accentColor.opacity(0.16)))
                                .foregroundStyle(Color.accentColor)
                        }
                    }
                    if let subtitle {
                        Text(subtitle)
                            .font(monospacedSubtitle ? .caption.monospaced() : .caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .truncationMode(.middle)
                            .multilineTextAlignment(.leading)
                    }
                }
                Spacer(minLength: 0)
                SelectionStateIndicator(selected: selected)
            }
            .openClawSelectableRowChrome(selected: selected)
        }
        .buttonStyle(.plain)
    }

    func cliPage() -> some View {
        let detail = "OpenClaw is setting up its Gateway background service on this Mac. " +
            "Published Stable and Beta installs are usually quick. " +
            "Dev (Git main) downloads and builds OpenClaw from source, so allow several minutes " +
            "and several gigabytes of free space. No administrator password is required."
        return onboardingPage {
            Text("Getting things ready")
                .font(.largeTitle.weight(.semibold))
            Text(detail)
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
                .fixedSize(horizontal: false, vertical: true)

            self.onboardingCard(spacing: 14, padding: 16) {
                self.installStepRow(
                    title: "Install OpenClaw",
                    detail: self.cliExecutableReady
                        ? (self.cliInstallLocation ?? "Installed")
                        : "A private copy inside your user folder.",
                    state: self.installStepStateForInstall,
                    monospacedDetail: self.cliExecutableReady && self.cliInstallLocation != nil)
                self.installStepRow(
                    title: "Start the background service",
                    detail: "Runs quietly and starts again after a restart.",
                    state: self.installStepStateForService)
                self.installStepRow(
                    title: "Ready for the next step",
                    detail: "Once the service answers, you’ll connect your AI.",
                    state: self.cliInstalled ? .done : .pending)

                if self.installFailed {
                    OnboardingErrorCard(
                        title: self.cliExecutableReady
                            ? "The Gateway didn’t start"
                            : "OpenClaw installation failed",
                        message: self.cliStatus ?? "The installer did not finish.",
                        docsSlug: "platforms/mac/bundled-gateway",
                        retryTitle: "Try again")
                    {
                        if self.cliExecutableReady {
                            self.startExistingCLIActivationIfNeeded()
                        } else {
                            self.startCLIInstall()
                        }
                    }
                } else if let cliStatus, !self.cliInstalled {
                    Text(cliStatus)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var installFailed: Bool {
        cliStatusKnown && !installingCLI && !cliInstalled
    }

    /// Exactly one spinner at a time: the install row finishes before the
    /// service row starts, mirroring the actual runCLIInstall phases.
    private var installStepStateForInstall: InstallStepState {
        Self.cliInstallStepStates(
            executableReady: self.cliExecutableReady,
            gatewayReady: self.cliInstalled,
            statusKnown: self.cliStatusKnown,
            installing: self.installingCLI,
            phase: self.cliInstallPhase).install
    }

    private var installStepStateForService: InstallStepState {
        Self.cliInstallStepStates(
            executableReady: self.cliExecutableReady,
            gatewayReady: self.cliInstalled,
            statusKnown: self.cliStatusKnown,
            installing: self.installingCLI,
            phase: self.cliInstallPhase).service
    }

    static func cliInstallStepStates(
        executableReady: Bool,
        gatewayReady: Bool,
        statusKnown: Bool,
        installing: Bool,
        phase: CLIInstallPhase) -> (install: InstallStepState, service: InstallStepState)
    {
        let install: InstallStepState = if executableReady || gatewayReady {
            .done
        } else if installing {
            if phase == .choosingTarget {
                .pending
            } else if phase == .startingService {
                .done
            } else {
                .running
            }
        } else if statusKnown {
            .failed
        } else {
            .running
        }

        let service: InstallStepState = if gatewayReady {
            .done
        } else if installing {
            phase == .startingService ? .running : .pending
        } else if statusKnown, executableReady {
            .failed
        } else {
            .pending
        }

        return (install, service)
    }

    enum InstallStepState {
        case pending
        case running
        case done
        case failed
    }

    private func installStepRow(
        title: String,
        detail: String,
        state: InstallStepState,
        monospacedDetail: Bool = false) -> some View
    {
        HStack(alignment: .top, spacing: 12) {
            Group {
                switch state {
                case .pending:
                    Image(systemName: "circle.dotted")
                        .foregroundStyle(.tertiary)
                case .running:
                    ProgressView()
                        .controlSize(.small)
                case .done:
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                case .failed:
                    Image(systemName: "exclamationmark.circle.fill")
                        .foregroundStyle(.orange)
                }
            }
            .font(.title3)
            .frame(width: 26, height: 22)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(state == .pending ? Color.secondary : Color.primary)
                Text(detail)
                    .font(monospacedDetail ? .caption.monospaced() : .caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .lineLimit(2)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 0)
        }
    }

    func readyPage() -> some View {
        onboardingPage {
            Text("You’re all set!")
                .font(.largeTitle.weight(.semibold))
            self.onboardingCard {
                self.featureRow(
                    title: "Configure later",
                    subtitle: "Pick Local or Remote in the Connection window whenever you’re ready.",
                    systemImage: "gearshape")
                Divider()
                    .padding(.vertical, 6)
                self.featureRow(
                    title: "Open the menu bar panel",
                    subtitle: "Click the OpenClaw menu bar icon for the compact chat panel and status.",
                    systemImage: "bubble.left.and.bubble.right")
                self.featureActionRow(
                    title: "Connect Discord, Slack, Telegram, WhatsApp, …",
                    subtitle: "Open Dashboard → Settings → Channels to link channels and monitor status.",
                    systemImage: "link",
                    buttonTitle: "Open Dashboard → Settings → Channels")
                {
                    Task { await DashboardManager.shared.show(atPath: DashboardRouteMap.channelsSettingsPath) }
                }
                self.featureRow(
                    title: "Try Voice Wake",
                    subtitle: "Enable Voice Wake in Dashboard → Settings → Talk for hands-free commands " +
                        "with a live transcript overlay.",
                    systemImage: "waveform.circle")
                self.featureRow(
                    title: "Use the panel + Canvas",
                    subtitle: "Open the compact chat panel; the agent can show previews " +
                        "and richer visuals in Canvas.",
                    systemImage: "rectangle.inset.filled.and.person.filled")
                self.featureActionRow(
                    title: "Give your agent more powers",
                    subtitle: "Enable optional skills (Peekaboo, oracle, camsnap, …) from Dashboard → Skills.",
                    systemImage: "sparkles",
                    buttonTitle: "Open Dashboard → Skills")
                {
                    Task { await DashboardManager.shared.show(atPath: DashboardRouteMap.skillsPagePath) }
                }
                if AppProfile.current.isActive {
                    LabeledContent("Launch at login", value: "Unavailable under profile")
                } else {
                    Toggle("Launch at login", isOn: self.$state.launchAtLogin)
                        .disabled(!self.state.bundleLocationAllowsPersistentIntegration && !self.state.launchAtLogin)
                }
            }
        }
    }
}

extension RemoteOnboardingProbeState {
    var isChecking: Bool {
        if case .checking = self { return true }
        return false
    }
}
