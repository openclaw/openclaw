import CoreLocation
import OpenClawIPC
import OpenClawKit
import SwiftUI

struct PermissionsSettings: View {
    let status: [Capability: Bool]
    let refresh: () async -> Void
    let showOnboarding: () -> Void
    @AppStorage(showAdvancedSettingsKey) private var showAdvancedSettings = false
    @State private var requestingRecommended = false
    @State private var showOptionalPermissions = false

    private static let consumerRecommendedCapabilities: [Capability] = [
        .screenRecording,
        .accessibility,
        .notifications,
        .appleScript,
        .microphone,
        .location,
    ]

    private static let consumerOptionalCapabilities: [Capability] = [
        .camera,
        .speechRecognition,
    ]

    private var isConsumer: Bool {
        AppFlavor.current.isConsumer
    }

    var body: some View {
        if self.isConsumer && !self.showAdvancedSettings {
            self.consumerBody
        } else {
            self.operatorBody
        }
    }

    private var operatorBody: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                SystemRunSettingsView()

                Text("Allow these so OpenClaw can notify and capture when needed.")
                    .padding(.top, 4)
                    .fixedSize(horizontal: false, vertical: true)

                PermissionStatusList(status: self.status, refresh: self.refresh)
                    .padding(.horizontal, 2)
                    .padding(.vertical, 6)

                LocationAccessSettings()

