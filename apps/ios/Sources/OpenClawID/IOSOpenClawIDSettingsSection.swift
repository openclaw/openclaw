import OpenClawKit
import SwiftUI
import UIKit

/// Settings' owner of this device's OpenClaw ID actions. Every write is signed with D in this
/// process and sent over the device's own operator tunnel.
@MainActor
@Observable
final class IOSOpenClawIDSettingsModel {
    enum Confirmation: String, Identifiable {
        case startTools
        case stopTools
        case remove

        var id: String {
            self.rawValue
        }
    }

    var confirmation: Confirmation?
    private(set) var busy = false
    private(set) var error: String?
    private(set) var revision = 0

    var device: OpenClawIDDevice? {
        _ = self.revision
        return IOSOpenClawIDFeature.records.load()
    }

    /// Without W_node the route reads the claw with the Discovery session, and that session has ended.
    func needsSignIn(_ device: OpenClawIDDevice) -> Bool {
        device.nodeEnrollmentID == nil && IOSOpenClawIDFeature.records.session(for: device) == nil
    }

    func confirm(
        _ confirmation: Confirmation,
        gatewayController: GatewayConnectionController,
        reconnect: @escaping @MainActor () async -> Void)
    {
        self.confirmation = nil
        self.run {
            switch confirmation {
            case .startTools:
                try await self.startTools(gatewayController: gatewayController)
                await reconnect()
            case .stopTools:
                try await self.stopTools()
                await reconnect()
            case .remove:
                try await self.removeDevice()
            }
        }
    }

    /// Starts a new Discovery session for this device's route. It reads the claw only; admission
    /// still comes from the claw's snapshot listing this device.
    func signInAgain(reconnect: @escaping @MainActor () async -> Void) {
        self.run {
            guard let configuration = IOSOpenClawIDFeature.configuration(),
                  let signIn = IOSOpenClawIDFeature.signIn(configuration)
            else { throw OpenClawIDDeviceRouteError.signInRequired }
            let token = try await signIn.signIn()
            let session = try await OpenClawIDDiscoveryAccount(origin: configuration.discoveryOrigin)
                .createSession(idToken: token)
            IOSOpenClawIDFeature.records.saveSession(session)
            IOSOpenClawIDRoute.shared.stop()
            await reconnect()
        }
    }

    private func run(_ operation: @escaping @MainActor () async throws -> Void) {
        guard !self.busy else { return }
        self.busy = true
        self.error = nil
        Task { @MainActor in
            do {
                try await operation()
            } catch {
                IOSOpenClawIDFeature.logger.error(
                    "OpenClaw ID settings action failed: \(String(reflecting: error), privacy: .public)")
                self.error = Self.message(error)
            }
            self.busy = false
            self.revision += 1
        }
    }

    private func actions(_ device: OpenClawIDDevice) async throws -> OpenClawIDOwnerDeviceActions {
        let live = try await IOSOpenClawIDRoute.shared.current()
        let key = try await OpenClawIDNodeIdentity.loadOrCreate(store: OpenClawIDNodeIdentityKeychainStore(
            enrollmentID: device.deviceEnrollmentID, purpose: .device))
        return try await OpenClawIDOwnerDeviceActions(tunnel: live.tunnel, hostname: device.hostname, device: key)
    }

    private func startTools(gatewayController: GatewayConnectionController) async throws {
        guard var device = IOSOpenClawIDFeature.records.load(), device.nodeEnrollmentID == nil else { return }
        let nodeID = UUID()
        let keys = OpenClawIDNodeIdentityKeychainStore(enrollmentID: nodeID, purpose: .node)
        do {
            let node = try await OpenClawIDNodeIdentity.loadOrCreate(store: keys)
            let peer = try await OpenClawIDNodeIdentity.loadOrCreate(store: OpenClawIDNodeIdentityKeychainStore(
                enrollmentID: device.deviceEnrollmentID, purpose: .devicePeer))
            let description = try await IOSOpenClawIDFeature.nodeDescription(gatewayController: gatewayController)
            try await self.actions(device).addNode(
                peer: peer.peerKey,
                node: node,
                label: String(UIDevice.current.name.prefix(64)),
                description: description)
            // The node route re-verifies W_node in the claw's snapshot before it dials.
            let store = OpenClawIDNodeNativeTrustStore(
                databaseURL: IOSOpenClawIDFeature.databaseURL, enrollmentID: nodeID, assertCurrent: {})
            try await store.adopt(from: device.deviceEnrollmentID, hostname: device.hostname, peerKey: node.peerKey)
            await store.close()
        } catch {
            try? await keys.delete()
            throw error
        }
        device.nodeEnrollmentID = nodeID
        IOSOpenClawIDFeature.records.save(device)
        IOSOpenClawIDRoute.shared.stop()
    }

    private func stopTools() async throws {
        guard var device = IOSOpenClawIDFeature.records.load(), let nodeID = device.nodeEnrollmentID else { return }
        let keys = OpenClawIDNodeIdentityKeychainStore(enrollmentID: nodeID, purpose: .node)
        let node = try await OpenClawIDNodeIdentity.loadOrCreate(store: keys)
        try await self.actions(device).removeNode(peerKey: node.peerKey)
        device.nodeEnrollmentID = nil
        IOSOpenClawIDFeature.records.save(device)
        IOSOpenClawIDRoute.shared.stop()
        try? await keys.delete()
    }

