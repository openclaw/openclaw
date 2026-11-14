import OpenClawKit
import SwiftUI

/// What Settings shows about this Mac's OpenClaw ID access. Display data only.
enum OpenClawIDSettingsPresentation: Equatable {
    case signIn(removal: MacOpenClawIDRemoval?)
    /// Connected through another route (Tailscale, token, SSH); offer to switch.
    case migrate(claw: String, route: String, address: String)
    /// `needsSignIn`: without a node, the route re-reads the claw with the person's Discovery
    /// session, and that session has ended.
    case owner(claw: String, device: String, runsTools: Bool, approvedWith: String, needsSignIn: Bool)
}

/// Settings' owner of this Mac's OpenClaw ID device actions. Every write is signed with D in this
/// process and sent over the device's own tunnel; nothing here reaches the node worker.
@MainActor
@Observable
final class OpenClawIDSettingsModel {
    enum Confirmation: Identifiable, Equatable {
        case migrate(claw: String, route: String, address: String)
        case stopTools(claw: String, device: String)
        case startTools(claw: String, device: String)
        case remove(claw: String, device: String)

        var id: String {
            switch self {
            case .migrate: "migrate"
            case .stopTools: "stop"
            case .startTools: "start"
            case .remove: "remove"
            }
        }
    }

    var confirmation: Confirmation?
    private(set) var busy = false
    private(set) var error: String?
    private(set) var revision = 0
    @ObservationIgnored private let store: MacOpenClawIDDeviceStore
    @ObservationIgnored private let completeJoin: (String) throws -> Void

    init(
        store: MacOpenClawIDDeviceStore = .shared,
        completeJoin: @escaping (String) throws -> Void = { try MacOpenClawIDJoinCompletion.finish(claw: $0) })
    {
        self.store = store
        self.completeJoin = completeJoin
    }

    func presentation(state: AppState) -> OpenClawIDSettingsPresentation? {
        _ = self.revision
        let device = InstanceIdentity.displayName
        if let enrolled = self.store.load() {
            return .owner(
                claw: enrolled.hostname,
                device: device,
                runsTools: enrolled.nodeEnrollmentID != nil,
                approvedWith: enrolled.approvedWith == .recoveryKit
                    ? "Approved with your recovery kit" : "Approved from your other device",
                needsSignIn: enrolled.nodeEnrollmentID == nil && self.store.session() == nil)
        }
        return Self.unenrolledPresentation(
            available: MacOpenClawIDConfiguration.current() != nil,
            mode: state.connectionMode,
            transport: state.remoteTransport,
            target: state.remoteTarget,
            url: state.remoteUrl,
            removal: self.store.lastRemoval())
    }

    static func unenrolledPresentation(
        available: Bool,
        mode: AppState.ConnectionMode,
        transport: AppState.RemoteTransport,
        target: String,
        url: String,
        removal: MacOpenClawIDRemoval?) -> OpenClawIDSettingsPresentation?
    {
        guard available else { return nil }
        guard mode == .remote else { return .signIn(removal: removal) }
        if transport == .ssh {
            return .migrate(claw: target, route: "SSH", address: target)
        }
        guard let host = URL(string: url)?.host else { return .signIn(removal: removal) }
        let route = host.hasSuffix(".ts.net") || host.hasPrefix("100.") ? "Tailscale" : "a Gateway token"
        return .migrate(claw: host, route: route, address: host)
    }

    func confirm(_ confirmation: Confirmation) {
        self.confirmation = nil
        switch confirmation {
        case .migrate:
            MacOpenClawIDSignInPresenter.shared.present()
        case .stopTools: self.run { try await self.stopTools() }
        case .startTools: self.run { try await self.startTools() }
        case .remove: self.run { try await self.removeDevice() }
        }
    }

    /// Finishes a saved enrollment after a primary-connection save failure, including after restart.
    @discardableResult
    func retryPrimarySelection() -> Task<Void, Never>? {
        self.run {
            guard let device = self.store.load() else { return }
            try self.completeJoin(device.hostname)
        }
    }

