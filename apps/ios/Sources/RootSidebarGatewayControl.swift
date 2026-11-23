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
    let selectGateway: @MainActor (String) -> Void
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
        ZStack {
            if self.isSwitching {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("Switching Gateway")
            } else {
                Image(systemName: "antenna.radiowaves.left.and.right")
                    .font(.system(size: 17, weight: .regular))
                    .environment(\.symbolVariants, .none)
                    .frame(width: 22, height: 22)
                    .overlay(alignment: .topTrailing) {
                        Circle()
                            .fill(self.statusColor)
                            .frame(width: 8, height: 8)
                            .overlay(Circle().stroke(OpenClawSidebarPalette.background, lineWidth: 1.5))
                            .offset(x: 3, y: -2)
                    }
                    .accessibilityHidden(true)
            }
        }
        .frame(width: 44, height: 44)
        .contentShape(Circle())
        .glassEffect(.regular.interactive(), in: Circle())
    }

    private var statusColor: Color {
        switch self.presentation.state {
        case .connected: OpenClawBrand.ok
        case .connecting, .error: OpenClawBrand.warn
        case .disconnected: OpenClawSidebarPalette.muted
        }
    }
}

private struct SidebarUserProfileResponse: Decodable {
    struct Profile: Decodable {
        struct GitHubIdentity: Decodable {
            let login: String
        }

        let id: String
        let displayName: String?
        let githubIdentity: GitHubIdentity?

        var name: String? {
            for candidate in [self.displayName, self.githubIdentity?.login] {
                if let name = candidate?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
                    return name
                }
            }
            return nil
        }
    }

    let profile: Profile
}

private struct SidebarUserProfileRequest: Equatable {
    let ownerID: String
    let authorityGeneration: UInt64
    let isConnected: Bool
}

private struct SidebarUserProfileSnapshot {
    let request: SidebarUserProfileRequest
    let name: String

    var initials: String {
        self.name.split(whereSeparator: \.isWhitespace)
            .prefix(2)
            .compactMap(\.first)
            .map(String.init)
            .joined()
            .uppercased()
    }
}

struct RootSidebarGatewayControl: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(GatewayConnectionController.self) private var gatewayController
    @State private var registry = GatewaySettingsStore.GatewayRegistry.empty
    @State private var switchError: String?
    @State private var profileSnapshot: SidebarUserProfileSnapshot?
    let fallbackName: String
    let openSettings: () -> Void

    var body: some View {
        let profileRequest = self.profileRequest
        Group {
            if let profile = self.visibleProfile {
                self.profileLabel(profile)
            } else {
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
            }
        }
        .onAppear { self.refreshRegistry() }
        .task(id: profileRequest) { await self.refreshProfile(profileRequest) }
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

    private var profileRequest: SidebarUserProfileRequest {
        SidebarUserProfileRequest(
            ownerID: self.appModel.chatViewModelOwnerID,
            authorityGeneration: self.appModel.operatorAuthorityGeneration,
            isConnected: self.appModel.isOperatorGatewayConnected)
    }

    private var visibleProfile: SidebarUserProfileSnapshot? {
        guard let snapshot = self.profileSnapshot,
              snapshot.request.isConnected,
              snapshot.request == self.profileRequest
        else { return nil }
        return snapshot
    }

    private func profileLabel(_ profile: SidebarUserProfileSnapshot) -> some View {
        HStack(spacing: 10) {
            Text(verbatim: profile.initials)
                .font(OpenClawType.avatar(size: 16))
                .foregroundStyle(OpenClawSidebarPalette.textStrong)
                .frame(width: 36, height: 36)
                .background(OpenClawSidebarPalette.elevated, in: Circle())
                .accessibilityHidden(true)
            Text(verbatim: profile.name)
                .font(OpenClawType.subheadMedium)
                .foregroundStyle(OpenClawSidebarPalette.text)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("RootTabs.Sidebar.UserProfile")
    }

    private func refreshProfile(_ request: SidebarUserProfileRequest) async {
        guard request == self.profileRequest, !Task.isCancelled else { return }
        self.profileSnapshot = nil
        guard request.isConnected else { return }
        let gateway = self.appModel.operatorSession
        guard let route = await gateway.currentRoute(),
              request == self.profileRequest,
              let data = try? await gateway.request(method: "users.self", params: [:], ifCurrentRoute: route),
              let result = try? JSONDecoder().decode(SidebarUserProfileResponse.self, from: data),
              let name = result.profile.name
        else { return }
        // Identity is scoped to the admitted operator connection, including same-host account changes.
        guard !Task.isCancelled,
              await gateway.currentRoute() == route,
              request == self.profileRequest
        else { return }
        self.profileSnapshot = SidebarUserProfileSnapshot(request: request, name: name)
    }

    private func refreshRegistry() {
        self.registry = self.appModel.loadDisplayedGatewayRegistry()
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
