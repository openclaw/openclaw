import Foundation
import OpenClawKit

/// Owns which claw this Mac is an owner or member device of, its Discovery session and the Keychain keys.
/// The node worker only ever receives W_node through the node coordinator's selection.
@MainActor
final class MacOpenClawIDDeviceStore {
    static let shared = MacOpenClawIDDeviceStore(
        defaults: AppDefaults.standard,
        databaseURL: MacNodeOpenClawIDSelectionStore.shared.databaseURL)

    private var localRemoval: UUID?
    private let defaults: UserDefaults
    private let removalKey = "openclaw.mac.openClawID.lastRemoval"
    /// The device, pending member request and Discovery session.
    let records: OpenClawIDDeviceRecords
    let databaseURL: URL

    init(defaults: UserDefaults, databaseURL: URL) {
        self.defaults = defaults
        self.databaseURL = databaseURL
        self.records = OpenClawIDDeviceRecords(
            defaults: defaults,
            keyPrefix: "openclaw.mac.openClawID",
            sessionService: AppProfile.current.keychainService(base: "ai.openclaw.openclaw-id-session"))
    }

    func load() -> OpenClawIDDevice? {
        self.records.load()
    }

    func save(_ device: OpenClawIDDevice?) {
        self.records.save(device)
        if device != nil { self.clearRemoval() }
    }

    func pendingJoin() -> OpenClawIDPendingJoin? {
        self.records.pendingJoin()
    }

    func savePendingJoin(_ join: OpenClawIDPendingJoin?) {
        self.records.savePendingJoin(join)
    }

    func lastRemoval() -> MacOpenClawIDRemoval? {
        guard let fields = self.defaults.dictionary(forKey: self.removalKey),
              let hostname = fields["hostname"] as? String,
              let timestamp = fields["timestamp"] as? Double,
              let origin = (fields["origin"] as? String).flatMap(MacOpenClawIDRemoval.Origin.init(rawValue:))
        else { return nil }
        return .init(
            hostname: hostname,
            date: Date(timeIntervalSince1970: timestamp),
            origin: origin,
            member: fields["member"] as? Bool ?? false)
    }

    func clearRemoval() {
        self.defaults.removeObject(forKey: self.removalKey)
    }

    /// Retain the local intent while the signed revocation and its lost-response verification run.
    func beginLocalRemoval(_ device: OpenClawIDDevice) {
        self.localRemoval = device.deviceEnrollmentID
    }

    func endLocalRemoval(_ device: OpenClawIDDevice) {
        if self.localRemoval == device.deviceEnrollmentID { self.localRemoval = nil }
    }

    /// Both local removal and a verified remote removal retire the same device-local state.
    func remove(
        _ device: OpenClawIDDevice,
        origin: MacOpenClawIDRemoval.Origin,
        now: Date = Date(),
        stopRoute: () -> Void = { MacOpenClawIDOperatorRoute.shared.stop() },
        deselectNode: () -> Void = { MacNodeModeCoordinator.shared.selectOpenClawIDTarget(nil) },
        forgetKeys: ((OpenClawIDDevice) async -> Void)? = nil,
        clearPrimary: () -> Void = { try? AppStateStore.shared.setPrimaryGateway(.clear) }) async
    {
        guard let current = self.load(), current.deviceEnrollmentID == device.deviceEnrollmentID else { return }
        let device = current
        let removal = MacOpenClawIDRemoval(
            hostname: device.hostname,
            date: now,
            origin: self.localRemoval == device.deviceEnrollmentID ? .here : origin,
            member: device.memberRole != nil)
        self.defaults.set([
            "hostname": removal.hostname, "shortName": removal.shortName,
            "timestamp": removal.date.timeIntervalSince1970, "origin": removal.origin.rawValue,
            "member": removal.member,
        ], forKey: self.removalKey)
        stopRoute()
        deselectNode()
        self.save(nil)
        if forgetKeys == nil { self.saveSession(nil) }
        clearPrimary()
        if let forgetKeys {
            await forgetKeys(device)
        } else {
            await self.forgetKeys(device)
        }
    }