    /// Starts a new Discovery session for this device's route. It reads the claw only; admission
    /// still comes from the claw's snapshot listing this Mac.
    func signInAgain() {
        self.run {
            guard let configuration = MacOpenClawIDConfiguration.current() else {
                throw OpenClawIDDeviceRouteError.signInRequired
            }
            let token = try await MacOpenClawIDSignIn(configuration: configuration).signIn()
            let session = try await OpenClawIDDiscoveryAccount(origin: configuration.discoveryOrigin)
                .createSession(idToken: token)
            self.store.saveSession(session)
            MacOpenClawIDOperatorRoute.shared.stop()
            await GatewayEndpointStore.shared.refresh()
        }
    }

    @discardableResult
    private func run(_ operation: @escaping @MainActor () async throws -> Void) -> Task<Void, Never>? {
        guard !self.busy else { return nil }
        self.busy = true
        self.error = nil
        return Task { @MainActor in
            do {
                try await operation()
            } catch {
                self.error = Self.message(error)
            }
            self.busy = false
            self.revision += 1
        }
    }

    private func actions(_ device: MacOpenClawIDDevice) async throws -> OpenClawIDOwnerDeviceActions {
        let live = try await MacOpenClawIDOperatorRoute.shared.current()
        return try await OpenClawIDOwnerDeviceActions(
            tunnel: live.tunnel, hostname: device.hostname, device: self.store.deviceKey(device))
    }

    private func stopTools() async throws {
        guard var device = self.store.load(), let nodeID = device.nodeEnrollmentID else { return }
        let keys = OpenClawIDNodeIdentityKeychainStore(enrollmentID: nodeID, purpose: .node)
        let node = try await OpenClawIDNodeIdentity.loadOrCreate(store: keys)
        try await self.actions(device).removeNode(peerKey: node.peerKey)
        device.nodeEnrollmentID = nil
        self.store.save(device)
        MacNodeModeCoordinator.shared.selectOpenClawIDTarget(nil)
        try? await keys.delete()
    }

    private func startTools() async throws {
        guard var device = self.store.load(), device.nodeEnrollmentID == nil else { return }
        let nodeID = UUID()
        let node = try await OpenClawIDNodeIdentity.loadOrCreate(
            store: OpenClawIDNodeIdentityKeychainStore(enrollmentID: nodeID, purpose: .node))
        let peer = try await OpenClawIDNodeIdentity.loadOrCreate(store: OpenClawIDNodeIdentityKeychainStore(
            enrollmentID: device.deviceEnrollmentID, purpose: .devicePeer))
        let description = try await MacNodeModeCoordinator.shared.openClawIDEnrollmentDescription()
        try await self.actions(device).addNode(
            peer: peer.peerKey,
            node: node,
            label: String(InstanceIdentity.displayName.prefix(64)),
            description: description)
        // The node route re-verifies W_node in the claw's snapshot before it dials.
        try await OpenClawIDNodeNativeTrustStore(
            databaseURL: self.store.databaseURL, enrollmentID: nodeID, assertCurrent: {})
            .adopt(from: device.deviceEnrollmentID, hostname: device.hostname, peerKey: node.peerKey)
        device.nodeEnrollmentID = nodeID
        self.store.save(device)
        MacNodeModeCoordinator.shared.selectOpenClawIDTarget(self.store.nodeTarget(device))
    }

    private func removeDevice() async throws {
        guard let device = self.store.load() else { return }
        self.store.beginLocalRemoval(device)
        defer { self.store.endLocalRemoval(device) }
        do {
            try await self.actions(device).removeDevice()
        } catch let refused as OpenClawIDOwnerDeviceActionError {
            throw refused
        } catch {
            // The Gateway closes this Mac's connection as part of applying the revocation, so the
            // answer can be lost after it succeeded. Finish locally once the claw no longer lists it.
            guard await self.removed(device) else { throw error }
        }
        await self.store.remove(device, origin: .here)
    }

