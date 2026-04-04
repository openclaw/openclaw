import Observation
import SwiftUI

struct ControlDashboardView: View {
    private enum EntryAction {
        case chat
        case cases
        case refresh
        case settings
    }

    @Bindable var router: WebChatWorkspaceRouter
    @Bindable var state: AppState

    private let healthStore = HealthStore.shared
    private let gatewayManager = GatewayProcessManager.shared
    private let controlChannel = ControlChannel.shared
    private let activityStore = WorkActivityStore.shared
    private let columns = [
        GridItem(.flexible(minimum: 150), spacing: 12, alignment: .topLeading),
        GridItem(.flexible(minimum: 150), spacing: 12, alignment: .topLeading),
    ]
    @State private var breathe = false

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [
                    Color(red: 0.97, green: 0.96, blue: 0.94),
                    Color(red: 0.95, green: 0.96, blue: 0.95),
                    Color(red: 0.92, green: 0.95, blue: 0.98),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing)
                .ignoresSafeArea()

            Ellipse()
                .fill(self.dashboardAccent.opacity(self.healthStore.state == .ok ? 0.14 : 0.20))
                .frame(width: 440, height: 276)
                .blur(radius: 92)
                .offset(x: -228, y: self.breathe ? -118 : -86)

            Ellipse()
                .fill(Color.white.opacity(0.22))
                .frame(width: 360, height: 208)
                .blur(radius: 78)
                .offset(x: 72, y: self.breathe ? -52 : -28)

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    self.systemStatusCard
                    self.heroCard

                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .top, spacing: 16) {
                            self.quickActionsCard
                                .frame(maxWidth: .infinity)

                            VStack(spacing: 16) {
                                self.liveActivityCard
                                self.mainSessionCard
                            }
                            .frame(maxWidth: .infinity)
                        }

                        VStack(spacing: 16) {
                            self.quickActionsCard
                            self.liveActivityCard
                            self.mainSessionCard
                        }
                    }
                }
                .padding(20)
            }
            .scrollIndicators(.hidden)
        }
        .task {
            if self.healthStore.snapshot == nil {
                await self.refreshStatus()
            }
        }
        .onAppear {
            guard !self.breathe else { return }
            withAnimation(.easeInOut(duration: 4.2).repeatForever(autoreverses: true)) {
                self.breathe = true
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    private var heroCard: some View {
        ZStack(alignment: .topTrailing) {
            RoundedRectangle(cornerRadius: 34, style: .continuous)
                .fill(.clear)
                .background(
                    VisualEffectView(
                        material: .underWindowBackground,
                        blendingMode: .withinWindow,
                        emphasized: false)
                )
                .clipShape(RoundedRectangle(cornerRadius: 34, style: .continuous))

            RoundedRectangle(cornerRadius: 34, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [
                            Color.white.opacity(0.62),
                            self.dashboardAccent.opacity(0.14),
                            Color.white.opacity(0.10),
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing))

            Ellipse()
                .fill(self.dashboardAccent.opacity(0.18))
                .frame(width: 336, height: 214)
                .blur(radius: 82)
                .offset(x: -154, y: -102)

            Ellipse()
                .fill(Color.white.opacity(0.36))
                .frame(width: 250, height: 144)
                .blur(radius: 56)
                .offset(x: 74, y: -18)

            ViewThatFits(in: .horizontal) {
                HStack(alignment: .top, spacing: 28) {
                    self.heroCopyColumn
                    Spacer(minLength: 0)
                    self.heroSessionOrb
                }

                VStack(alignment: .leading, spacing: 20) {
                    self.heroSessionOrb
                        .frame(maxWidth: .infinity, alignment: .trailing)
                    self.heroCopyColumn
                }
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .padding(22)
        }
        .overlay(
            RoundedRectangle(cornerRadius: 34, style: .continuous)
                .stroke(
                    LinearGradient(
                        colors: [
                            Color.white.opacity(0.52),
                            Color.white.opacity(0.16),
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing),
                    lineWidth: 0.8)
        )
        .shadow(color: Color(red: 0.44, green: 0.58, blue: 0.72).opacity(0.10), radius: 28, x: 0, y: 16)
        .shadow(color: .white.opacity(0.14), radius: 10, y: -4)
    }

    private var systemStatusCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Summary")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text(self.dashboardSummaryLine)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(2)
                }

                Spacer(minLength: 0)

                if self.healthStore.isRefreshing {
                    ProgressView()
                        .controlSize(.small)
                        .tint(Color(red: 0.42, green: 0.69, blue: 0.96))
                }
            }

            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) {
                    self.signalTile(
                        symbol: "bolt.horizontal.circle.fill",
                        title: "Gateway",
                        value: self.gatewayManager.status.label,
                        tint: self.gatewayStatusTint)
                    self.signalTile(
                        symbol: "waveform.path.ecg",
                        title: "Lane",
                        value: self.controlStatusText,
                        tint: self.controlStatusTint)
                    self.signalTile(
                        symbol: "scope",
                        title: "Mode",
                        value: self.connectionModeLabel,
                        tint: self.connectionModeTint)
                    self.signalTile(
                        symbol: "timer",
                        title: "Latency",
                        value: self.controlChannel.lastPingMs.map { "\(Int($0))ms" } ?? "—",
                        tint: .secondary)
                }

                VStack(spacing: 12) {
                    self.signalTile(
                        symbol: "bolt.horizontal.circle.fill",
                        title: "Gateway",
                        value: self.gatewayManager.status.label,
                        tint: self.gatewayStatusTint)
                    self.signalTile(
                        symbol: "waveform.path.ecg",
                        title: "Lane",
                        value: self.controlStatusText,
                        tint: self.controlStatusTint)
                    self.signalTile(
                        symbol: "scope",
                        title: "Mode",
                        value: self.connectionModeLabel,
                        tint: self.connectionModeTint)
                    self.signalTile(
                        symbol: "timer",
                        title: "Latency",
                        value: self.controlChannel.lastPingMs.map { "\(Int($0))ms" } ?? "—",
                        tint: .secondary)
                }
            }
        }
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .fill(Color.white.opacity(0.38))
                .overlay(
                    RoundedRectangle(cornerRadius: 28, style: .continuous)
                        .fill(
                            LinearGradient(
                                colors: [
                                    Color.white.opacity(0.28),
                                    Color(red: 0.83, green: 0.90, blue: 0.97).opacity(0.16),
                                ],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing)))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .stroke(Color.white.opacity(0.24), lineWidth: 0.8)
        )
        .shadow(color: Color(red: 0.43, green: 0.57, blue: 0.72).opacity(0.08), radius: 24, y: 12)
    }

    private var heroCopyColumn: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 8) {
                Text("VERICLAW")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.secondary)

                StatusPill(text: self.healthBadgeText, tint: self.healthBadgeTint)
            }

            Text(self.systemHeadline)
                .font(.system(size: 34, weight: .semibold, design: .rounded))
                .tracking(-0.7)
                .lineLimit(2)
                .frame(maxWidth: 380, alignment: .leading)

            Text(self.heroSupportLine)
                .font(.system(size: 14, weight: .medium, design: .rounded))
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .frame(maxWidth: 320, alignment: .leading)

            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    StatusPill(text: self.connectionModeLabel, tint: self.connectionModeTint)
                    StatusPill(text: self.controlStatusText, tint: self.controlStatusTint)
                    if let ping = self.controlChannel.lastPingMs {
                        StatusPill(text: "\(Int(ping))ms", tint: .secondary)
                    }
                }

                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        StatusPill(text: self.connectionModeLabel, tint: self.connectionModeTint)
                        StatusPill(text: self.controlStatusText, tint: self.controlStatusTint)
                    }
                    if let ping = self.controlChannel.lastPingMs {
                        StatusPill(text: "\(Int(ping))ms", tint: .secondary)
                    }
                }
            }

            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) {
                    self.heroPrimaryAction(
                        title: self.primaryHeroActionTitle,
                        systemImage: self.primaryHeroActionSymbol)
                    {
                        self.performPrimaryHeroAction()
                    }

                    self.heroGlyphAction(
                        systemImage: "bubble.left.and.bubble.right.fill",
                        tint: Color(red: 0.42, green: 0.69, blue: 0.96))
                    {
                        withAnimation(.spring(response: 0.32, dampingFraction: 0.88)) {
                            self.router.selectedMode = .chat
                        }
                    }

                    self.heroGlyphAction(
                        systemImage: "cross.case.fill",
                        tint: Color(red: 0.97, green: 0.63, blue: 0.37))
                    {
                        withAnimation(.spring(response: 0.32, dampingFraction: 0.88)) {
                            self.router.selectedMode = .correction
                        }
                    }

                    self.heroGlyphAction(
                        systemImage: self.healthStore.state == .linkingNeeded ? "gearshape.fill" : "arrow.clockwise",
                        tint: Color(red: 0.62, green: 0.72, blue: 0.84))
                    {
                        if self.healthStore.state == .linkingNeeded {
                            self.openSettings(tab: .general)
                        } else {
                            Task { await self.refreshStatus() }
                        }
                    }
                }

                VStack(alignment: .leading, spacing: 10) {
                    self.heroPrimaryAction(
                        title: self.primaryHeroActionTitle,
                        systemImage: self.primaryHeroActionSymbol)
                    {
                        self.performPrimaryHeroAction()
                    }

                    HStack(spacing: 8) {
                        self.heroGlyphAction(
                            systemImage: "bubble.left.and.bubble.right.fill",
                            tint: Color(red: 0.42, green: 0.69, blue: 0.96))
                        {
                            withAnimation(.spring(response: 0.32, dampingFraction: 0.88)) {
                                self.router.selectedMode = .chat
                            }
                        }

                        self.heroGlyphAction(
                            systemImage: "cross.case.fill",
                            tint: Color(red: 0.97, green: 0.63, blue: 0.37))
                        {
                            withAnimation(.spring(response: 0.32, dampingFraction: 0.88)) {
                                self.router.selectedMode = .correction
                            }
                        }

                        self.heroGlyphAction(
                            systemImage: self.healthStore.state == .linkingNeeded ? "gearshape.fill" : "arrow.clockwise",
                            tint: Color(red: 0.62, green: 0.72, blue: 0.84))
                        {
                            if self.healthStore.state == .linkingNeeded {
                                self.openSettings(tab: .general)
                            } else {
                                Task { await self.refreshStatus() }
                            }
                        }
                    }
                }
            }
        }
    }

    private var heroSessionOrb: some View {
        ZStack {
            Circle()
                .fill(self.dashboardAccent.opacity(0.16))
                .frame(width: 176, height: 176)
                .blur(radius: 24)
                .offset(x: -16, y: -18)

            Circle()
                .fill(Color.white.opacity(0.20))
                .frame(width: 184, height: 184)
                .blur(radius: 26)
                .offset(x: 20, y: 20)

            Circle()
                .fill(
                    LinearGradient(
                        colors: [
                            Color.white.opacity(0.72),
                            self.dashboardAccent.opacity(0.20),
                            Color.white.opacity(0.14),
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing))
                .frame(width: 136, height: 136)
                .overlay(
                    Circle()
                        .strokeBorder(Color.white.opacity(0.42), lineWidth: 0.8)
                )
                .shadow(color: Color(red: 0.55, green: 0.80, blue: 1.00).opacity(0.12), radius: 24, y: 18)

            Circle()
                .fill(Color.white.opacity(0.38))
                .frame(width: 42, height: 42)
                .blur(radius: 10)
                .offset(x: self.breathe ? -26 : 10, y: self.breathe ? -26 : -44)

            VStack(spacing: 10) {
                VeriClawBrandTile(size: 56)

                Text(self.shortMainSessionKey)
                    .font(.system(size: 18, weight: .semibold, design: .rounded))
                    .lineLimit(1)
                    .minimumScaleFactor(0.68)
                Text(self.heroOrbCaption)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 118)
            }

            StatusPill(text: self.connectionModeLabel, tint: self.connectionModeTint)
                .offset(x: -70, y: -54)

            if let ping = self.controlChannel.lastPingMs {
                StatusPill(text: "\(Int(ping))ms", tint: .secondary)
                    .offset(x: 78, y: 58)
            }
        }
        .frame(width: 196, height: 180)
    }

    private var mainSessionCard: some View {
        ControlDashboardCard(
            eyebrow: "Main",
            title: self.activityStore.mainSessionKey,
            detail: "Current seat",
            accent: Color(red: 0.87, green: 0.92, blue: 1.00))
        {
            VStack(alignment: .leading, spacing: 12) {
                if let current = self.activityStore.current {
                    StatusPill(
                        text: current.role == .main ? "Active" : "Redirected",
                        tint: current.role == .main ? .blue : .secondary)
                    Text(current.label)
                        .font(.body.weight(.semibold))
                        .lineLimit(2)
                    Text(current.sessionKey)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                } else {
                    Text("No active seat.")
                        .font(.body.weight(.semibold))
                    StatusPill(text: "Idle", tint: .secondary)
                }
            }
        }
    }

    private var liveActivityCard: some View {
        ControlDashboardCard(
            eyebrow: "Detail",
            title: self.activityHeadline,
            detail: self.refreshLine,
            accent: Color(red: 0.90, green: 0.94, blue: 1.00))
        {
            VStack(alignment: .leading, spacing: 12) {
                if let current = self.activityStore.current {
                    HStack(spacing: 8) {
                        StatusPill(
                            text: current.role == .main ? "Main" : "Other",
                            tint: current.role == .main ? .blue : .secondary)
                        StatusPill(text: self.activityKindLabel(current.kind), tint: .secondary)
                    }
                }

                if let lastToolLabel = self.activityStore.lastToolLabel, !lastToolLabel.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Tool")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        Text(lastToolLabel)
                            .font(.callout)
                            .lineLimit(2)
                    }
                } else {
                    StatusPill(text: "Idle", tint: .secondary)
                    Text("Open Chat or Cases.")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var quickActionsCard: some View {
        ControlDashboardCard(
            eyebrow: "Intervene",
            title: "Next move",
            detail: "Fast lanes",
            accent: Color(red: 0.84, green: 0.92, blue: 1.00))
        {
            LazyVGrid(columns: self.columns, alignment: .leading, spacing: 12) {
                self.actionButton(
                    title: "Chat",
                    detail: "Steer",
                    systemImage: "bubble.left.and.bubble.right.fill",
                    tint: Color(red: 0.76, green: 0.88, blue: 1.00),
                    isRecommended: self.recommendedEntryAction == .chat)
                {
                    withAnimation(.spring(response: 0.32, dampingFraction: 0.88)) {
                        self.router.selectedMode = .chat
                    }
                }

                self.actionButton(
                    title: "Cases",
                    detail: "Diagnose",
                    systemImage: "cross.case.fill",
                    tint: Color(red: 0.82, green: 0.90, blue: 1.00),
                    isRecommended: self.recommendedEntryAction == .cases)
                {
                    withAnimation(.spring(response: 0.32, dampingFraction: 0.88)) {
                        self.router.selectedMode = .correction
                    }
                }

                self.actionButton(
                    title: "Refresh",
                    detail: "Signal",
                    systemImage: "arrow.clockwise",
                    tint: Color(red: 0.89, green: 0.94, blue: 1.00),
                    isRecommended: self.recommendedEntryAction == .refresh)
                {
                    Task { await self.refreshStatus() }
                }

                self.actionButton(
                    title: "Settings",
                    detail: "Runtime",
                    systemImage: "gearshape.fill",
                    tint: Color(red: 0.92, green: 0.95, blue: 1.00),
                    isRecommended: self.recommendedEntryAction == .settings)
                {
                    self.openSettings(tab: .general)
                }
            }
        }
    }

    private var refreshLine: String {
        if self.healthStore.isRefreshing {
            return "Refreshing…"
        }
        if let lastSuccess = self.healthStore.lastSuccess {
            return "Updated \(lastSuccess.formatted(date: .omitted, time: .shortened))"
        }
        if let lastError = self.healthStore.lastError, !lastError.isEmpty {
            return "Needs attention"
        }
        return "Not loaded"
    }

    private var shortMainSessionKey: String {
        let value = self.activityStore.mainSessionKey
        guard value.count > 12 else { return value }
        return String(value.prefix(12))
    }

    private var dashboardAccent: Color {
        switch self.healthStore.state {
        case .ok:
            Color(red: 0.55, green: 0.77, blue: 0.98)
        case .linkingNeeded:
            Color(red: 0.94, green: 0.48, blue: 0.37)
        case .degraded:
            Color(red: 0.97, green: 0.67, blue: 0.38)
        case .unknown:
            Color(red: 0.72, green: 0.79, blue: 0.88)
        }
    }

    private var dashboardSummaryLine: String {
        switch self.healthStore.state {
        case .ok:
            return self.activityStore.current == nil ? "System ready. Choose a lane." : "System ready. One seat is live."
        case .linkingNeeded:
            return "Gateway link required."
        case .degraded:
            return "Signal degraded. Open Cases."
        case .unknown:
            return "Refresh to get live signal."
        }
    }

    private var systemHeadline: String {
        switch self.healthStore.state {
        case .ok:
            "System ready"
        case .linkingNeeded:
            "Gateway linking needed"
        case .degraded:
            "Attention needed"
        case .unknown:
            "Waiting for a live snapshot"
        }
    }

    private var recommendedEntryAction: EntryAction {
        switch self.healthStore.state {
        case .degraded:
            return .cases
        case .linkingNeeded:
            return .settings
        case .unknown:
            return .refresh
        case .ok:
            return .chat
        }
    }

    private var primaryHeroActionTitle: String {
        switch self.healthStore.state {
        case .degraded:
            return "Open Cases"
        case .linkingNeeded:
            return "Open Settings"
        case .unknown:
            return "Refresh Status"
        case .ok:
            return self.activityStore.current == nil ? "Open Chat" : "Continue Chat"
        }
    }

    private var heroSupportLine: String {
        switch self.healthStore.state {
        case .degraded:
            return "Start in Cases."
        case .linkingNeeded:
            return "Repair the gateway path first."
        case .unknown:
            return "Refresh before choosing a lane."
        case .ok:
            return self.activityStore.current == nil
                ? "System is ready."
                : "A live thread is already in motion."
        }
    }

    private var heroOrbCaption: String {
        if let current = self.activityStore.current {
            return current.role == .main ? "live seat" : "redirected"
        }
        return self.refreshLine
    }

    private var primaryHeroActionSymbol: String {
        switch self.healthStore.state {
        case .degraded:
            return "cross.case.fill"
        case .linkingNeeded:
            return "gearshape.fill"
        case .unknown:
            return "arrow.clockwise"
        case .ok:
            return "bubble.left.and.bubble.right.fill"
        }
    }

    private var activityHeadline: String {
        guard let current = self.activityStore.current else {
            return "Quiet"
        }
        return current.role == .main ? "Main seat live" : "Other seat live"
    }

    private var healthBadgeText: String {
        switch self.healthStore.state {
        case .ok:
            "Healthy"
        case .linkingNeeded:
            "Link"
        case .degraded:
            "Alert"
        case .unknown:
            "Checking"
        }
    }

    private var healthBadgeTint: Color {
        switch self.healthStore.state {
        case .ok:
            .green
        case .linkingNeeded:
            .red
        case .degraded:
            .orange
        case .unknown:
            .secondary
        }
    }

    private var gatewayStatusTint: Color {
        switch self.gatewayManager.status {
        case .running, .attachedExisting:
            .green
        case .starting:
            .blue
        case .failed:
            .orange
        case .stopped:
            .secondary
        }
    }

    private var controlStatusText: String {
        switch self.controlChannel.state {
        case .connected:
            return "Connected"
        case .connecting:
            return "Connecting…"
        case .disconnected:
            return "Disconnected"
        case let .degraded(message):
            return message.isEmpty ? "Needs attention" : message
        }
    }

    private var controlStatusTint: Color {
        switch self.controlChannel.state {
        case .connected:
            .green
        case .connecting:
            .blue
        case .disconnected:
            .secondary
        case .degraded:
            .orange
        }
    }

    private var connectionModeLabel: String {
        switch self.state.connectionMode {
        case .local:
            "Local"
        case .remote:
            "Remote"
        case .unconfigured:
            "Setup"
        }
    }

    private var connectionModeTint: Color {
        switch self.state.connectionMode {
        case .local:
            .green
        case .remote:
            .blue
        case .unconfigured:
            .orange
        }
    }

    private func activityKindLabel(_ kind: ActivityKind) -> String {
        switch kind {
        case .job:
            "Job"
        case let .tool(toolKind):
            toolKind.rawValue.capitalized
        }
    }

    private func shortStatusText(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count > 22 else { return trimmed }
        return String(trimmed.prefix(22)) + "…"
    }

    private func signalTile(symbol: String, title: String, value: String, tint: Color) -> some View {
        let baseTint = tint == .secondary ? Color(red: 0.64, green: 0.71, blue: 0.79) : tint

        return VStack(alignment: .leading, spacing: 10) {
            ZStack {
                Circle()
                    .fill(baseTint.opacity(0.16))
                    .frame(width: 34, height: 34)
                Image(systemName: symbol)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(baseTint)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(self.shortStatusText(value))
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(Color.white.opacity(0.38))
                .overlay(
                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                        .fill(
                            LinearGradient(
                                colors: [
                                    Color.white.opacity(0.24),
                                    baseTint.opacity(0.08),
                                ],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing)))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(Color.white.opacity(0.20), lineWidth: 0.8)
        )
    }

    private func actionButton(
        title: String,
        detail: String,
        systemImage: String,
        tint: Color,
        isRecommended: Bool = false,
        action: @escaping () -> Void) -> some View
    {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .top, spacing: 10) {
                    ZStack {
                        Circle()
                            .fill(
                                LinearGradient(
                                    colors: [
                                        Color.white.opacity(0.72),
                                        tint.opacity(isRecommended ? 0.34 : 0.26),
                                    ],
                                    startPoint: .topLeading,
                                    endPoint: .bottomTrailing))
                            .frame(width: 42, height: 42)

                        Image(systemName: systemImage)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Color.primary)
                    }

                    Spacer(minLength: 0)

                    if isRecommended {
                        Text("Now")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(Color(red: 0.33, green: 0.58, blue: 0.90))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(Color.white.opacity(0.74), in: Capsule(style: .continuous))
                    }
                }

                Text(title)
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(Color.primary)
                Text(detail)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer(minLength: 0)

                Image(systemName: "arrow.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, minHeight: 104, alignment: .topLeading)
            .padding(16)
            .background(
                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [
                                Color.white.opacity(isRecommended ? 0.66 : 0.58),
                                tint.opacity(isRecommended ? 0.32 : 0.22),
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .stroke(
                        isRecommended ? tint.opacity(0.44) : Color.white.opacity(0.28),
                        lineWidth: isRecommended ? 1.1 : 0.8)
            )
        }
        .buttonStyle(.plain)
        .shadow(color: tint.opacity(isRecommended ? 0.14 : 0.08), radius: isRecommended ? 18 : 14, y: 8)
    }

    private func heroGlyphAction(systemImage: String, tint: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            ZStack {
                Circle()
                    .fill(
                        LinearGradient(
                            colors: [
                                Color.white.opacity(0.62),
                                tint.opacity(0.18),
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing))
                    .frame(width: 42, height: 42)

                Image(systemName: systemImage)
            }
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(tint)
            .overlay(
                Circle()
                    .strokeBorder(Color.white.opacity(0.26), lineWidth: 0.8)
            )
        }
        .buttonStyle(.plain)
        .shadow(color: tint.opacity(0.06), radius: 10, y: 6)
    }

    private func heroPrimaryAction(
        title: String,
        systemImage: String,
        action: @escaping () -> Void) -> some View
    {
        Button(action: action) {
            HStack(spacing: 12) {
                ZStack {
                    Circle()
                        .fill(
                            LinearGradient(
                                colors: [
                                    Color.white.opacity(0.86),
                                    Color(red: 0.87, green: 0.92, blue: 0.98).opacity(0.42),
                                ],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing))
                        .frame(width: 38, height: 38)
                    Image(systemName: systemImage)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Color(red: 0.39, green: 0.68, blue: 0.95))
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                }

                Spacer(minLength: 8)

                Image(systemName: "arrow.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(
                Capsule(style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [
                                Color.white.opacity(0.74),
                                Color(red: 0.88, green: 0.93, blue: 0.98).opacity(0.20),
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing))
                    .overlay(
                        Capsule(style: .continuous)
                            .strokeBorder(Color.white.opacity(0.34), lineWidth: 0.8)))
        }
        .buttonStyle(.plain)
        .shadow(color: Color(red: 0.43, green: 0.57, blue: 0.72).opacity(0.08), radius: 12, y: 6)
    }

    private func performPrimaryHeroAction() {
        switch self.healthStore.state {
        case .degraded:
            withAnimation(.spring(response: 0.32, dampingFraction: 0.88)) {
                self.router.selectedMode = .correction
            }
        case .linkingNeeded:
            self.openSettings(tab: .general)
        case .unknown:
            Task { await self.refreshStatus() }
        case .ok:
            withAnimation(.spring(response: 0.32, dampingFraction: 0.88)) {
                self.router.selectedMode = .chat
            }
        }
    }

    private func refreshStatus() async {
        self.gatewayManager.refreshEnvironmentStatus(force: true)
        await self.healthStore.refresh(onDemand: true)
    }

    private func openSettings(tab: SettingsTab) {
        SettingsTabRouter.request(tab)
        SettingsWindowOpener.shared.open()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
            NotificationCenter.default.post(name: .openclawSelectSettingsTab, object: tab)
        }
    }
}

private struct ControlDashboardCard<Content: View>: View {
    let eyebrow: String
    let title: String
    let detail: String
    let accent: Color
    let content: Content

    init(
        eyebrow: String,
        title: String,
        detail: String,
        accent: Color,
        @ViewBuilder content: () -> Content)
    {
        self.eyebrow = eyebrow
        self.title = title
        self.detail = detail
        self.accent = accent
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text(self.eyebrow.uppercased())
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.secondary)
                Text(self.title)
                    .font(.title3.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                Text(self.detail)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }

            self.content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .background(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .fill(Color.white.opacity(0.40))
                .overlay(
                    RoundedRectangle(cornerRadius: 24, style: .continuous)
                        .fill(
                            LinearGradient(
                                colors: [
                                    Color.white.opacity(0.28),
                                    self.accent.opacity(0.12),
                                ],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing))
                )
        )
        .overlay(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(Color.white.opacity(0.24), lineWidth: 0.8)
        )
        .shadow(color: Color(red: 0.43, green: 0.57, blue: 0.72).opacity(0.08), radius: 20, x: 0, y: 12)
        .shadow(color: .white.opacity(0.10), radius: 8, y: -3)
    }
}