                Button("Restart onboarding") { self.showOnboarding() }
                    .buttonStyle(.bordered)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 12)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var consumerBody: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Grant the permissions OpenClaw needs to help on this Mac.")
                        .font(.title3.weight(.semibold))
                    Text("Click once to go through the recommended permissions. Accessibility and Screen Recording may open System Settings instead of showing a prompt.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                HStack(spacing: 10) {
                    Button {
                        Task { await self.grantRecommendedPermissions() }
                    } label: {
                        if self.requestingRecommended {
                            Label("Requesting permissions…", systemImage: "hourglass")
                        } else {
                            Label("Grant recommended permissions", systemImage: "checkmark.shield")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(self.requestingRecommended)

                    Button {
                        Task { await self.refreshStatusTransitions() }
                    } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.bordered)
                    .disabled(self.requestingRecommended)
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text("If Accessibility or Screen Recording still look pending after you enabled them in System Settings, quit and reopen OpenClaw once. macOS can keep those states stale until restart.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)

                    Button {
                        DebugActions.restartApp()
                    } label: {
                        Label("Restart OpenClaw", systemImage: "arrow.counterclockwise")
                    }
                    .buttonStyle(.bordered)
                    .disabled(self.requestingRecommended)
                }

                PermissionStatusList(
                    status: self.status,
                    capabilities: Self.consumerRecommendedCapabilities,
                    showRefreshButton: false,
                    refresh: self.refresh)
                    .padding(.horizontal, 2)
                    .padding(.vertical, 6)

                DisclosureGroup(isExpanded: self.$showOptionalPermissions) {
                    PermissionStatusList(
                        status: self.status,
                        capabilities: Self.consumerOptionalCapabilities,
                        showRefreshButton: false,
                        refresh: self.refresh)
                        .padding(.top, 8)
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("More permissions (optional)")
                            .font(.body.weight(.semibold))
                        Text("Needed only for camera capture or voice transcription features.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 18)
            .padding(.vertical, 16)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    @MainActor
    private func grantRecommendedPermissions() async {
        guard !self.requestingRecommended else { return }
        self.requestingRecommended = true
        defer { self.requestingRecommended = false }

        _ = await PermissionManager.ensure(Self.consumerRecommendedCapabilities, interactive: true)
        await self.refreshStatusTransitions()
    }

    @MainActor
    private func refreshStatusTransitions() async {
        await self.refresh()

        // Some macOS permission statuses settle after the prompt closes.
        for delay in [300_000_000, 900_000_000, 1_800_000_000] {
            try? await Task.sleep(nanoseconds: UInt64(delay))
            await self.refresh()
        }
    }
}

private struct LocationAccessSettings: View {
    @AppStorage(locationModeKey) private var locationModeRaw: String = OpenClawLocationMode.off.rawValue
    @AppStorage(locationPreciseKey) private var locationPreciseEnabled: Bool = true
    @State private var lastLocationModeRaw: String = OpenClawLocationMode.off.rawValue

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Location Access")
                .font(.body)

            Picker("", selection: self.$locationModeRaw) {
                Text("Off").tag(OpenClawLocationMode.off.rawValue)
                Text("While Using").tag(OpenClawLocationMode.whileUsing.rawValue)
                Text("Always").tag(OpenClawLocationMode.always.rawValue)
            }
            .labelsHidden()
            .pickerStyle(.menu)

            Toggle("Precise Location", isOn: self.$locationPreciseEnabled)
                .disabled(self.locationMode == .off)

            Text("Always may require System Settings to approve background location.")
                .font(.footnote)
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .onAppear {
            self.lastLocationModeRaw = self.locationModeRaw
        }
        .onChange(of: self.locationModeRaw) { _, newValue in
            let previous = self.lastLocationModeRaw
            self.lastLocationModeRaw = newValue
            guard let mode = OpenClawLocationMode(rawValue: newValue) else { return }
            Task {
                let granted = await self.requestLocationAuthorization(mode: mode)
                if !granted {
                    await MainActor.run {
                        self.locationModeRaw = previous
                        self.lastLocationModeRaw = previous
                    }
                }
            }
        }
    }

    private var locationMode: OpenClawLocationMode {
        OpenClawLocationMode(rawValue: self.locationModeRaw) ?? .off
    }

    private func requestLocationAuthorization(mode: OpenClawLocationMode) async -> Bool {
        guard mode != .off else { return true }
        guard CLLocationManager.locationServicesEnabled() else {
            await MainActor.run { LocationPermissionHelper.openSettings() }
            return false
        }

        let status = CLLocationManager().authorizationStatus
        let requireAlways = mode == .always
        if PermissionManager.isLocationAuthorized(status: status, requireAlways: requireAlways) {
            return true
        }
        let updated = await LocationPermissionRequester.shared.request(always: requireAlways)
        return PermissionManager.isLocationAuthorized(status: updated, requireAlways: requireAlways)
    }
}

struct PermissionStatusList: View {
    let status: [Capability: Bool]
    let capabilities: [Capability]
    let showRefreshButton: Bool
    let refresh: () async -> Void
    @State private var pendingCapability: Capability?

    init(
        status: [Capability: Bool],
        capabilities: [Capability] = Capability.allCases,
        showRefreshButton: Bool = true,
        refresh: @escaping () async -> Void)
    {
        self.status = status
        self.capabilities = capabilities
        self.showRefreshButton = showRefreshButton
        self.refresh = refresh
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(self.capabilities, id: \.self) { cap in
                PermissionRow(
                    capability: cap,
                    status: self.status[cap] ?? false,
                    isPending: self.pendingCapability == cap)
                {
                    Task { await self.handle(cap) }
                }
            }
            if self.showRefreshButton {
                Button {
                    Task { await self.refresh() }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .font(.footnote)
                .padding(.top, 2)
                .help("Refresh status")
            }
        }
    }

    @MainActor
    private func handle(_ cap: Capability) async {
        guard self.pendingCapability == nil else { return }
        self.pendingCapability = cap
        defer { self.pendingCapability = nil }

        _ = await PermissionManager.ensure([cap], interactive: true)
        await self.refreshStatusTransitions()
    }

    @MainActor
    private func refreshStatusTransitions() async {
        await self.refresh()

        // TCC and notification settings can settle after the prompt closes or when the app regains focus.
        for delay in [300_000_000, 900_000_000, 1_800_000_000] {
            try? await Task.sleep(nanoseconds: UInt64(delay))
            await self.refresh()
        }
    }
}

struct PermissionRow: View {
    let capability: Capability
    let status: Bool
    let isPending: Bool
    let compact: Bool
    let action: () -> Void

    init(
        capability: Capability,
        status: Bool,
        isPending: Bool = false,
        compact: Bool = false,
        action: @escaping () -> Void)
    {
        self.capability = capability
        self.status = status
        self.isPending = isPending
        self.compact = compact
        self.action = action
    }

    var body: some View {
        HStack(spacing: self.compact ? 10 : 12) {
            ZStack {
                Circle().fill(self.status ? Color.green.opacity(0.2) : Color.gray.opacity(0.15))
                    .frame(width: self.iconSize, height: self.iconSize)
                Image(systemName: self.icon)
                    .foregroundStyle(self.status ? Color.green : Color.secondary)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(self.title).font(.body.weight(.semibold))
                Text(self.subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .layoutPriority(1)
            VStack(alignment: .trailing, spacing: 4) {
                if self.status {
                    Label("Granted", systemImage: "checkmark.circle.fill")
                        .labelStyle(.iconOnly)
                        .foregroundStyle(.green)
                        .font(.title3)
                        .help("Granted")
                } else if self.isPending {
                    ProgressView()
                        .controlSize(.small)
                        .frame(width: 78)
                } else {
                    Button("Grant") { self.action() }
                        .buttonStyle(.bordered)
                        .controlSize(self.compact ? .small : .regular)
                        .frame(minWidth: self.compact ? 68 : 78, alignment: .trailing)
                }

                if self.status {
                    Text("Granted")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.green)
                } else if self.isPending {
                    Text("Checking…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Text(self.pendingHint)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(minWidth: self.compact ? 86 : 104, alignment: .trailing)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.vertical, self.compact ? 4 : 6)
    }

    private var iconSize: CGFloat {
        self.compact ? 28 : 32
    }

    private var title: String {
        switch self.capability {
        case .appleScript: "Automation (AppleScript)"
        case .notifications: "Notifications"
        case .accessibility: "Accessibility"
        case .screenRecording: "Screen Recording"
        case .microphone: "Microphone"
        case .speechRecognition: "Speech Recognition"
        case .camera: "Camera"
        case .location: "Location"
        }
    }

    private var subtitle: String {
        switch self.capability {
        case .appleScript:
            "Control other apps (e.g. Terminal) for automation actions"
        case .notifications: "Show desktop alerts for agent activity"
        case .accessibility: "Control UI elements when an action requires it"
        case .screenRecording: "Capture the screen for context or screenshots"
        case .microphone: "Allow Voice Wake and audio capture"
        case .speechRecognition: "Transcribe Voice Wake trigger phrases on-device"
        case .camera: "Capture photos and video from the camera"
        case .location: "Share location when requested by the agent"
        }
    }

    private var icon: String {
        switch self.capability {
        case .appleScript: "applescript"
        case .notifications: "bell"
        case .accessibility: "hand.raised"
        case .screenRecording: "display"
        case .microphone: "mic"
        case .speechRecognition: "waveform"
        case .camera: "camera"
        case .location: "location"
        }
    }

    private var pendingHint: String {
        switch self.capability {
        case .accessibility:
            "Grant or restart"
        case .screenRecording:
            "Open System Settings"
        default:
            "Request access"
        }
    }
}

#if DEBUG
struct PermissionsSettings_Previews: PreviewProvider {
    static var previews: some View {
        PermissionsSettings(
            status: [
                .appleScript: true,
                .notifications: true,
                .accessibility: false,
                .screenRecording: false,
                .microphone: true,
                .speechRecognition: false,
            ],
            refresh: {},
            showOnboarding: {})
            .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight)
    }
}
#endif
