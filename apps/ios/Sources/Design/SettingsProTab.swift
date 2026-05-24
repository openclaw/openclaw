import OpenClawKit
import SwiftUI

struct SettingsProTab: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(GatewayConnectionController.self) private var gatewayController
    @AppStorage(AppAppearancePreference.storageKey) private var appearancePreferenceRaw: String =
        AppAppearancePreference.system.rawValue
    @AppStorage("camera.enabled") private var cameraEnabled: Bool = true
    @AppStorage("location.enabledMode") private var locationModeRaw: String = OpenClawLocationMode.off.rawValue
    @AppStorage("screen.preventSleep") private var preventSleep: Bool = true
    @State private var isReconnectingGateway = false
    @State private var isRefreshingGateway = false
    @State private var isChangingLocationMode = false
    @State private var locationStatusText: String?
    var openFullSettings: () -> Void

    var body: some View {
        NavigationStack {
            ZStack {
                OpenClawProBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        self.appearanceSection
                        self.gatewaySection
                        self.systemStatusSection
                        self.permissionsSection
                        self.talkSection
                        self.advancedSection
                    }
                    .padding(.vertical, 18)
                }
                .safeAreaPadding(.bottom, OpenClawProMetric.bottomScrollInset)
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private var appearanceSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProSectionHeader(title: "Appearance")
            ProCard {
                VStack(alignment: .leading, spacing: 12) {
                    Picker("Appearance", selection: self.$appearancePreferenceRaw) {
                        ForEach(AppAppearancePreference.allCases) { preference in
                            Text(preference.label).tag(preference.rawValue)
                        }
                    }
                    .pickerStyle(.segmented)
                    Text("System follows iOS. Light uses blue and white; Dark uses OpenClaw red and graphite.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    private var gatewaySection: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProSectionHeader(title: "Gateway")
            ProCard {
                VStack(spacing: 0) {
                    self.settingsRow(
                        icon: "antenna.radiowaves.left.and.right",
                        title: "Connection",
                        detail: self.appModel.gatewayDisplayStatusText,
                        value: self.gatewayConnected ? "online" : "offline",
                        color: self.gatewayConnected ? OpenClawBrand.ok : .secondary)
                    Divider().padding(.leading, 60)
                    self.settingsRow(
                        icon: "server.rack",
                        title: "Server",
                        detail: self.appModel.gatewayServerName ?? "No gateway connected",
                        value: "\(self.gatewayController.gateways.count) found",
                        color: self.gatewayController.gateways.isEmpty ? .secondary : OpenClawBrand.accent)
                    Divider().padding(.leading, 60)
                    self.settingsRow(
                        icon: "network",
                        title: "Address",
                        detail: self.appModel.gatewayRemoteAddress ?? "Waiting for gateway",
                        value: self.appModel.isOperatorGatewayConnected ? "live" : "idle",
                        color: self.appModel.isOperatorGatewayConnected ? OpenClawBrand.ok : .secondary)
                    Divider().padding(.leading, 60)
                    self.gatewayActions
                }
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    private var gatewayActions: some View {
        HStack(spacing: 10) {
            self.gatewayActionButton(
                title: "Discover",
                icon: "dot.radiowaves.left.and.right",
                isBusy: false)
            {
                self.gatewayController.restartDiscovery()
            }

            self.gatewayActionButton(
                title: "Reconnect",
                icon: "arrow.triangle.2.circlepath",
                isBusy: self.isReconnectingGateway)
            {
                Task { await self.reconnectGateway() }
            }

            self.gatewayActionButton(
                title: "Refresh",
                icon: "arrow.clockwise",
                isBusy: self.isRefreshingGateway)
            {
                Task { await self.refreshGateway() }
            }
        }
        .padding(.top, 10)
    }

    private var permissionsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProSectionHeader(title: "Device Access")
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                self.permissionTile(
                    icon: "camera",
                    title: "Camera",
                    value: self.cameraEnabled ? "Allowed" : "Off",
                    color: self.cameraEnabled ? OpenClawBrand.accent : .secondary)
                {
                    self.cameraEnabled.toggle()
                }
                self.permissionTile(
                    icon: "location",
                    title: "Location",
                    value: self.locationLabel,
                    color: self.locationModeRaw == OpenClawLocationMode.off.rawValue ? .secondary : OpenClawBrand
                        .accent)
                {
                    Task { await self.advanceLocationMode() }
                }
                self.permissionTile(
                    icon: "display",
                    title: "Screen",
                    value: self.appModel.screenRecordActive ? "Live" : "Idle",
                    color: self.appModel.screenRecordActive ? OpenClawBrand.ok : .secondary,
                    action: nil)
                self.permissionTile(
                    icon: "lock.display",
                    title: "Keep Awake",
                    value: self.preventSleep ? "On" : "Off",
                    color: self.preventSleep ? OpenClawBrand.accent : .secondary)
                {
                    self.preventSleep.toggle()
                }
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
            if let locationStatusText {
                Text(locationStatusText)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, OpenClawProMetric.pagePadding)
            }
        }
    }

    private var systemStatusSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProSectionHeader(title: "System Status")
            ProCard {
                VStack(spacing: 0) {
                    self.diagnosticRow(
                        "Gateway",
                        value: self.gatewayConnected ? "Healthy" : "Offline",
                        color: self.gatewayConnected ? OpenClawBrand.ok : .secondary)
                    Divider()
                    self.diagnosticRow(
                        "Operator Session",
                        value: self.appModel.isOperatorGatewayConnected ? "Connected" : "Offline",
                        color: self.appModel.isOperatorGatewayConnected ? OpenClawBrand.ok : .secondary)
                    Divider()
                    self.diagnosticRow(
                        "Gateway Server",
                        value: self.appModel.gatewayServerName ?? "Unknown",
                        color: self.gatewayConnected ? OpenClawBrand.ok : .secondary)
                    Divider()
                    self.diagnosticRow(
                        "Gateway Address",
                        value: self.appModel.gatewayRemoteAddress ?? "Unknown",
                        color: self.gatewayConnected ? OpenClawBrand.ok : .secondary)
                    Divider()
                    self.diagnosticRow(
                        "Discovered",
                        value: "\(self.gatewayController.gateways.count)",
                        color: self.gatewayController.gateways.isEmpty ? .secondary : OpenClawBrand.accent)
                    Divider()
                    self.diagnosticRow(
                        "Active Agent",
                        value: self.appModel.activeAgentName,
                        color: self.appModel.isOperatorGatewayConnected ? OpenClawBrand.ok : .secondary)
                    Divider()
                    self.diagnosticRow(
                        "Agents",
                        value: "\(self.appModel.gatewayAgents.count)",
                        color: self.appModel.gatewayAgents.isEmpty ? .secondary : OpenClawBrand.accent)
                }
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    private var talkSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProSectionHeader(title: "Talk")
            ProCard {
                VStack(spacing: 0) {
                    self.settingsRow(
                        icon: "waveform",
                        title: "Provider",
                        detail: self.talkProviderDisplayName,
                        value: self.appModel.talkMode.isEnabled ? "on" : "off",
                        color: self.appModel.talkMode.isEnabled ? OpenClawBrand.ok : .secondary)
                    Divider().padding(.leading, 60)
                    self.settingsRow(
                        icon: "dot.radiowaves.left.and.right",
                        title: "Transport",
                        detail: self.appModel.talkMode.gatewayTalkTransportLabel,
                        value: self.appModel.talkMode.gatewayTalkConfigLoaded ? "loaded" : "not loaded",
                        color: self.appModel.talkMode.gatewayTalkConfigLoaded ? OpenClawBrand.ok : .secondary)
                }
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    private var advancedSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProSectionHeader(title: "Advanced")
            Button(action: self.openFullSettings) {
                ProCard {
                    HStack(spacing: 12) {
                        ProIconBadge(systemName: "slider.horizontal.3", color: OpenClawBrand.accent)
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Full settings")
                                .font(.subheadline.weight(.semibold))
                            Text("Gateway setup, permissions, diagnostics, and advanced controls.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Image(systemName: "chevron.right")
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .buttonStyle(.plain)
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    private func settingsRow(
        icon: String,
        title: String,
        detail: String,
        value: String,
        color: Color) -> some View
    {
        HStack(spacing: 12) {
            ProIconBadge(systemName: icon, color: color)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            Text(value)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(color)
                .lineLimit(1)
        }
        .padding(.vertical, 10)
    }

    private func permissionTile(
        icon: String,
        title: String,
        value: String,
        color: Color,
        action: (() -> Void)?) -> some View
    {
        Button(
            action: { action?() },
            label: {
                ProCard(padding: 12) {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            ProIconBadge(systemName: icon, color: color)
                            Spacer()
                            if action != nil {
                                Image(systemName: "chevron.right")
                                    .font(.caption2.weight(.bold))
                                    .foregroundStyle(.secondary)
                            } else {
                                ProValuePill(value: value, color: color)
                            }
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            Text(title)
                                .font(.caption.weight(.semibold))
                                .lineLimit(1)
                            Text(value)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            })
            .buttonStyle(.plain)
            .disabled(action == nil || self.isChangingLocationMode)
    }

    private func gatewayActionButton(
        title: String,
        icon: String,
        isBusy: Bool,
        action: @escaping () -> Void) -> some View
    {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: isBusy ? "hourglass" : icon)
                    .font(.caption.weight(.semibold))
                Text(title)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
            }
            .frame(maxWidth: .infinity)
            .frame(height: 34)
            .foregroundStyle(OpenClawBrand.accent)
            .background(.regularMaterial, in: Capsule())
        }
        .buttonStyle(.plain)
        .disabled(isBusy)
    }

    private func diagnosticRow(_ title: String, value: String, color: Color) -> some View {
        HStack {
            Image(systemName: "circle.hexagongrid")
                .foregroundStyle(.secondary)
            Text(title)
                .lineLimit(1)
            Spacer(minLength: 8)
            ProValuePill(value: value, color: color)
        }
        .font(.subheadline)
        .padding(.vertical, 11)
    }

    private func reconnectGateway() async {
        guard !self.isReconnectingGateway else { return }
        self.isReconnectingGateway = true
        defer { self.isReconnectingGateway = false }
        await self.gatewayController.connectLastKnown()
    }

    private func refreshGateway() async {
        guard !self.isRefreshingGateway else { return }
        self.isRefreshingGateway = true
        defer { self.isRefreshingGateway = false }
        self.gatewayController.refreshActiveGatewayRegistrationFromSettings()
        await self.appModel.refreshGatewayOverviewIfConnected()
    }

    private var gatewayConnected: Bool {
        GatewayStatusBuilder.build(appModel: self.appModel) == .connected
    }

    private var locationLabel: String {
        switch OpenClawLocationMode(rawValue: self.locationModeRaw) ?? .off {
        case .off: "Off"
        case .whileUsing: "While using"
        case .always: "Always"
        }
    }

    @MainActor
    private func advanceLocationMode() async {
        guard !self.isChangingLocationMode else { return }
        let current = OpenClawLocationMode(rawValue: self.locationModeRaw) ?? .off
        let previous = self.locationModeRaw
        let next: OpenClawLocationMode = switch current {
        case .off:
            .whileUsing
        case .whileUsing:
            .always
        case .always:
            .off
        }

        self.isChangingLocationMode = true
        self.locationStatusText = nil
        defer { self.isChangingLocationMode = false }

        if next == .off {
            self.locationModeRaw = next.rawValue
            self.gatewayController.refreshActiveGatewayRegistrationFromSettings()
            return
        }

        self.locationModeRaw = next.rawValue
        let granted = await self.appModel.requestLocationPermissions(mode: next)
        if granted {
            self.gatewayController.refreshActiveGatewayRegistrationFromSettings()
        } else {
            self.locationModeRaw = previous
            self.locationStatusText = "Location permission was not granted."
        }
    }

    private var talkProviderDisplayName: String {
        let label = self.appModel.talkMode.gatewayTalkProviderLabel.trimmingCharacters(in: .whitespacesAndNewlines)
        if !label.isEmpty, label != "Not loaded" {
            return label
        }
        return self.appModel.talkMode.gatewayTalkConfigLoaded ? "Gateway" : "Not loaded"
    }
}