    private func removeDevice() async throws {
        guard let device = IOSOpenClawIDFeature.records.load() else { return }
        do {
            try await self.actions(device).removeDevice()
        } catch let refused as OpenClawIDOwnerDeviceActionError {
            throw refused
        } catch {
            // The Gateway closes this device's connection as it applies the revocation, so the answer
            // can be lost after it succeeded. A fresh route finds out: the claw no longer lists it.
            IOSOpenClawIDRoute.shared.stop()
            _ = try? await IOSOpenClawIDRoute.shared.current()
            guard IOSOpenClawIDFeature.records.load() == nil else { throw error }
            return
        }
        await IOSOpenClawIDRoute.shared.removed(device)
    }

    private static func message(_ error: Error) -> String {
        switch error {
        case let refused as OpenClawIDOwnerDeviceActionError where refused.code == "seq_conflict":
            String(localized: "The claw changed while this was saved. Try again.")
        case is OpenClawIDOwnerDeviceActionError:
            String(localized: "The claw refused the change. Check that this device is still yours.")
        case OpenClawIDDeviceRouteError.signInRequired:
            String(localized: "Sign in to OpenClaw ID again to reach your claw.")
        default:
            String(localized: "Couldn’t reach your claw. Check that it’s online, then try again.")
        }
    }
}

/// This device's OpenClaw ID access in Gateway settings: which claw, how it was approved, whether
/// it runs tools, and removal.
struct IOSOpenClawIDSettingsSection: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(GatewayConnectionController.self) private var gatewayController
    @State private var model = IOSOpenClawIDSettingsModel()

    var body: some View {
        if let device = self.model.device {
            Section {
                self.summary(device)
                if device.memberRole == nil {
                    self.ownerActions(device)
                } else {
                    Text("To remove this device, open Your devices on another of your devices, or ask an owner.")
                        .font(OpenClawType.footnote)
                        .foregroundStyle(.secondary)
                }
                if self.model.needsSignIn(device) {
                    Button("Sign in to OpenClaw ID again") {
                        self.model.signInAgain(reconnect: self.reconnect)
                    }
                    .font(OpenClawType.body)
                    .disabled(self.model.busy)
                }
            } header: {
                Text("OpenClaw ID")
            } footer: {
                if let error = self.model.error {
                    Text(error).font(OpenClawType.footnote).foregroundStyle(.orange)
                }
            }
            .confirmationDialog(
                self.confirmationTitle(device),
                isPresented: Binding(
                    get: { self.model.confirmation != nil },
                    set: { if !$0 { self.model.confirmation = nil } }),
                titleVisibility: .visible,
                presenting: self.model.confirmation)
            { confirmation in
                Button(
                    self.confirmButton(confirmation),
                    role: confirmation == .startTools ? nil : .destructive)
                {
                    self.model.confirm(
                        confirmation, gatewayController: self.gatewayController, reconnect: self.reconnect)
                }
                Button("Cancel", role: .cancel) {}
            } message: { confirmation in
                Text(self.confirmationMessage(confirmation, device: device))
            }
        }
    }

    private func reconnect() async {
        await IOSOpenClawIDFeature.connect(appModel: self.appModel, gatewayController: self.gatewayController)
    }

    private func summary(_ device: OpenClawIDDevice) -> some View {
        let member = device.memberRole != nil
        let approval = switch device.approvedWith {
        case .recoveryKit: String(localized: "Approved with your recovery kit")
        case .invite: String(localized: "Added with an invite")
        default: String(localized: "Approved from your other device")
        }
        return VStack(alignment: .leading, spacing: 4) {
            Text(member
                ? String(format: String(localized: "Member of %@"), device.hostname)
                : String(format: String(localized: "Your device on %@"), device.hostname))
                .font(OpenClawType.headline)
            Text(member ? String(format: String(localized: "%@. Chat and the dashboard."), approval) : approval)
                .font(OpenClawType.footnote)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private func ownerActions(_ device: OpenClawIDDevice) -> some View {
        let runsTools = device.nodeEnrollmentID != nil
        SettingsDetailRow(
            "Runs tools",
            value: .verbatim(runsTools ? String(localized: "On") : String(localized: "Off")))
        Text(runsTools
            ? "Your assistant can use this device’s camera, location and other features you allow."
            : "Your assistant can’t use this device. You can still chat and use the dashboard.")
            .font(OpenClawType.footnote)
            .foregroundStyle(.secondary)
        Button(runsTools ? "Stop using this device for tools…" : "Use this device for tools…") {
            self.model.confirmation = runsTools ? .stopTools : .startTools
        }
        .font(OpenClawType.body)
        .disabled(self.model.busy)
        Button("Remove this device…", role: .destructive) {
            self.model.confirmation = .remove
        }
        .font(OpenClawType.body)
        .disabled(self.model.busy)
    }

    private func confirmationTitle(_ device: OpenClawIDDevice) -> String {
        switch self.model.confirmation {
        case .startTools: String(localized: "Use this device for tools?")
        case .stopTools: String(localized: "Stop using this device for tools?")
        case .remove: String(format: String(localized: "Remove this device from %@?"), device.hostname)
        case nil: ""
        }
    }

    private func confirmButton(_ confirmation: IOSOpenClawIDSettingsModel.Confirmation) -> String {
        switch confirmation {
        case .startTools: String(localized: "Use for tools")
        case .stopTools: String(localized: "Stop using for tools")
        case .remove: String(localized: "Remove this device")
        }
    }

    private func confirmationMessage(
        _ confirmation: IOSOpenClawIDSettingsModel.Confirmation,
        device: OpenClawIDDevice) -> String
    {
        switch confirmation {
        case .startTools:
            String(
                format: String(localized: "Your assistant on %@ can use this device’s features as you allow."),
                device.hostname)
        case .stopTools:
            String(localized: "Your assistant can no longer use this device. Chat and the dashboard keep working.")
        case .remove:
            String(localized: """
            This device loses all access now: chat, dashboard and tools. To use it again, sign in and \
            approve it from another device or with your recovery kit.
            """)
        }
    }
}
