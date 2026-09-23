import Combine
import OpenClawKit
import SwiftUI

/// A projection of saved entries, not a second registry or connection owner.
struct SidebarGatewayPresentation {
    let entries: [GatewaySettingsStore.GatewayRegistryEntry]
    let focusedID: String?
    let state: GatewayDisplayState

    init(
        registry: GatewaySettingsStore.GatewayRegistry,
        connectionID: String?,
        connectedID: String?,
        state: GatewayDisplayState)
    {
        self.entries = registry.entries
        // A saved selection can precede TLS review. Keep the current route's
        // identity until the connection owner actually hands off to the target.
        self.focusedID = connectionID ?? connectedID ?? registry.activeStableID
        self.state = state
    }

    var showsPicker: Bool {
        self.entries.count > 1
    }

    var focusedEntry: GatewaySettingsStore.GatewayRegistryEntry? {
        self.entries.first { GatewayStableIdentifier.matches($0.stableID, self.focusedID) }
    }

    var statusTitle: String {
        switch self.state {
        case .connected: String(localized: "Online")
        case .connecting: String(localized: "Connecting")
        case .error: String(localized: "Needs attention")
        case .disconnected: String(localized: "Offline")
        }
    }

    func rowTitle(_ entry: GatewaySettingsStore.GatewayRegistryEntry) -> String {
        // The background fleet does not publish per-row health. Do not label
        // 'keep connected' intent as Online or invent Offline for other rows.
        guard GatewayStableIdentifier.matches(entry.stableID, self.focusedID) else { return entry.name }
        return "\(entry.name) — \(self.statusTitle)"
    }
}

struct SidebarGatewayPicker: View {
    let presentation: SidebarGatewayPresentation
    let fallbackName: String
    let isSwitching: Bool
    let selectGateway: (String) -> Void
    let openSettings: () -> Void

    var body: some View {
        Group {
            if self.presentation.showsPicker {
                Menu {
                    Picker(selection: Binding(
                        get: { self.presentation.focusedID ?? "" },
                        set: self.selectGateway))
                    {
                        // Keep the binding valid if a removed/transient route
                        // does not belong to any currently saved entry.
                        if self.presentation.focusedEntry == nil {
                            Text(verbatim: self.fallbackName)
                                .font(OpenClawType.subheadSemiBold)
                                .tag(self.presentation.focusedID ?? "")
                                .disabled(true)
                        }
                        ForEach(self.presentation.entries) { entry in
                            Text(verbatim: self.presentation.rowTitle(entry))
                                .font(OpenClawType.subheadSemiBold)
                                .tag(entry.stableID)
                        }
                    } label: {
                        Text("Gateway")
                            .font(OpenClawType.subheadSemiBold)
                    }
                    .pickerStyle(.inline)
                    .disabled(self.isSwitching)
                    Button(action: self.openSettings) {
                        Label {
                            Text("Manage Gateways…")
                                .font(OpenClawType.subheadSemiBold)
                        } icon: {
                            Image(systemName: "server.rack")
                        }
                    }
                } label: {
                    self.controlLabel
                }
                .menuIndicator(.hidden)
                .accessibilityIdentifier("RootTabs.Sidebar.GatewayPicker")
            } else {
                Button(action: self.openSettings) {
                    self.controlLabel
                }
                .accessibilityIdentifier("RootTabs.Sidebar.GatewaySettings")
            }
        }
        .buttonStyle(.plain)
        .foregroundStyle(OpenClawSidebarPalette.text)
        .accessibilityLabel(self.controlName)
        .accessibilityValue(self.presentation.entries.isEmpty ? "" : self.presentation.statusTitle)
        .accessibilityHint(self.presentation.showsPicker
            ? String(localized: "Switch gateway or manage saved gateways")
            : String(localized: "Open gateway setup and connection settings"))
    }

    private var controlName: String {
        if self.presentation.entries.isEmpty { return String(localized: "Add Gateway") }
        return self.presentation.focusedEntry?.name ?? self.fallbackName
    }