    /// The node coordinator's selection for this device's W_node, if it runs tools.
    func nodeTarget(_ device: OpenClawIDDevice) -> MacNodeOpenClawIDTarget? {
        device.nodeEnrollmentID.map {
            MacNodeOpenClawIDTarget(
                hostname: device.hostname,
                enrollmentID: $0,
                databaseURL: self.databaseURL,
                identityStore: OpenClawIDNodeIdentityKeychainStore(enrollmentID: $0, purpose: .node))
        }
    }

    /// What the operator route dials with: W, re-verified against the pin before every dial. The
    /// node key and Discovery session are read again for each verification, so turning tools on or
    /// off, or signing in again, takes effect without replacing the route.
    func operatorEnrollment() -> MacOpenClawIDOperatorEnrollment? {
        guard let device = self.load() else { return nil }
        let databaseURL = self.databaseURL
        return .init(id: device.deviceEnrollmentID, hostname: device.hostname) {
            let peer = try await OpenClawIDNodeIdentity.loadOrCreate(store: OpenClawIDNodeIdentityKeychainStore(
                enrollmentID: device.deviceEnrollmentID, purpose: .devicePeer))
            let store = OpenClawIDNodeNativeTrustStore(
                databaseURL: databaseURL, enrollmentID: device.deviceEnrollmentID, assertCurrent: {})
            return MacOpenClawIDOperatorCredential(
                identity: peer,
                verifiedTarget: {
                    let (nodeID, session) = await MainActor.run {
                        (self.load()?.nodeEnrollmentID, self.session(for: device))
                    }
                    let node = try await nodeID.asyncMap {
                        try await OpenClawIDNodeIdentity.loadOrCreate(
                            store: OpenClawIDNodeIdentityKeychainStore(enrollmentID: $0, purpose: .node))
                    }
                    do {
                        let target = try await OpenClawIDDeviceRoute.refresh(
                            hostname: device.hostname,
                            discoveryOrigin: device.discoveryOrigin,
                            peer: peer,
                            admission: device.admission,
                            node: node,
                            session: session,
                            store: store)
                        return (target.serverKey, target.relayURL)
                    } catch OpenClawIDNodeEnrollmentError.notAdmitted {
                        await self.remove(device, origin: .elsewhere)
                        throw OpenClawIDNodeEnrollmentError.notAdmitted
                    }
                },
                close: { await store.close() })
        }
    }

    /// D for this device's own membership writes; it never crosses the node bridge.
    func deviceKey(_ device: OpenClawIDDevice) async throws -> OpenClawIDNodeIdentity {
        try await OpenClawIDNodeIdentity.loadOrCreate(store: OpenClawIDNodeIdentityKeychainStore(
            enrollmentID: device.deviceEnrollmentID, purpose: .device))
    }

    /// Deletes only the retired enrollment's keys, not a newly joined device's preferences.
    private func forgetKeys(_ device: OpenClawIDDevice) async {
        await Self.forgetKeys(device: device.deviceEnrollmentID, node: device.nodeEnrollmentID)
    }

    static func forgetKeys(device: UUID, node: UUID? = nil) async {
        await OpenClawIDDeviceRecords.forgetKeys(device: device, node: node)
    }

    func session() -> OpenClawIDDiscoverySession? {
        self.records.session()
    }

    func session(for device: OpenClawIDDevice) -> OpenClawIDDiscoverySession? {
        self.records.session(for: device)
    }

    func saveSession(_ session: OpenClawIDDiscoverySession?) {
        self.records.saveSession(session)
    }
}

extension Optional {
    fileprivate func asyncMap<T>(_ transform: (Wrapped) async throws -> T) async rethrows -> T? {
        guard let self else { return nil }
        return try await transform(self)
    }
}
