import Foundation
import Observation
import OpenClawKit
import SwiftUI

@MainActor
struct StatusMenuHeaderView: View {
    @Bindable private var state: AppState
    @Bindable private var pairingPrompter = NodePairingApprovalPrompter.shared
    @Bindable private var devicePairingPrompter = DevicePairingApprovalPrompter.shared
    @AppStorage(cameraEnabledKey, store: AppDefaults.standard) private var cameraEnabled = false
    @State private var browser = BrowserControlSetting()

    private let isSleeping: Bool
    private let controlChannel = ControlChannel.shared
    private let healthStore = HealthStore.shared
    private let nodesStore = NodesStore.shared
    private let nodeChannelStatus = MacNodeChannelStatusStore.shared
    private let dashboardManager = DashboardManager.shared
    private let onCheckForUpdates: (@MainActor () -> Void)?

    init(
        state: AppState,
        isSleeping: Bool = false,
        onCheckForUpdates: (@MainActor () -> Void)? = nil)
    {
        self._state = Bindable(wrappedValue: state)
        self.isSleeping = isSleeping
        self.onCheckForUpdates = onCheckForUpdates
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            self.statusHeading
            self.statusSummary
            self.pairingRows
            self.capabilityStrip
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .transaction { $0.animation = nil }
        .task(id: self.state.connectionMode) {
            await self.browser.load()
        }
        .task {
            await self.nodesStore.prepareLocalNodeIdentity()
        }
    }