    private var controlLabel: some View {
        HStack(spacing: 9) {
            if self.isSwitching {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("Switching Gateway")
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: self.controlName)
                    .font(OpenClawType.subheadSemiBold)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                if !self.presentation.entries.isEmpty {
                    Text(verbatim: self.presentation.statusTitle)
                        .font(OpenClawType.captionMedium)
                        .foregroundStyle(OpenClawSidebarPalette.muted)
                }
            }
            if self.presentation.showsPicker {
                Image(systemName: "chevron.up.chevron.down")
                    .font(OpenClawType.captionSemiBold)
                    .accessibilityHidden(true)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .padding(.horizontal, 10)
        .contentShape(Rectangle())
    }
}

struct RootSidebarGatewayControl: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(GatewayConnectionController.self) private var gatewayController
    @State private var registry = GatewaySettingsStore.GatewayRegistry.empty
    @State private var switchError: String?
    let fallbackName: String
    let openSettings: () -> Void

    var body: some View {
        SidebarGatewayPicker(
            presentation: SidebarGatewayPresentation(
                registry: self.registry,
                connectionID: self.appModel.activeGatewayConnectConfig?.effectiveStableID,
                connectedID: self.appModel.connectedGatewayID,
                state: GatewayStatusBuilder.build(appModel: self.appModel)),
            fallbackName: self.fallbackName,
            isSwitching: self.appModel.isGatewayPickerRequestInFlight ||
                self.gatewayController.hasPendingConnectionHandoff,
            selectGateway: self.switchGateway,
            openSettings: self.openSettings)
            .onAppear { self.refreshRegistry() }
            .onReceive(NotificationCenter.default.publisher(for: GatewaySettingsStore.gatewayRegistryDidChange)
                .receive(on: DispatchQueue.main)) { _ in self.refreshRegistry() }
            .alert("Could Not Switch Gateway", isPresented: Binding(
                get: { self.switchError != nil },
                set: { if !$0 { self.switchError = nil } }))
            {
                Button { self.switchError = nil } label: {
                    Text("OK")
                        .font(OpenClawType.body)
                }
            } message: {
                Text(verbatim: self.switchError ?? "")
                    .font(OpenClawType.body)
            }
    }

    private func refreshRegistry() {
        // Demo/capture screens must not expose the installed user's saved hosts.
        guard !self.appModel.isAppleReviewDemoModeEnabled, !self.appModel.isScreenshotFixtureModeEnabled else {
            self.registry = .empty
            return
        }
        self.registry = GatewaySettingsStore.loadGatewayRegistry()
    }

    private func switchGateway(_ stableID: String) {
        guard !self.appModel.isGatewayPickerRequestInFlight,
              !self.gatewayController.hasPendingConnectionHandoff
        else { return }
        let currentID = self.appModel.activeGatewayConnectConfig?.effectiveStableID
            ?? self.appModel.connectedGatewayID ?? self.registry.activeStableID
        guard !GatewayStableIdentifier.matches(stableID, currentID) else { return }
        if self.appModel.chatPresentation.viewModel?.isAttachmentOwnerPinned == true ||
            self.appModel.voiceNoteRecorder.ownsPendingChatAttachment
        {
            self.switchError = String(localized: """
            Finish recording, remove attachments, or wait for delivery before switching gateways.
            """)
            return
        }
        if let draft = self.appModel.chatPresentation.viewModel?.input, !draft.isEmpty {
            self.switchError = String(localized: "Send or clear the current draft before switching gateways.")
            return
        }
        self.appModel.isGatewayPickerRequestInFlight = true
        Task { @MainActor in
            defer {
                self.appModel.isGatewayPickerRequestInFlight = false
                self.refreshRegistry()
            }
            switch await self.gatewayController.switchToGateway(stableID: stableID) {
            case .accepted:
                // Clear only request admission below. The controller-owned
                // handoff state keeps the picker and composer protected through
                // trust review, reset, and route commitment.
                break
            case let .failed(message):
                self.switchError = message
            case .superseded:
                self.switchError = String(localized: "Another connection attempt replaced this gateway switch.")
            }
        }
    }
}
