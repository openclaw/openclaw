import Foundation
import OpenClawKit

/// This Mac as an OpenClaw ID device of one claw. Preferences select it; D, W and W_node live in
/// their own Keychain items and the pin and restart inputs in the native trust store.
struct MacOpenClawIDDevice: Equatable {
    enum Approval: String { case device, recoveryKit }

    let hostname: String
    let clawID: String
    let discoveryOrigin: URL
    /// Selects D, W and the device's trust row.
    let deviceEnrollmentID: UUID
    /// Selects W_node and its trust row while this Mac runs tools for the claw.
    var nodeEnrollmentID: UUID?
    let approvedWith: Approval
}

/// Owns which claw this Mac is an owner device of, its Discovery session and the Keychain keys.
/// The node worker only ever receives W_node through the node coordinator's selection.
@MainActor
final class MacOpenClawIDDeviceStore {
    static let shared = MacOpenClawIDDeviceStore(
        defaults: AppDefaults.standard,
        databaseURL: MacNodeOpenClawIDSelectionStore.shared.databaseURL)

    private let defaults: UserDefaults
    private let key = "openclaw.mac.openClawID.device"
    let databaseURL: URL

    init(defaults: UserDefaults, databaseURL: URL) {
        self.defaults = defaults
        self.databaseURL = databaseURL
    }

    func load() -> MacOpenClawIDDevice? {
        guard let fields = self.defaults.dictionary(forKey: self.key) as? [String: String],
              let hostname = fields["hostname"], let clawID = fields["clawID"],
              let origin = fields["discoveryOrigin"].flatMap(URL.init(string:)),
              let device = fields["deviceEnrollmentID"].flatMap(UUID.init(uuidString:)),
              let approval = fields["approvedWith"].flatMap(MacOpenClawIDDevice.Approval.init(rawValue:))
        else { return nil }
        return .init(
            hostname: hostname,
            clawID: clawID,
            discoveryOrigin: origin,
            deviceEnrollmentID: device,
            nodeEnrollmentID: fields["nodeEnrollmentID"].flatMap(UUID.init(uuidString:)),
            approvedWith: approval)
    }

    func save(_ device: MacOpenClawIDDevice?) {
        guard let device else {
            self.defaults.removeObject(forKey: self.key)
            return
        }
        var fields = [
            "hostname": device.hostname,
            "clawID": device.clawID,
            "discoveryOrigin": device.discoveryOrigin.absoluteString,
            "deviceEnrollmentID": device.deviceEnrollmentID.uuidString,
            "approvedWith": device.approvedWith.rawValue,
        ]
        fields["nodeEnrollmentID"] = device.nodeEnrollmentID?.uuidString
        self.defaults.set(fields, forKey: self.key)
    }

    /// The node coordinator's selection for this device's W_node, if it runs tools.
    func nodeTarget(_ device: MacOpenClawIDDevice) -> MacNodeOpenClawIDTarget? {
        device.nodeEnrollmentID.map {
            MacNodeOpenClawIDTarget(
                hostname: device.hostname,
                enrollmentID: $0,
                databaseURL: self.databaseURL,
                identityStore: OpenClawIDNodeIdentityKeychainStore(enrollmentID: $0, purpose: .node))
        }
    }

    /// What the operator route dials with: W, re-verified against the pin before every dial.
    func operatorEnrollment() -> MacOpenClawIDOperatorEnrollment? {
        guard let device = self.load() else { return nil }
        let databaseURL = self.databaseURL
        return .init(id: device.deviceEnrollmentID, hostname: device.hostname) {
            let session = await self.session()
            let peer = try await OpenClawIDNodeIdentity.loadOrCreate(store: OpenClawIDNodeIdentityKeychainStore(
                enrollmentID: device.deviceEnrollmentID, purpose: .devicePeer))
            let node = try await device.nodeEnrollmentID.asyncMap {
                try await OpenClawIDNodeIdentity.loadOrCreate(
                    store: OpenClawIDNodeIdentityKeychainStore(enrollmentID: $0, purpose: .node))
            }
            let store = OpenClawIDNodeNativeTrustStore(
                databaseURL: databaseURL, enrollmentID: device.deviceEnrollmentID, assertCurrent: {})
            return MacOpenClawIDOperatorCredential(
                identity: peer,
                verifiedTarget: {
                    let target = try await OpenClawIDDeviceRoute.refresh(
                        hostname: device.hostname,
                        discoveryOrigin: device.discoveryOrigin,
                        peer: peer,
                        admission: .owner,
                        node: node,
                        session: session,
                        store: store)
                    return (target.serverKey, target.relayURL)
                },
                close: { await store.close() })
        }
    }

    /// D for this device's own membership writes; it never crosses the node bridge.
    func deviceKey(_ device: MacOpenClawIDDevice) async throws -> OpenClawIDNodeIdentity {
        try await OpenClawIDNodeIdentity.loadOrCreate(store: OpenClawIDNodeIdentityKeychainStore(
            enrollmentID: device.deviceEnrollmentID, purpose: .device))
    }

    /// Forgets the device: preferences, its Discovery session and every key it held.
    func forget(_ device: MacOpenClawIDDevice) async {
        self.save(nil)
        self.saveSession(nil)
        var stores = [
            OpenClawIDNodeIdentityKeychainStore(enrollmentID: device.deviceEnrollmentID, purpose: .device),
            OpenClawIDNodeIdentityKeychainStore(enrollmentID: device.deviceEnrollmentID, purpose: .devicePeer),
        ]
        if let node = device.nodeEnrollmentID {
            stores.append(OpenClawIDNodeIdentityKeychainStore(enrollmentID: node, purpose: .node))
        }
        for store in stores {
            try? await store.delete()
        }
    }

    // MARK: Discovery session (Keychain, device-only; it authenticates the person to Discovery only)

    private var sessionService: String {
        AppProfile.current.keychainService(base: "ai.openclaw.openclaw-id-session")
    }

    func session() -> OpenClawIDDiscoverySession? {
        guard let text = GenericPasswordKeychainStore.loadString(service: self.sessionService, account: "discovery"),
              let fields = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
              let token = fields["token"] as? String, let account = fields["account_id"] as? String,
              let expires = (fields["expires_at"] as? NSNumber)?.int64Value,
              expires > Int64(Date().timeIntervalSince1970)
        else { return nil }
        return .init(token: token, accountID: account, email: fields["email"] as? String, expiresAt: expires)
    }

    func saveSession(_ session: OpenClawIDDiscoverySession?) {
        guard let session else {
            GenericPasswordKeychainStore.delete(service: self.sessionService, account: "discovery")
            return
        }
        var fields: [String: Any] = [
            "token": session.token, "account_id": session.accountID, "expires_at": session.expiresAt,
        ]
        fields["email"] = session.email
        guard let data = try? JSONSerialization.data(withJSONObject: fields),
              let text = String(data: data, encoding: .utf8) else { return }
        GenericPasswordKeychainStore.saveString(text, service: self.sessionService, account: "discovery")
    }
}

extension Optional {
    fileprivate func asyncMap<T>(_ transform: (Wrapped) async throws -> T) async rethrows -> T? {
        guard let self else { return nil }
        return try await transform(self)
    }
}
