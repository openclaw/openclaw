import Combine
import OpenClawChatUI
import OpenClawKit
import OSLog
import SwiftUI

/// A failed host switch, in words someone can read in two seconds. The controller's message names
/// transport details (endpoint, TLS URL, instance ID) and goes to the log instead.
struct GatewaySwitchFailureToast: Equatable {
    let text: String
    let offersRetry: Bool

    /// `hostName` is nil when the host has no saved name; sentences that start with it have their own wording.
    init(message: String, problemKind: GatewayConnectionProblem.Kind?, hostName savedName: String?) {
        let hostName = savedName ?? String(localized: "this host")
        let unreachable = String(format: String(localized: "Couldn’t reach %@."), hostName)
        let needsSecure = savedName.map { String(format: String(localized: "%@ needs a secure connection."), $0) }
            ?? String(localized: "This host needs a secure connection.")
        let secureTransportGuidance = GatewayConnectionController.DiscoveredGatewayConnectionAvailability
            .secureTransportRequired.guidanceText ?? ""
        switch problemKind {
        case .reachabilityFailed?, .connectionRefused?, .timeout?:
            (self.text, self.offersRetry) = (unreachable, true)
            return
        case .tlsCertificateUnavailable?:
            (self.text, self.offersRetry) = (needsSecure, false)
            return
        case .tlsPinMismatch?:
            let notPaired = savedName.map {
                String(format: String(localized: "%@ isn’t the host you paired with."), $0)
            } ?? String(localized: "This isn’t the host you paired with.")
            (self.text, self.offersRetry) = (notPaired, false)
            return
        default:
            break
        }
        switch message {
        case GatewayFailureText.hostUnavailable, GatewayFailureText.checkAddress:
            (self.text, self.offersRetry) = (message, false)
        case GatewayFailureText.couldntSwitch, GatewayFailureText.notFound(hostName):
            (self.text, self.offersRetry) = (message, true)
        case "Failed to build TLS URL for trust verification.", "Failed to build discovered gateway URL.",
             String(localized: "Failed to build the gateway URL."):
            (self.text, self.offersRetry) = (GatewayFailureText.checkAddress, false)
        case secureTransportGuidance, String(localized: "A TLS certificate fingerprint requires a secure gateway URL."):
            (self.text, self.offersRetry) = (needsSecure, false)
        case "Failed to resolve the discovered gateway endpoint.":
            (self.text, self.offersRetry) = (unreachable, true)
        default:
            (self.text, self.offersRetry) = (
                String(format: String(localized: "Couldn’t connect to %@."), hostName), true)
        }
    }
}

/// A projection of saved entries, not a second registry or connection owner.
struct SidebarGatewayPresentation {
    let registry: GatewaySettingsStore.GatewayRegistry
    var entries: [GatewaySettingsStore.GatewayRegistryEntry] {
        self.registry.entries
    }

    let focusedID: String?
    let state: GatewayDisplayState
    /// The status owner's plain-words reason, read out when the state is an error.
    let problemText: String?

    init(
        registry: GatewaySettingsStore.GatewayRegistry,
        connectionID: String?,
        connectedID: String?,
        state: GatewayDisplayState,
        problemText: String? = nil)
    {
        self.registry = registry
        // A saved selection can precede TLS review. Keep the current route's
        // identity until the connection owner actually hands off to the target.
        self.focusedID = connectionID ?? connectedID ?? registry.activeStableID
        self.state = state
        self.problemText = problemText
    }

    var showsPicker: Bool {
        self.entries.count > 1
    }

    var focusedEntry: GatewaySettingsStore.GatewayRegistryEntry? {
        self.entries.first { GatewayStableIdentifier.matches($0.stableID, self.focusedID) }
    }

    /// The name the app shows for this connection: its saved name, else `fallback` (what the Gateway calls
    /// itself or its address).
    func connectionName(fallback: String) -> String {
        self.focusedEntry?.name ?? fallback
    }

    var statusTitle: String {
        switch self.state {
        case .connected: String(localized: "Online")
        case .connecting: String(localized: "Connecting")
        case .error: String(localized: "Needs attention")
        case .disconnected: String(localized: "Offline")
        }
    }

    /// Online keeps its green dot: on this control the connection is a signal worth showing even when it is fine.
    func showsOnlineDot(isSwitching: Bool) -> Bool {
        !self.entries.isEmpty && !isSwitching && self.state == .connected
    }

    /// The control's spoken state, one for each mark it shows, online included.
    func accessibilityStatus(isSwitching: Bool) -> String {
        if self.entries.isEmpty { return "" }
        if isSwitching { return String(localized: "Connecting") }
        switch self.state {
        case .connected: return String(localized: "Online")
        case .connecting: return String(localized: "Connecting")
        case .disconnected: return String(localized: "Offline")
        case .error: return self.problemText ?? String(localized: "Needs attention")
        }
    }