    /// Whether the claw's verified snapshot no longer lists this Mac's peer key.
    private func removed(_ device: MacOpenClawIDDevice) async -> Bool {
        guard let enrollment = self.store.operatorEnrollment(), enrollment.id == device.deviceEnrollmentID,
              let credential = try? await enrollment.credential()
        else { return false }
        defer { Task { await credential.close() } }
        do {
            _ = try await credential.verifiedTarget()
            return false
        } catch OpenClawIDNodeEnrollmentError.notAdmitted {
            return true
        } catch {
            return false
        }
    }

    private static func message(_ error: Error) -> String {
        switch error {
        case let refused as OpenClawIDOwnerDeviceActionError where refused.code == "seq_conflict":
            "The claw changed while this was saved. Try again."
        case is OpenClawIDOwnerDeviceActionError:
            "The claw refused the change. Check that this Mac is still your device."
        case OpenClawIDDeviceRouteError.signInRequired:
            "Sign in to OpenClaw ID again to reach your claw."
        default:
            "Couldn’t reach your claw. Check that it’s online, then try again."
        }
    }
}

struct OpenClawIDSettingsSection: View {
    let presentation: OpenClawIDSettingsPresentation
    @Bindable var model: OpenClawIDSettingsModel

    var body: some View {
        Section("OpenClaw ID") {
            switch self.presentation {
            case let .signIn(removal):
                if let removal {
                    self.header(
                        "Removed from \(removal.hostname)", detail: removal.settingsMessage(), icon: "info.circle")
                }
                HStack {
                    self.header(
                        "Sign in with OpenClaw ID",
                        detail: "Reach your claw from anywhere with your own approval, no VPN or shared token.",
                        icon: "person.crop.circle")
                    Spacer()
                    Button("Sign in…") { MacOpenClawIDSignInPresenter.shared.present() }
                }
            case let .migrate(claw, route, address):
                self.header(
                    "Sign in with OpenClaw ID",
                    detail: """
                    This Mac reaches \(claw) over \(route). Switch this connection to OpenClaw ID to connect \
                    from anywhere with your own approval, without a VPN or shared token. \(route) itself \
                    keeps running.
                    """,
                    icon: "person.crop.circle.badge.plus")
                HStack {
                    Spacer()
                    Button("Sign in and switch…") {
                        self.model.confirmation = .migrate(claw: claw, route: route, address: address)
                    }
                    .buttonStyle(.borderedProminent)
                }
            case let .owner(claw, device, runsTools, approvedWith, needsSignIn):
                self.header(
                    "\(device) · Your device on \(claw)",
                    detail: "Full access, like your browser. \(approvedWith).",
                    icon: "checkmark.seal.fill")
                LabeledContent {
                    Text(runsTools ? "On" : "Off").foregroundStyle(.secondary)
                } label: {
                    self.plain("Runs tools for \(claw)")
                }
                Text(runsTools
                    ? """
                    Your assistant can use this Mac’s commands, screen, camera and notifications, \
                    within the permissions you grant.
                    """
                    : "Your assistant can’t use this Mac. You can still chat and use the dashboard.")
                    .font(.callout).foregroundStyle(.secondary)
                HStack {
                    if runsTools {
                        Button("Stop using this Mac for tools…") {
                            self.model.confirmation = .stopTools(claw: claw, device: device)
                        }
                    } else {
                        Button("Use this Mac for tools…") {
                            self.model.confirmation = .startTools(claw: claw, device: device)
                        }
                    }
                    Button("Open Dashboard") { self.model.retryPrimarySelection() }.disabled(self.model.busy)
                    Spacer()
                    Button("Remove this Mac…", role: .destructive) {
                        self.model.confirmation = .remove(claw: claw, device: device)
                    }
                }
                .disabled(self.model.busy)
                if needsSignIn {
                    HStack {
                        self.plain("Sign in to OpenClaw ID again to keep reaching \(claw) from this Mac.")
                            .font(.callout).foregroundStyle(.secondary)
                        Spacer()
                        Button("Sign in again…") { self.model.signInAgain() }.disabled(self.model.busy)
                    }
                }
            }
            if let error = self.model.error {
                Text(error).font(.callout).foregroundStyle(.orange)
            }
        }
        .sheet(item: self.$model.confirmation) { confirmation in
            OpenClawIDConfirmationSheet(kind: confirmation) { self.model.confirm(confirmation) }
        }
    }

