import Foundation

/// This app as an OpenClaw ID device of one claw. Preferences select it; D, W and W_node live in
/// their own Keychain items and the pin and restart inputs in the native trust store.
public struct OpenClawIDDevice: Equatable, Sendable {
    public enum Approval: String, Sendable { case device, recoveryKit, invite }

    public let hostname: String
    public let clawID: String
    public let discoveryOrigin: URL
    /// Selects D, W and the device's trust row.
    public let deviceEnrollmentID: UUID
    /// Selects W_node and its trust row while this device runs tools for the claw.
    public var nodeEnrollmentID: UUID?
    public let approvedWith: Approval
    /// The invite's role when this device joined as a member; nil for an owner device. Members have
    /// no node and none of the owner's device actions.
    public var memberRole: String?
    /// The OpenClaw ID account a member device joined for. Only its Discovery session can tell that
    /// the claw no longer lists this member; another account's session is asked to sign in again.
    public var memberAccountID: String?

    public init(
        hostname: String,
        clawID: String,
        discoveryOrigin: URL,
        deviceEnrollmentID: UUID,
        nodeEnrollmentID: UUID?,
        approvedWith: Approval,
        memberRole: String? = nil,
        memberAccountID: String? = nil)
    {
        self.hostname = hostname
        self.clawID = clawID
        self.discoveryOrigin = discoveryOrigin
        self.deviceEnrollmentID = deviceEnrollmentID
        self.nodeEnrollmentID = nodeEnrollmentID
        self.approvedWith = approvedWith
        self.memberRole = memberRole
        self.memberAccountID = memberAccountID
    }

    public var admission: OpenClawIDAdmission {
        self.memberRole == nil ? .owner : .member
    }
}

/// A member join waiting for an owner's approval. D and W are already in the Keychain under
/// `deviceEnrollmentID`; the redemption is with the claw's Gateway.
public struct OpenClawIDPendingJoin: Equatable, Sendable {
    public let hostname: String
    public let clawID: String
    public let rootFingerprint: String
    public let discoveryOrigin: URL
    public let deviceEnrollmentID: UUID
    /// The OpenClaw ID account the request was sent for; another account's sign-in does not resume it.
    public let accountID: String
    public let requestedAt: Date

    public init(
        hostname: String,
        clawID: String,
        rootFingerprint: String,
        discoveryOrigin: URL,
        deviceEnrollmentID: UUID,
        accountID: String,
        requestedAt: Date)
    {
        self.hostname = hostname
        self.clawID = clawID
        self.rootFingerprint = rootFingerprint
        self.discoveryOrigin = discoveryOrigin
        self.deviceEnrollmentID = deviceEnrollmentID
        self.accountID = accountID
        self.requestedAt = requestedAt
    }

    /// A redemption no owner decided on expires at the Gateway after seven days.
    public func expired(now: Date = Date()) -> Bool {
        now.timeIntervalSince(self.requestedAt) >= 7 * 86400
    }
}

/// The saved device, pending member request and Discovery session of one app. Records only:
/// the app's device owner decides what installing or removing a device means.
@MainActor
public final class OpenClawIDDeviceRecords {
    private let defaults: UserDefaults
    private let key: String
    private let pendingKey: String
    private let sessionService: String

    /// `keyPrefix` names the preference keys (`<prefix>.device`, `<prefix>.pendingJoin`);
    /// `sessionService` is the Keychain service of the Discovery session.
    public init(defaults: UserDefaults, keyPrefix: String, sessionService: String) {
        self.defaults = defaults
        self.key = "\(keyPrefix).device"
        self.pendingKey = "\(keyPrefix).pendingJoin"
        self.sessionService = sessionService
    }