    func rowSubtitle(_ entry: GatewaySettingsStore.GatewayRegistryEntry) -> String? {
        // Only the focused route has an observed connection state.
        let address = self.registry.distinguishingAddress(for: entry)
        guard GatewayStableIdentifier.matches(entry.stableID, self.focusedID) else { return address }
        return address.map { "\($0) · \(self.statusTitle)" } ?? self.statusTitle
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
                self.controlLabel
                    .accessibilityHidden(true)
                    .overlay {
                        SidebarConnectionMenu(
                            presentation: self.presentation,
                            fallbackName: self.fallbackName,
                            controlName: self.controlName,
                            isSwitching: self.isSwitching,
                            selectGateway: self.selectGateway,
                            openSettings: self.openSettings)
                    }
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
        .accessibilityValue(self.presentation.accessibilityStatus(isSwitching: self.isSwitching))
        .accessibilityHint(self.presentation.showsPicker
            ? String(localized: "Switch or manage connections")
            : String(localized: "Open connection settings"))
    }

    private var controlName: String {
        if self.presentation.entries.isEmpty { return String(localized: "Add connection") }
        return self.presentation.focusedEntry.map(self.presentation.registry.compactName) ?? self.fallbackName
    }

    private var controlLabel: some View {
        // Each state has its own mark, told apart by shape as well as color: a green dot when online,
        // a spinner while connecting, a slashed antenna when offline, a warning badge on an error.
        let state = self.presentation.entries.isEmpty ? GatewayDisplayState.connected : self.presentation.state
        return self.connectionMark(state: state)
            .rootSidebarGlassCircle()
    }

    private func connectionMark(state: GatewayDisplayState) -> some View {
        ZStack {
            if self.isSwitching || state == .connecting {
                ProgressView()
                    .controlSize(.small)
                    .tint(OpenClawSidebarPalette.muted)
            } else {
                RootSidebarIcon(systemName: state == .disconnected
                    ? "antenna.radiowaves.left.and.right.slash"
                    : "antenna.radiowaves.left.and.right")
                    .environment(\.symbolVariants, .none)
                    .foregroundStyle(state == .disconnected
                        ? OpenClawSidebarPalette.muted
                        : OpenClawSidebarPalette.text)
                    .overlay(alignment: .topTrailing) {
                        if self.presentation.showsOnlineDot(isSwitching: self.isSwitching) {
                            Circle()
                                .fill(OpenClawBrand.ok)
                                .frame(width: 8, height: 8)
                                .overlay(Circle().stroke(OpenClawSidebarPalette.background, lineWidth: 1.5))
                                .offset(x: 3, y: -2)
                        } else if state == .error {
                            Image(systemName: "exclamationmark.circle.fill")
                                .font(.system(size: 11, weight: .bold))
                                .symbolRenderingMode(.palette)
                                .foregroundStyle(OpenClawSidebarPalette.background, OpenClawBrand.warn)
                                .background(Circle().fill(OpenClawSidebarPalette.background).padding(-1.5))
                                .offset(x: 5, y: -3)
                        }
                    }
            }
        }
        .frame(width: 22, height: 22)
        .accessibilityHidden(true)
    }
}

/// UIKit's inline, single-selection picker preserves native subtitles. SwiftUI's inline
/// Picker drops the second Text from each option on iPhone, including the distinguishing port.
private struct SidebarConnectionMenu: UIViewRepresentable {
    let presentation: SidebarGatewayPresentation
    let fallbackName: String
    let controlName: String
    let isSwitching: Bool
    let selectGateway: @MainActor (String) -> Void
    let openSettings: () -> Void

    func makeUIView(context: Context) -> UIButton {
        let button = UIButton(type: .custom)
        button.showsMenuAsPrimaryAction = true
        button.accessibilityIdentifier = "RootTabs.Sidebar.GatewayPicker"
        return button
    }