    /// Runtime text built from claw and device names (rendered as given).
    private func plain(_ text: String) -> Text {
        Text(text)
    }

    private func header(_ title: String, detail: String, icon: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon).font(.system(size: 22, weight: .medium)).foregroundStyle(.tint).frame(width: 32)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.headline)
                Text(detail).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 4)
    }
}

/// Confirms an OpenClaw ID change to this Mac's access before it is made.
struct OpenClawIDConfirmationSheet: View {
    let kind: OpenClawIDSettingsModel.Confirmation
    let confirm: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            switch self.kind {
            case let .migrate(claw, route, address):
                self.title("Switch \(claw) to OpenClaw ID?")
                Text("You’ll sign in and approve this Mac as your device. When it’s approved:")
                    .foregroundStyle(.secondary)
                self.bullet(
                    "This Mac’s connection to \(claw) over \(route) (\(address)) is replaced by OpenClaw ID.",
                    icon: "arrow.triangle.2.circlepath")
                self.bullet(
                    """
                    The Gateway token or password saved on this Mac is cleared, so removing this Mac in \
                    OpenClaw ID fully cuts it off.
                    """,
                    icon: "key.slash")
                self.bullet(
                    "This Mac’s existing node pairing is replaced by its OpenClaw ID node.",
                    icon: "desktopcomputer")
                self.bullet(
                    """
                    \(route) is not changed. It keeps running on this Mac, and the Gateway’s \(route) \
                    access still works for your other devices.
                    """,
                    icon: "info.circle")
                self.bullet(
                    "To go back, use Change connection… and set up \(route) again with a new setup code.",
                    icon: "arrow.uturn.backward.circle")
                self.buttons(cancel: "Not now", confirm: "Sign in and switch", destructive: false)
            case let .stopTools(claw, device):
                self.title("Stop using \(device) for tools?")
                self.detail("""
                Your assistant on \(claw) can no longer run commands or use the screen, camera or \
                notifications on this Mac. Running tool calls stop.
                """)
                self.bullet(
                    "This Mac stays your device. Chat and the dashboard keep working.",
                    icon: "checkmark.circle")
                self.bullet("You can turn it back on here.", icon: "arrow.uturn.backward.circle")
                self.buttons(cancel: "Cancel", confirm: "Stop using for tools", destructive: true)
            case let .startTools(claw, device):
                self.title("Use \(device) for tools?")
                self.detail("""
                Your assistant on \(claw) can run commands and use the screen, camera and notifications \
                on this Mac, within the permissions you grant.
                """)
                self.buttons(cancel: "Cancel", confirm: "Use for tools", destructive: false)
            case let .remove(claw, device):
                self.title("Remove \(device) from \(claw)?")
                self.detail("This Mac loses all access to \(claw) now: chat, dashboard and tools.")
                self.bullet("Devices this Mac approved lose access too.", icon: "exclamationmark.triangle")
                self.bullet(
                    "To use it again, sign in and approve it from another device or with your recovery kit.",
                    icon: "key")
                self.buttons(cancel: "Cancel", confirm: "Remove this Mac", destructive: true)
            }
        }
        .padding(24)
        .frame(width: 480)
    }

    private func title(_ text: String) -> some View {
        Text(text).font(.title2.weight(.semibold))
    }

    private func detail(_ text: String) -> some View {
        Text(text).foregroundStyle(.secondary)
    }

    private func bullet(_ text: String, icon: String) -> some View {
        Label {
            Text(text).fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: icon).foregroundStyle(.tint)
        }
    }

    private func buttons(cancel: String, confirm: String, destructive: Bool) -> some View {
        HStack {
            Spacer()
            Button(cancel) { self.dismiss() }.keyboardShortcut(.cancelAction)
            Button(confirm, role: destructive ? .destructive : nil) {
                self.dismiss()
                self.confirm()
            }
            .keyboardShortcut(.defaultAction)
        }
        .padding(.top, 6)
    }
}
