import AppKit
import OpenClawChatUI
import OpenClawDiscovery
import OpenClawIPC
import SwiftUI

extension OnboardingView {
    @ViewBuilder
    func pageView(for pageIndex: Int) -> some View {
        switch pageIndex {
        case 0:
            self.welcomePage()
        case 1:
            self.connectionPage()
        case 3:
            self.wizardPage()
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

    func welcomePage() -> some View {
        self.onboardingPage {
            VStack(spacing: 22) {
                Text("欢迎使用 OpenClaw")
                    .font(.largeTitle.weight(.semibold))
                Text("OpenClaw 是一款超好用的开源自动控制助手 AI。")
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
                            Text("安全须知")
                                .font(.headline)
                            Text(
                                "连接的 AI 助手（例如 Claude）可以在您的 Mac 上触发强大的操作，" +
                                    "包括运行命令、读取/写入文件和捕捉屏幕截图 —— " +
                                    "这一切取决于您授予它的权限。\n\n" +
                                    "请仅在您了解风险并且信任您所使用的提示词和集成时，" +
                                    "才启用 OpenClaw。")
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

    func connectionPage() -> some View {
        self.onboardingPage {
            Text("选择网关")
                .font(.largeTitle.weight(.semibold))
            Text(
                "OpenClaw 需要连接到一个后台运行的网关（Gateway）。\n" +
                    "对于新用户，请直接选择【在这台电脑上运行】，我们将自动为您安装和启动。")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .frame(maxWidth: 520)
                .fixedSize(horizontal: false, vertical: true)

            self.onboardingCard(spacing: 12, padding: 14) {
                VStack(alignment: .leading, spacing: 10) {
                    self.connectionChoiceButton(
                        title: "在这台电脑上运行 (推荐新用户)",
                        subtitle: self.localGatewaySubtitle,
                        selected: self.state.connectionMode == .local)
                    {
                        self.selectLocalGateway()
                    }

                    Divider().padding(.vertical, 4)

                    self.gatewayDiscoverySection()

                    self.connectionChoiceButton(
                        title: "稍后配置",
                        subtitle: "暂时不启动或连接任何网关。",
                        selected: self.state.connectionMode == .unconfigured)
                    {
                        self.selectUnconfiguredGateway()
                    }

                    self.advancedConnectionSection()
                }
            }
        }
    }

    private var localGatewaySubtitle: String {
        guard let probe = self.localGatewayProbe else {
            return "初次使用？我们将自动为您下载安装并在后台启动网关。"
        }
        let base = probe.expected
            ? "已检测到运行中的本地网关"
            : "端口 \(probe.port) 已被占用"
        let command = probe.command.isEmpty ? "" : " (\(probe.command) pid \(probe.pid))"
        return "\(base)\(command)。即将连接。"
    }

    @ViewBuilder
    private func gatewayDiscoverySection() -> some View {
        HStack(spacing: 8) {
            Image(systemName: "dot.radiowaves.left.and.right")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(self.gatewayDiscovery.statusText)
                .font(.caption)
                .foregroundStyle(.secondary)
            if self.gatewayDiscovery.gateways.isEmpty {
                ProgressView().controlSize(.small)
                Button("刷新") {
                    self.gatewayDiscovery.refreshWideAreaFallbackNow(timeoutSeconds: 5.0)
                }
                .buttonStyle(.link)
                .help("重试 Tailscale 发现 (DNS-SD)。")
            }
            Spacer(minLength: 0)
        }

        if self.gatewayDiscovery.gateways.isEmpty {
            Text("正在搜索附近的网关…")
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.leading, 4)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                Text("附近的网关")
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
    }

    @ViewBuilder
    private func advancedConnectionSection() -> some View {
        Button(self.showAdvancedConnection ? "隐藏高级选项" : "高级选项…") {
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
                        Text("通信方式")
                            .font(.callout.weight(.semibold))
                            .frame(width: labelWidth, alignment: .leading)
                        Picker("Transport", selection: self.$state.remoteTransport) {
                            Text("SSH tunnel").tag(AppState.RemoteTransport.ssh)
                            Text("直连 (ws/wss)").tag(AppState.RemoteTransport.direct)
                        }
                        .pickerStyle(.segmented)
                        .frame(width: fieldWidth)
                    }
                    if self.state.remoteTransport == .direct {
                        GridRow {
                            Text("网关 URL")
                                .font(.callout.weight(.semibold))
                                .frame(width: labelWidth, alignment: .leading)
                            TextField("wss://gateway.example.ts.net", text: self.$state.remoteUrl)
                                .textFieldStyle(.roundedBorder)
                                .frame(width: fieldWidth)
                        }
                    }
                    if self.state.remoteTransport == .ssh {
                        GridRow {
                            Text("SSH 目标地址")
                                .font(.callout.weight(.semibold))
                                .frame(width: labelWidth, alignment: .leading)
                            TextField("user@host[:port]", text: self.$state.remoteTarget)
                                .textFieldStyle(.roundedBorder)
                                .frame(width: fieldWidth)
                        }
                        if let message = CommandResolver
                            .sshTargetValidationMessage(self.state.remoteTarget)
                        {
                            GridRow {
                                Text("")
                                    .frame(width: labelWidth, alignment: .leading)
                                Text(message)
                                    .font(.caption)
                                    .foregroundStyle(.red)
                                    .frame(width: fieldWidth, alignment: .leading)
                            }
                        }
                        GridRow {
                            Text("私钥文件")
                                .font(.callout.weight(.semibold))
                                .frame(width: labelWidth, alignment: .leading)
                            TextField("/Users/you/.ssh/id_ed25519", text: self.$state.remoteIdentity)
                                .textFieldStyle(.roundedBorder)
                                .frame(width: fieldWidth)
                        }
                        GridRow {
                            Text("项目根目录")
                                .font(.callout.weight(.semibold))
                                .frame(width: labelWidth, alignment: .leading)
                            TextField("/home/you/Projects/openclaw", text: self.$state.remoteProjectRoot)
                                .textFieldStyle(.roundedBorder)
                                .frame(width: fieldWidth)
                        }
                        GridRow {
                            Text("CLI 路径")
                                .font(.callout.weight(.semibold))
                                .frame(width: labelWidth, alignment: .leading)
                            TextField(
                                "/Applications/OpenClaw.app/.../openclaw",
                                text: self.$state.remoteCliPath)
                                .textFieldStyle(.roundedBorder)
                                .frame(width: fieldWidth)
                        }
                    }
                }

                Text(self.state.remoteTransport == .direct
                    ? "提示：使用 Tailscale Serve 以确保网关拥有有效的 HTTPS 证书。"
                    : "提示：保持 Tailscale 开启以确保网关始终可达。")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .transition(.opacity.combined(with: .move(edge: .top)))
        }
    }

    func gatewaySubtitle(for gateway: GatewayDiscoveryModel.DiscoveredGateway) -> String? {
        if self.state.remoteTransport == .direct {
            return GatewayDiscoveryHelpers.directUrl(for: gateway) ?? "仅进行网关配对"
        }
        if let target = GatewayDiscoveryHelpers.sshTarget(for: gateway),
           let parsed = CommandResolver.parseSSHTarget(target)
        {
            let portSuffix = parsed.port != 22 ? " · ssh \(parsed.port)" : ""
            return "\(parsed.host)\(portSuffix)"
        }
        return "仅进行网关配对"
    }

    func isSelectedGateway(_ gateway: GatewayDiscoveryModel.DiscoveredGateway) -> Bool {
        guard self.state.connectionMode == .remote else { return false }
        let preferred = self.preferredGatewayID ?? GatewayDiscoveryPreferences.preferredStableID()
        return preferred == gateway.stableID
    }

    func connectionChoiceButton(
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

    func permissionsPage() -> some View {
        self.onboardingPage {
            Text("授予权限")
                .font(.largeTitle.weight(.semibold))
            Text("这些 macOS 权限允许 OpenClaw 在此 Mac 上自动执行操作并获取上下文。")
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
                        Label("强制加载刷新", systemImage: "arrow.clockwise")
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

    func cliPage() -> some View {
        self.onboardingPage {
            Text("安装命令环境 (CLI)")
                .font(.largeTitle.weight(.semibold))
            Text("需要在系统安装全局命令前置依赖支持。")
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

                    Button(self.copied ? "Copied" : "Copy install command") {
                        self.copyToPasteboard(self.devLinkCommand)
                    }
                    .disabled(self.installingCLI)

                    if self.cliInstalled, let loc = self.cliInstallLocation {
                        Label("安装路径: \(loc)", systemImage: "checkmark.circle.fill")
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
                        为 OpenClaw 安装用户空间 Node 22+ 运行环境和 CLI（不依赖 Homebrew）。
                        随时可以重新运行以重新安装或更新。
                        """)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    func workspacePage() -> some View {
        self.onboardingPage {
            Text("智能体工作区")
                .font(.largeTitle.weight(.semibold))
            Text(
                "OpenClaw runs the agent from a dedicated workspace so it can load `AGENTS.md` " +
                    "and write files there without mixing into your other projects.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 560)
                .fixedSize(horizontal: false, vertical: true)

            self.onboardingCard(spacing: 10) {
                if self.state.connectionMode == .remote {
                    Text("监控发现存在的远程网关服务")
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
                            AgentWorkspace.displayPath(for: OpenClawConfigFile.defaultWorkspaceURL()),
                            text: self.$workspacePath)
                            .textFieldStyle(.roundedBorder)

                        HStack(spacing: 12) {
                            Button {
                                Task { await self.applyWorkspace() }
                            } label: {
                                if self.workspaceApplying {
                                    ProgressView()
                                } else {
                                    Text("创建工作区")
                                }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(self.workspaceApplying)

                            Button("打开目录") {
                                let url = AgentWorkspace.resolveWorkspaceURL(from: self.workspacePath)
                                NSWorkspace.shared.open(url)
                            }
                            .buttonStyle(.bordered)
                            .disabled(self.workspaceApplying)

                            Button("Save in config") {
                                Task {
                                    let url = AgentWorkspace.resolveWorkspaceURL(from: self.workspacePath)
                                    let saved = await self.saveAgentWorkspace(AgentWorkspace.displayPath(for: url))
                                    if saved {
                                        self.workspaceStatus =
                                            "Saved to ~/.openclaw/openclaw.json (agents.defaults.workspace)"
                                    }
                                }
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

    func onboardingChatPage() -> some View {
        VStack(spacing: 16) {
            Text("欢迎您的专属机器人")
                .font(.largeTitle.weight(.semibold))
            Text(
                "This is a dedicated onboarding chat. Your agent will introduce itself, " +
                    "learn who you are, and help you connect WhatsApp or Telegram if you want.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
                .fixedSize(horizontal: false, vertical: true)

            self.onboardingGlassCard(padding: 8) {
                OpenClawChatView(viewModel: self.onboardingChatModel, style: .onboarding)
                    .frame(maxHeight: .infinity)
            }
            .frame(maxHeight: .infinity)
        }
        .padding(.horizontal, 28)
        .frame(width: self.pageWidth, height: self.contentHeight, alignment: .top)
    }

    func readyPage() -> some View {
        self.onboardingPage {
            Text("全部就绪")
                .font(.largeTitle.weight(.semibold))
            self.onboardingCard {
                if self.state.connectionMode == .unconfigured {
                    self.featureRow(
                        title: "稍后配置",
                        subtitle: "准备就绪后，随时在 设置 → 常规 中选择本地或远程模式。",
                        systemImage: "gearshape")
                    Divider()
                        .padding(.vertical, 6)
                }
                if self.state.connectionMode == .remote {
                    self.featureRow(
                        title: "远程网关检查清单",
                        subtitle: """
                        在您的网关主机上：安装/更新 `openclaw` 软件包并确保凭据存在（通常位于 `~/.openclaw/credentials/oauth.json`）。然后根据需要重新连接。
                        """,
                        systemImage: "network")
                    Divider()
                        .padding(.vertical, 6)
                }
                self.featureRow(
                    title: "打开菜单栏面板",
                    subtitle: "点击 OpenClaw 菜单栏图标即可进行快速对话和查看状态。",
                    systemImage: "bubble.left.and.bubble.right")
                self.featureActionRow(
                    title: "连接 WhatsApp 或 Telegram",
                    subtitle: "打开 设置 → 频道 以连接频道并监控状态。",
                    systemImage: "link",
                    buttonTitle: "打开 设置 → 频道")
                {
                    self.openSettings(tab: .channels)
                }
                self.featureRow(
                    title: "尝试语音唤醒",
                    subtitle: "在设置中启用语音唤醒，即可通过实时转录叠加层进行免提命令。",
                    systemImage: "waveform.circle")
                self.featureRow(
                    title: "使用面板 + 画板 (Canvas)",
                    subtitle: "打开菜单栏面板进行快速对话；助手可以在画板中显示预览和更丰富的视觉效果。",
                    systemImage: "rectangle.inset.filled.and.person.filled")
                self.featureActionRow(
                    title: "为您的助手赋予更多能力",
                    subtitle: "从 设置 → 技能 中启用可选技能（Peekaboo、oracle、camsnap 等）。",
                    systemImage: "sparkles",
                    buttonTitle: "打开 设置 → 技能")
                {
                    self.openSettings(tab: .skills)
                }
                self.skillsOverview
                Toggle("开机启动 OpenClaw", isOn: self.$state.launchAtLogin)
                    .onChange(of: self.state.launchAtLogin) { _, newValue in
                        AppStateStore.updateLaunchAtLogin(enabled: newValue)
                    }
            }
        }
        .task { await self.maybeLoadOnboardingSkills() }
    }

    private func maybeLoadOnboardingSkills() async {
        guard !self.didLoadOnboardingSkills else { return }
        self.didLoadOnboardingSkills = true
        await self.onboardingSkillsModel.refresh()
    }

    private var skillsOverview: some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider()
                .padding(.vertical, 6)

            HStack(spacing: 10) {
                Text("已包含的技能")
                    .font(.headline)
                Spacer(minLength: 0)
                if self.onboardingSkillsModel.isLoading {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Button("强制加载刷新") {
                        Task { await self.onboardingSkillsModel.refresh() }
                    }
                    .buttonStyle(.link)
                }
            }

            if let error = self.onboardingSkillsModel.error {
                VStack(alignment: .leading, spacing: 4) {
                    Text("无法从网关加载技能。")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.orange)
                    Text(
                        "请确保网关正在运行且已连接，然后点击刷新（或打开 设置 → 技能）。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("详情: \(error)")
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else if self.onboardingSkillsModel.skills.isEmpty {
                Text("无已加载技能插件。")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        ForEach(self.onboardingSkillsModel.skills) { skill in
                            HStack(alignment: .top, spacing: 10) {
                                Text(skill.emoji ?? "✨")
                                    .font(.callout)
                                    .frame(width: 22, alignment: .leading)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(skill.name)
                                        .font(.callout.weight(.semibold))
                                    Text(skill.description)
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                                Spacer(minLength: 0)
                            }
                        }
                    }
                    .padding(10)
                    .background(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(Color(NSColor.windowBackgroundColor)))
                }
                .frame(maxHeight: 160)
            }
        }
    }
}