    func updateUIView(_ button: UIButton, context: Context) {
        button.accessibilityLabel = self.controlName
        button.accessibilityValue = self.presentation.accessibilityStatus(isSwitching: self.isSwitching)
        button.accessibilityHint = String(localized: "Switch or manage connections")
        var options = self.presentation.entries.map { entry in
            let action = UIAction(
                title: self.menuText(entry.displayName, style: .body, traits: button.traitCollection),
                attributes: self.isSwitching ? .disabled : [],
                state: GatewayStableIdentifier.matches(entry.stableID, self.presentation.focusedID) ? .on : .off)
            { _ in self.selectGateway(entry.stableID) }
            let subtitle = self.presentation.rowSubtitle(entry)
            action.subtitle = subtitle.map { self.menuText($0, style: .footnote, traits: button.traitCollection) }
            action.accessibilityLabel = entry.displayName
            action.accessibilityValue = subtitle
            return action
        }
        if self.presentation.focusedEntry == nil {
            options.insert(UIAction(title: self.fallbackName, attributes: .disabled, state: .on) { _ in }, at: 0)
        }
        let picker = UIMenu(options: [.displayInline, .singleSelection], children: options)
        let preferences = UIMenuDisplayPreferences()
        preferences.maximumNumberOfTitleLines = 1
        picker.displayPreferences = preferences
        let manage = UIAction(title: String(localized: "Manage connections")) { _ in self.openSettings() }
        button.menu = UIMenu(children: [picker, manage])
        button.preferredMenuElementOrder = .fixed
    }

    /// The narrow iPhone menu has 180 pt between its checkmark gutter and trailing inset.
    /// UIMenu only offers a line cap (tail truncation); keep the distinguishing suffix ourselves.
    private func menuText(_ text: String, style: UIFont.TextStyle, traits: UITraitCollection) -> String {
        let font = UIFont.preferredFont(forTextStyle: style, compatibleWith: traits)
        let attributes: [NSAttributedString.Key: Any] = [.font: font]
        func fits(_ value: String) -> Bool {
            (value as NSString).size(withAttributes: attributes).width <= 180
        }
        guard !fits(text) else { return text }
        var low = 0
        var high = text.count - 1
        func shortened(_ count: Int) -> String {
            text.prefix((count + 1) / 2) + "…" + text.suffix(count / 2)
        }
        while low < high {
            let mid = (low + high + 1) / 2
            if fits(shortened(mid)) { low = mid } else { high = mid - 1 }
        }
        return shortened(low)
    }
}

struct RootSidebarGatewayControl: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(GatewayConnectionController.self) private var gatewayController
    private static let logger = Logger(subsystem: "ai.openclawfoundation.app", category: "GatewayPicker")
    @State private var registry = GatewaySettingsStore.GatewayRegistry.empty
    let fallbackName: String
    let openSettings: () -> Void

    /// Always the connection control: it shows the connection and switches it. The person's identity
    /// belongs to Settings, not to this bar.
    var body: some View {
        let status = GatewayStatusBuilder.source(for: self.appModel.connection.node, appModel: self.appModel)
        SidebarGatewayPicker(
            presentation: SidebarGatewayPresentation(
                registry: self.registry,
                connectionID: self.appModel.activeGatewayConnectConfig?.effectiveStableID,
                connectedID: self.appModel.connectedGatewayID,
                state: status.displayState,
                problemText: status.displayState == .error ? status.statusText : nil),
            fallbackName: self.fallbackName,
            isSwitching: self.appModel.isGatewayPickerRequestInFlight ||
                self.gatewayController.hasPendingConnectionHandoff,
            selectGateway: self.switchGateway,
            openSettings: self.openSettings)
            .onAppear { self.refreshRegistry() }
            .onReceive(NotificationCenter.default.publisher(for: GatewaySettingsStore.gatewayRegistryDidChange)
                .receive(on: DispatchQueue.main)) { _ in self.refreshRegistry() }
    }

    /// The picker shows the host it's still on, so the toast only says what to do first.
    private func refuseSwitch(_ text: String) {
        self.appModel.toasts.post(OpenClawToast(text, systemImage: "exclamationmark.circle", kind: .warning))
    }

    private func postSwitchFailure(_ message: String, stableID: String) {
        Self.logger.error("Host switch failed: \(message, privacy: .public)")
        let entry = self.registry.entries.first { GatewayStableIdentifier.matches($0.stableID, stableID) }
        let toast = GatewaySwitchFailureToast(
            message: message,
            problemKind: self.appModel.gatewayPreconnectProblemKind(for: stableID),
            hostName: entry.map(self.registry.compactName))
        guard toast.offersRetry else {
            self.appModel.toasts.post(.failure(toast.text))
            return
        }
        self.appModel.toasts.post(.failure(toast.text, retry: { self.switchGateway(stableID) }))
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
            self.refuseSwitch(String(localized: "Finish recording or remove attachments first."))
            return
        }
        if let draft = self.appModel.chatPresentation.viewModel?.input, !draft.isEmpty {
            self.refuseSwitch(String(localized: "Send or clear your draft first."))
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
                self.postSwitchFailure(message, stableID: stableID)
            case .superseded:
                // The newer attempt is the one the picker shows; nothing to say about this one.
                break
            }
        }
    }
}