    public func load() -> OpenClawIDDevice? {
        guard let fields = self.defaults.dictionary(forKey: self.key) as? [String: String],
              let hostname = fields["hostname"], let clawID = fields["clawID"],
              let origin = fields["discoveryOrigin"].flatMap(URL.init(string:)),
              let device = fields["deviceEnrollmentID"].flatMap(UUID.init(uuidString:)),
              let approval = fields["approvedWith"].flatMap(OpenClawIDDevice.Approval.init(rawValue:))
        else { return nil }
        return .init(
            hostname: hostname,
            clawID: clawID,
            discoveryOrigin: origin,
            deviceEnrollmentID: device,
            nodeEnrollmentID: fields["nodeEnrollmentID"].flatMap(UUID.init(uuidString:)),
            approvedWith: approval,
            memberRole: fields["memberRole"],
            memberAccountID: fields["memberAccountID"])
    }

    public func save(_ device: OpenClawIDDevice?) {
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
        fields["memberRole"] = device.memberRole
        fields["memberAccountID"] = device.memberAccountID
        self.defaults.set(fields, forKey: self.key)
    }

    public func pendingJoin() -> OpenClawIDPendingJoin? {
        guard let fields = self.defaults.dictionary(forKey: self.pendingKey),
              let hostname = fields["hostname"] as? String, let clawID = fields["clawID"] as? String,
              let root = fields["rootFingerprint"] as? String,
              let origin = (fields["discoveryOrigin"] as? String).flatMap(URL.init(string:)),
              let device = (fields["deviceEnrollmentID"] as? String).flatMap(UUID.init(uuidString:)),
              let account = fields["accountID"] as? String, let requested = fields["requestedAt"] as? Double
        else { return nil }
        return .init(
            hostname: hostname,
            clawID: clawID,
            rootFingerprint: root,
            discoveryOrigin: origin,
            deviceEnrollmentID: device,
            accountID: account,
            requestedAt: Date(timeIntervalSince1970: requested))
    }

    public func savePendingJoin(_ join: OpenClawIDPendingJoin?) {
        guard let join else {
            self.defaults.removeObject(forKey: self.pendingKey)
            return
        }
        self.defaults.set([
            "hostname": join.hostname, "clawID": join.clawID, "rootFingerprint": join.rootFingerprint,
            "discoveryOrigin": join.discoveryOrigin.absoluteString,
            "deviceEnrollmentID": join.deviceEnrollmentID.uuidString, "accountID": join.accountID,
            "requestedAt": join.requestedAt.timeIntervalSince1970,
        ], forKey: self.pendingKey)
    }

    // MARK: Discovery session (Keychain, device-only; it authenticates the person to Discovery only)

    public func session() -> OpenClawIDDiscoverySession? {
        guard let text = GenericPasswordKeychainStore.loadString(service: self.sessionService, account: "discovery"),
              let fields = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
              let token = fields["token"] as? String, let account = fields["account_id"] as? String,
              let expires = (fields["expires_at"] as? NSNumber)?.int64Value,
              expires > Int64(Date().timeIntervalSince1970)
        else { return nil }
        return .init(token: token, accountID: account, email: fields["email"] as? String, expiresAt: expires)
    }

    /// The saved Discovery session when it may re-read this device's claw: a member device's own
    /// account only.
    public func session(for device: OpenClawIDDevice) -> OpenClawIDDiscoverySession? {
        guard let session = self.session() else { return nil }
        if let account = device.memberAccountID, account != session.accountID { return nil }
        return session
    }

    public func saveSession(_ session: OpenClawIDDiscoverySession?) {
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

    /// Deletes D and W (and W_node) of one enrollment from the Keychain.
    public nonisolated static func forgetKeys(device: UUID, node: UUID? = nil) async {
        var stores = [
            OpenClawIDNodeIdentityKeychainStore(enrollmentID: device, purpose: .device),
            OpenClawIDNodeIdentityKeychainStore(enrollmentID: device, purpose: .devicePeer),
        ]
        if let node {
            stores.append(OpenClawIDNodeIdentityKeychainStore(enrollmentID: node, purpose: .node))
        }
        for store in stores {
            try? store.delete()
        }
    }
}