    private var statusHeading: some View {
        HStack(alignment: .center, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(self.statusTitle)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(2)

                if let connectionModeLabel = self.connectionModeLabel {
                    Text(connectionModeLabel)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer(minLength: 4)

            Toggle(String(localized: "OpenClaw active"), isOn: Binding(
                get: { !self.state.isPaused },
                set: { self.state.isPaused = !$0 }))
                .labelsHidden()
                .toggleStyle(.switch)
                .controlSize(.small)
                .disabled(self.state.connectionMode == .unconfigured)
                .accessibilityLabel(String(localized: "OpenClaw active"))
        }
    }

    /// A healthy system stays silent: lines appear only for states the
    /// operator can act on, so the header is stable while nothing is wrong.
    @ViewBuilder
    private var statusSummary: some View {
        let problems = self.problemLines
        if !problems.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(problems.indices, id: \.self) { index in
                    let problem = problems[index]
                    self.statusLine(
                        label: problem.label,
                        diagnostic: problem.diagnostic,
                        color: problem.color,
                        onCheckForUpdates: index == problems.count - 1 && self.shouldOfferAppUpdate
                            ? self.onCheckForUpdates : nil)
                }
            }
        }
    }

    @ViewBuilder
    private var pairingRows: some View {
        if self.pairingPrompter.pendingCount > 0 {
            self.pairingRow(
                String(localized: "Pairing approval pending") + " (\(self.pairingPrompter.pendingCount))")
        }
        if self.devicePairingPrompter.pendingCount > 0 {
            let repairCount = self.devicePairingPrompter.pendingRepairCount
            let repairs = repairCount > 0
                ? " · \(repairCount) " + String(localized: "repair")
                : ""
            self.pairingRow(
                String(localized: "Device pairing pending")
                    + " (\(self.devicePairingPrompter.pendingCount))" + repairs)
        }
    }

    private var capabilityStrip: some View {
        HStack(spacing: 6) {
            self.capabilityButton(
                title: String(localized: "Browser"),
                symbol: "globe",
                enabled: self.browser.enabled)
            {
                self.browser.toggle()
            }

            self.capabilityButton(
                title: String(localized: "Camera"),
                symbol: "camera",
                enabled: self.cameraEnabled)
            {
                self.cameraEnabled.toggle()
            }

            self.capabilityButton(
                title: String(localized: "Canvas"),
                symbol: "rectangle.and.pencil.and.ellipsis",
                enabled: self.state.canvasEnabled)
            {
                self.state.canvasEnabled.toggle()
                if !self.state.canvasEnabled {
                    CanvasManager.shared.hideAll()
                }
            }

            self.capabilityButton(
                title: String(localized: "Voice Wake"),
                symbol: "mic.fill",
                enabled: self.state.swabbleEnabled)
            {
                let binding = MicRefreshSupport.voiceWakeBinding(for: self.state)
                binding.wrappedValue.toggle()
            }
        }
    }

    private func capabilityButton(
        title: String,
        symbol: String,
        enabled: Bool,
        action: @escaping () -> Void) -> some View
    {
        Button(action: action) {
            VStack(spacing: 4) {
                Image(systemName: symbol)
                    .font(.system(size: 13, weight: .medium))
                Text(title)
                    .font(.system(size: 9, weight: .medium))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .foregroundStyle(enabled ? Color.accentColor : Color.secondary)
            .frame(maxWidth: .infinity, minHeight: 39)
            .background(
                enabled ? Color.accentColor.opacity(0.13) : Color.secondary.opacity(0.07),
                in: RoundedRectangle(cornerRadius: 7, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityValue(enabled ? String(localized: "On") : String(localized: "Off"))
    }

    private var statusTitle: String {
        if self.state.connectionMode == .unconfigured {
            return String(localized: "OpenClaw Not Configured")
        }
        if self.state.isPaused {
            return String(localized: "OpenClaw Paused")
        }
        if self.isSleeping {
            return String(localized: "OpenClaw Sleeping")
        }
        if self.dashboardManager.gatewayEntries.count >= 2,
           let primaryName = self.dashboardManager.gatewayEntries.first(where: \.isPrimary)?.name.nonEmpty
        {
            return primaryName
        }
        return "OpenClaw"
    }

    private var connectionModeLabel: String? {
        switch self.state.connectionMode {
        case .unconfigured:
            nil
        case .local:
            String(localized: "local")
        case .remote:
            String(localized: "remote")
        }
    }

    /// Operator-actionable trouble only. Healthy, refreshing, pending, and
    /// activity states intentionally produce nothing - the menu stays quiet
    /// and stable instead of narrating routine churn.
    private var problemLines: [(label: String, diagnostic: String?, color: Color)] {
        guard self.state.connectionMode != .unconfigured else { return [] }
        var lines: [(label: String, diagnostic: String?, color: Color)] = []

        if self.state.connectionMode == .local,
           let failure = GatewayProcessManager.shared.lastFailureReason
        {
            lines.append((failure, nil, .red))
        }
        if self.state.connectionMode == .remote {
            let presentation = GatewayConnectionPresentation(state: self.controlChannel.state)
            if presentation.tone != .healthy {
                lines.append((presentation.generalSubtitle, nil, presentation.tone == .transient ? .orange : .red))
            }
        }

        switch self.healthStore.state {
        case .ok, .unknown:
            break
        case .linkingNeeded:
            lines.append((String(localized: "Login required"), nil, .red))
        case let .degraded(reason):
            lines.append((self.healthStore.degradedSummary ?? reason, nil, .orange))
        }

        if let macNodeStatus = self.macNodeStatus {
            lines.append(macNodeStatus)
        }
        return lines
    }

    private var macNodeStatus: (label: String, diagnostic: String?, color: Color)? {
        guard self.state.connectionMode != .unconfigured,
              case .connected = self.controlChannel.state
        else { return nil }

        // The coordinator records why the node channel is down at the connect
        // boundary; prefer that recorded fact over inferring from node listings.
        if let line = self.nodeChannelStatus.state.operatorStatusLine {
            return (line.label, line.diagnostic, line.isDegraded ? .orange : .red)
        }

        let deviceID: String
        switch self.nodesStore.localNodeIdentityState {
        case .loading:
            return nil
        case let .available(id):
            deviceID = id
        case .unavailable:
            return (String(localized: "Mac identity unavailable"), nil, .red)
        }

        if let node = self.nodesStore.nodes.first(where: { $0.nodeId == deviceID }) {
            guard node.isConnected else {
                return (String(localized: "Mac capabilities offline"), nil, .orange)
            }
            let commands = Set(node.commands ?? [])
            let requiredCommands = [
                OpenClawSystemCommand.notify.rawValue,
                OpenClawSystemCommand.run.rawValue,
                OpenClawSystemCommand.which.rawValue,
            ]
            guard requiredCommands.allSatisfy(commands.contains) else {
                return (String(localized: "Mac capabilities incomplete"), nil, .orange)
            }
            return nil
        }

        guard !self.nodesStore.isLoading, !self.nodesStore.nodes.isEmpty else { return nil }
        return (String(localized: "Mac capabilities offline"), nil, .orange)
    }

    private var shouldOfferAppUpdate: Bool {
        guard self.state.connectionMode != .unconfigured,
              case .connected = self.controlChannel.state
        else { return false }
        return self.nodeChannelStatus.state.operatorStatusLine?.recoveryAction == .checkForUpdates
    }

    private func statusLine(
        label: String,
        diagnostic: String? = nil,
        color: Color,
        onCheckForUpdates: (@MainActor () -> Void)? = nil) -> some View
    {
        StatusMenuProblemLineView(
            label: label,
            diagnostic: diagnostic,
            color: color,
            onCheckForUpdates: onCheckForUpdates)
    }

    private func pairingRow(_ label: String) -> some View {
        Button {
            PairingApprovalCenter.shared.showPanel()
        } label: {
            self.statusLine(label: label, color: .orange)
        }
        .buttonStyle(.plain)
        .help(String(localized: "Show pairing requests"))
    }
}

/// Owns the menu's Browser Control choice. Clicks record the newest intent; a single save
/// writes it, because overlapping saves read the same config revision and the Gateway
/// rejects all but the first as stale.
@MainActor
@Observable
final class BrowserControlSetting {
    private(set) var enabled = true
    /// Bumped by every click; reads publish only when no newer click arrived meanwhile.
    @ObservationIgnored private var intent = 0
    /// The Gateway selected when the newest click was made; that choice is never written to another.
    @ObservationIgnored private var intentSelection: ConfigStore.Selection?
    @ObservationIgnored private var isSaving = false

    func toggle() {
        self.enabled.toggle()
        self.intent += 1
        self.intentSelection = .current()
        // The running save picks up this click after its current write settles. Claim the
        // save before the task starts: AppKit can deliver queued clicks in one turn.
        guard !self.isSaving else { return }
        self.isSaving = true
        Task { await self.save() }
    }

    func load() async {
        let intent = self.intent
        let config = await ConfigStore.load()
        guard config.isCurrent, intent == self.intent else { return }
        let browser = config.root["browser"] as? [String: Any]
        self.enabled = browser?["enabled"] as? Bool ?? true
    }

    private func save() async {
        defer { self.isSaving = false }
        while true {
            var config = await ConfigStore.load()
            let intent = self.intent
            if config.selection != self.intentSelection {
                // The read started before a Gateway switch and the newest click was made on the
                // Gateway selected now: read again for it.
                if self.intentSelection == .current() { continue }
                // The newest click was made on a Gateway that is no longer selected; this one
                // shows its own value instead of receiving that choice.
                await self.load()
            } else {
                var browser = config.root["browser"] as? [String: Any] ?? [:]
                browser["enabled"] = self.enabled
                config.root["browser"] = browser
                do {
                    try await ConfigStore.save(config)
                } catch {
                    // Show the saved value only when this was the newest choice; a newer click
                    // is written by the next pass from a fresh read instead.
                    if intent == self.intent { await self.load() }
                }
            }
            // A click during this pass is written by the next one.
            if intent == self.intent { return }
        }
    }
}

@MainActor
struct StatusMenuProblemLineView: View {
    let label: String
    let diagnostic: String?
    let color: Color
    let onCheckForUpdates: (@MainActor () -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(self.label)
                .font(.caption)
                .foregroundStyle(self.color)
                .lineLimit(self.diagnostic == nil ? 3 : 2)

            if let diagnostic = self.diagnostic {
                Text(diagnostic)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(4)
                    .textSelection(.enabled)
            }
            if let onCheckForUpdates = self.onCheckForUpdates {
                Button(String(localized: "Update"), action: onCheckForUpdates)
                    .font(.caption.weight(.semibold))
                    .buttonStyle(.link)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .help(self.diagnostic.map { "\(self.label)\n\($0)" } ?? self.label)
    }
}
