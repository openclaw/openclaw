import Foundation
import Security

/// The keys an app holds as an owner device: D signs, W is its owner peer key, and W_node is the
/// only key its node worker ever sees. D and W never leave the app process.
public struct OpenClawIDOwnerDeviceKeys: Sendable {
    public let device: OpenClawIDNodeIdentity
    public let peer: OpenClawIDNodeIdentity
    public let node: OpenClawIDNodeIdentity?

    public init(device: OpenClawIDNodeIdentity, peer: OpenClawIDNodeIdentity, node: OpenClawIDNodeIdentity?) {
        self.device = device
        self.peer = peer
        self.node = node
    }
}

/// Why an owner enrollment ended without admission. Never carries remote text or key material.
public enum OpenClawIDOwnerEnrollmentError: Error, Sendable, Equatable {
    /// The approving device declined or aborted.
    case denied
    /// Nobody approved in time, or the kit attempt's two minutes ran out.
    case expired
    /// Not a recovery code (format or checksum).
    case kitInvalid
    /// A valid kit for a different claw (its root is not this claw's).
    case wrongKit
    /// The sealed handoff did not open, or named another device or claw.
    case handoffInvalid
}

/// What the app pins and connects with after admission.
public struct OpenClawIDOwnerEnrolled: Sendable, Equatable {
    public let hostname: String
    public let clawID: String
    public let rootFingerprint: String
}

/// Sign-in-first owner enrollment of an app (enrollment.md, "Owner device node"): approval from an
/// existing owner device over SAS, or with the recovery kit. Both end with D and W listed as an
/// owner device and W_node listed as its node, verified in the claw's K_gw-signed snapshot.
public struct OpenClawIDOwnerEnrollmentClient: Sendable {
    /// The owner capabilities a kit-enrolled device requests, as a kit-enrolled browser does.
    static let ownerCapabilities = ["approve_device", "bind", "invite", "manage_members"]

    private let discovery: OpenClawIDDiscoveryAccount
    private let deviceStore: any OpenClawIDNodeTrustStore
    private let nodeStore: (any OpenClawIDNodeTrustStore)?
    private let now: @Sendable () -> Int64
    private let sleep: @Sendable (UInt64) async throws -> Void

    /// `deviceStore` keeps the pin and W's restart inputs; `nodeStore` keeps W_node's for the node route.
    public init(
        discoveryOrigin: URL,
        deviceStore: any OpenClawIDNodeTrustStore,
        nodeStore: (any OpenClawIDNodeTrustStore)?,
        http: any OpenClawIDNodeEnrollmentHTTP = OpenClawIDNodeEnrollmentURLSession(),
        now: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970) },
        sleep: @escaping @Sendable (UInt64) async throws -> Void = { try await Task.sleep(nanoseconds: $0) })
    {
        self.discovery = .init(origin: discoveryOrigin, http: http, now: now)
        self.deviceStore = deviceStore
        self.nodeStore = nodeStore
        self.now = now
        self.sleep = sleep
    }

    /// SAS approval from an existing owner device. `onCode` shows the six digits. The person must
    /// also confirm on this Mac that they match (`confirmed`: nil while undecided, false for a
    /// mismatch) before any sealed handoff is opened: otherwise a relay playing the approver could
    /// seal its own root to a Mac nobody compared (enrollment.md step 6, "both screens").
    public func approveFromDevice(
        session: OpenClawIDDiscoverySession,
        claw: OpenClawIDDiscoveryClaw,
        keys: OpenClawIDOwnerDeviceKeys,
        label: String,
        node: OpenClawIDNodeEnrollmentDescription?,
        onCode: @escaping @Sendable (String) async -> Void,
        confirmed: @escaping @Sendable () async -> Bool?) async throws -> OpenClawIDOwnerEnrolled
    {
        try await self.discovery.bindDevice(session, device: keys.device, peer: keys.peer, label: label)
        let requestID = OpenClawIDNodeIdentity.hex(Self.random(16))
        let attempt = OpenClawIDSASNewDevice(
            start: Self.sasStart(requestID: requestID, clawID: claw.id, keys: keys, label: label, node: node),
            requestID: requestID)
        try await self.discovery.send(
            session, device: keys.device, clawID: claw.id, to: "owners", payload: .object([
                "kind": .string("enrollment"),
                "request_id": .string(attempt.requestID),
                "step": .string("start"),
                "data": attempt.startData,
            ]))
        // The approver keeps a request for five minutes after it arrives.
        let deadline = self.now() + 330
        var cursor: String?
        var accepted: (sas: OpenClawIDSASNewDevice.Accepted, approver: String)?
        var sealed: (nonce: String, ciphertext: String)?
        while self.now() < deadline {
            if let current = accepted, let box = sealed {
                switch await confirmed() {
                case nil: break
                case false?:
                    try? await self.abort(attempt, to: current.approver, session: session, claw: claw, keys: keys)
                    throw OpenClawIDOwnerEnrollmentError.denied
                case true?:
                    guard let handoff = current.sas.open(nonce: box.nonce, ciphertext: box.ciphertext) else {
                        throw OpenClawIDOwnerEnrollmentError.handoffInvalid
                    }
                    let root = try Self.verifyHandoff(handoff, claw: claw, keys: keys)
                    return try await self.awaitAdmission(
                        session: session, claw: claw, rootFingerprint: root, keys: keys, until: self.now() + 120)
                }
            } else if let current = accepted, await confirmed() == false {
                try? await self.abort(attempt, to: current.approver, session: session, claw: claw, keys: keys)
                throw OpenClawIDOwnerEnrollmentError.denied
            }
            let (messages, next) = try await self.discovery.receive(
                session, device: keys.device, clawID: claw.id, after: cursor, wait: sealed == nil ? 10 : 1)
            cursor = next ?? cursor
            for mail in messages where mail.kind == "enrollment" && mail.requestID == attempt.requestID {
                switch mail.step ?? "" {
                case "abort": throw OpenClawIDOwnerEnrollmentError.denied
                case "accept" where accepted == nil:
                    guard let ephemeral = mail.data["eph_pub"], let approver = mail.data["device_pub"],
                          let current = try? attempt.accepted(ephemeralE: ephemeral, devicePubE: approver),
                          let approverFingerprint = try? OpenClawIDStatement.fingerprint(approver)
                    else { continue }
                    accepted = (current, approverFingerprint)
                    await onCode(current.code)
                    try await self.discovery.send(
                        session, device: keys.device, clawID: claw.id, to: approverFingerprint, payload: .object([
                            "kind": .string("enrollment"),
                            "request_id": .string(attempt.requestID),
                            "step": .string("key"),
                            "data": .object(["eph_pub": .string(attempt.ephemeralPublicHex)]),
                        ]))
                case "sealed" where accepted != nil && sealed == nil:
                    guard let nonce = mail.data["nonce"], let ciphertext = mail.data["ciphertext"] else { continue }
                    sealed = (nonce, ciphertext)
                default: continue
                }
            }
        }
        throw OpenClawIDOwnerEnrollmentError.expired
    }

    private func abort(
        _ attempt: OpenClawIDSASNewDevice,
        to approver: String,
        session: OpenClawIDDiscoverySession,
        claw: OpenClawIDDiscoveryClaw,
        keys: OpenClawIDOwnerDeviceKeys) async throws
    {
        try await self.discovery.send(
            session, device: keys.device, clawID: claw.id, to: approver, payload: .object([
                "kind": .string("enrollment"),
                "request_id": .string(attempt.requestID),
                "step": .string("abort"),
                "data": .object(["reason": .string("sas_mismatch")]),
            ]))
    }

    /// Recovery-kit enrollment (enrollment.md, "Kit enrollment"). R is derived here, signs this
    /// device's certificate and `add_owner_device` (and their re-sign after a `seq_conflict`
    /// notice), and is dropped when this call returns: admitted, refused, cancelled or after two
    /// minutes. R is never stored, logged or sent; only R-signed statements leave the process.
    public func approveWithRecoveryKit(
        _ kitText: String,
        session: OpenClawIDDiscoverySession,
        claw: OpenClawIDDiscoveryClaw,
        keys: OpenClawIDOwnerDeviceKeys,
        label: String,
        node: OpenClawIDNodeEnrollmentDescription?) async throws -> OpenClawIDOwnerEnrolled
    {
        let root: OpenClawIDNodeIdentity
        do { root = try OpenClawIDRecoveryKit.root(kitText) } catch { throw OpenClawIDOwnerEnrollmentError.kitInvalid }
        let rootFingerprint = try OpenClawIDStatement.fingerprint(root.signingKey)
        let deadline = self.now() + 120
        var seq: Int64
        do {
            seq = try await self.snapshotSequence(session: session, claw: claw, rootFingerprint: rootFingerprint)
        } catch OpenClawIDNodeEnrollmentError.rootMismatch {
            throw OpenClawIDOwnerEnrollmentError.wrongKit
        }
        try await self.discovery.bindDevice(session, device: keys.device, peer: keys.peer, label: label)
        let cert = try OpenClawIDStatement.sign("OwnerDeviceCert", body: .object([
            "device_pub": .string(keys.device.signingKey),
            "peer_keys": .array([.string(keys.peer.peerKey)]),
            "label": .string(label),
            "scope": .string("owner"),
            "caps": .array(Self.ownerCapabilities.map { .string($0) }),
            "issued_at": .integer(self.now()),
            "expires_at": .null,
            "root_epoch": .integer(1),
        ]), signer: root)
        let ownFingerprint = try OpenClawIDStatement.fingerprint(keys.device.signingKey)
        try await self.sendRootChange(
            cert: cert,
            seq: seq + 1,
            root: root,
            session: session,
            claw: claw,
            keys: keys,
            label: label,
            node: node)
        var signedSeq = seq + 1
        var retries = 0
        var pendingRef: Int64?
        var cursor: String?
        var seen = Set<String>()
        while self.now() < deadline {
            if let enrolled = try await self.admitted(
                session: session,
                claw: claw,
                rootFingerprint: rootFingerprint,
                keys: keys)
            {
                return enrolled
            }
            let (messages, next) = try await self.discovery.receive(
                session, device: keys.device, clawID: claw.id, after: cursor, wait: pendingRef == nil ? 5 : 1)
            cursor = next ?? cursor
            for mail in messages where seen.insert(mail.id).inserted {
                guard mail.kind == "notice", mail.event == "seq_conflict", mail.to == ownFingerprint,
                      let text = mail.ref, OpenClawIDNodeEnrollmentLink.matches(text, "^(0|[1-9][0-9]{0,14})$"),
                      let ref = Int64(text), ref >= signedSeq else { continue }
                pendingRef = max(pendingRef ?? ref, ref)
            }
            // Re-sign at Discovery's verified snapshot seq + 1 once it has caught up with the notice.
            guard let ref = pendingRef else { continue }
            guard retries < 3 else { throw OpenClawIDOwnerEnrollmentError.expired }
            seq = try await self.snapshotSequence(session: session, claw: claw, rootFingerprint: rootFingerprint)
            guard seq >= ref else { continue }
            // The two-minute bound holds across the awaits above: never sign with R after it.
            guard self.now() < deadline else { throw OpenClawIDOwnerEnrollmentError.expired }
            try await self.sendRootChange(
                cert: cert,
                seq: seq + 1,
                root: root,
                session: session,
                claw: claw,
                keys: keys,
                label: label,
                node: node)
            signedSeq = seq + 1
            retries += 1
            pendingRef = nil
        }
        throw OpenClawIDOwnerEnrollmentError.expired
    }

    private func sendRootChange(
        cert: OpenClawIDCanonicalJSON,
        seq: Int64,
        root: OpenClawIDNodeIdentity,
        session: OpenClawIDDiscoverySession,
        claw: OpenClawIDDiscoveryClaw,
        keys: OpenClawIDOwnerDeviceKeys,
        label: String,
        node: OpenClawIDNodeEnrollmentDescription?) async throws
    {
        let change = try OpenClawIDStatement.sign("MembershipChange", body: Self.addOwnerDevice(
            clawID: claw.id, seq: seq, cert: cert, nodeKey: keys.node, label: label, node: node,
            issuedAt: self.now()), signer: root)
        try await self.discovery.send(
            session, device: keys.device, clawID: claw.id, to: "gateway", payload: .object([
                "kind": .string("root_statement"),
                "statements": .array([change]),
            ]))
    }

    static func addOwnerDevice(
        clawID: String,
        seq: Int64,
        cert: OpenClawIDCanonicalJSON,
        nodeKey: OpenClawIDNodeIdentity?,
        label: String,
        node: OpenClawIDNodeEnrollmentDescription?,
        issuedAt: Int64) -> OpenClawIDCanonicalJSON
    {
        var target: [String: OpenClawIDCanonicalJSON] = ["op": .string("add_owner_device"), "cert": cert]
        if let nodeKey, let node {
            target["node"] = .object([
                "peer_key": .string(nodeKey.peerKey),
                "label": .string(label),
                "description": node.json,
            ])
        }
        return .object([
            "claw_id": .string(clawID),
            "seq": .integer(seq),
            "target": .object(target),
            "issued_at": .integer(issuedAt),
        ])
    }

    static func sasStart(
        requestID: String,
        clawID: String,
        keys: OpenClawIDOwnerDeviceKeys,
        label: String,
        node: OpenClawIDNodeEnrollmentDescription?) -> OpenClawIDCanonicalJSON
    {
        var fields: [String: OpenClawIDCanonicalJSON] = [
            "request_id": .string(requestID),
            "claw_id": .string(clawID),
            "device_pub": .string(keys.device.signingKey),
            "peer_key": .string(keys.peer.peerKey),
            "label": .string(label),
        ]
        if let nodeKey = keys.node, let node {
            fields["node"] = .object(["peer_key": .string(nodeKey.peerKey), "description": node.json])
        }
        return .object(fields)
    }

    /// The handoff's binding verifies under the root it names, for this claw and hostname, and its
    /// certificate is for this device's D and W. Returns fp(R), the pin.
    static func verifyHandoff(
        _ handoff: OpenClawIDCanonicalJSON,
        claw: OpenClawIDDiscoveryClaw,
        keys: OpenClawIDOwnerDeviceKeys) throws -> String
    {
        do {
            let fields = try handoff.fields(["root_pub", "binding", "cert"])
            let root = try fields["root_pub"]!.text()
            let binding = try OpenClawIDNodeTrust.envelope(fields["binding"]!, type: "ServerBinding", signer: root)
                .fields(["claw_id", "hostname", "k_srv", "k_gw", "binding_seq", "root_epoch", "issued_at"])
            let cert = try fields["cert"]!.fields(["v", "type", "body", "signer", "alg", "sig"])["body"]!
                .fields(["device_pub", "peer_keys", "label", "scope", "caps", "issued_at", "expires_at", "root_epoch"])
            guard try binding["claw_id"]!.text() == claw.id, try binding["hostname"]!.text() == claw.hostname,
                  try cert["device_pub"]!.text() == keys.device.signingKey,
                  try cert["peer_keys"]!.list() == [.string(keys.peer.peerKey)]
            else { throw OpenClawIDOwnerEnrollmentError.handoffInvalid }
            return try OpenClawIDStatement.fingerprint(root)
        } catch is OpenClawIDNodeEnrollmentError {
            throw OpenClawIDOwnerEnrollmentError.handoffInvalid
        }
    }

    private func snapshotSequence(
        session: OpenClawIDDiscoverySession,
        claw: OpenClawIDDiscoveryClaw,
        rootFingerprint: String) async throws -> Int64
    {
        let response = try await self.discovery.descriptorAndSnapshot(session, clawID: claw.id)
        return try await OpenClawIDNodeTrust.verifiedSnapshotSequence(
            response: response, hostname: claw.hostname, clawID: claw.id, rootFingerprint: rootFingerprint,
            discoveryOrigin: self.discovery.origin, previous: self.deviceStore.load(hostname: claw.hostname),
            now: self.now())
    }

    /// Waits until the claw's snapshot lists W as an owner peer key (Discovery may lag the Gateway).
    private func awaitAdmission(
        session: OpenClawIDDiscoverySession,
        claw: OpenClawIDDiscoveryClaw,
        rootFingerprint: String,
        keys: OpenClawIDOwnerDeviceKeys,
        until deadline: Int64) async throws -> OpenClawIDOwnerEnrolled
    {
        while self.now() < deadline {
            if let enrolled = try await self.admitted(
                session: session,
                claw: claw,
                rootFingerprint: rootFingerprint,
                keys: keys)
            {
                return enrolled
            }
            try await self.sleep(3_000_000_000)
        }
        throw OpenClawIDOwnerEnrollmentError.expired
    }

    /// Verifies and persists W's (and W_node's) admission; nil while the snapshot does not list W yet.
    private func admitted(
        session: OpenClawIDDiscoverySession,
        claw: OpenClawIDDiscoveryClaw,
        rootFingerprint: String,
        keys: OpenClawIDOwnerDeviceKeys) async throws -> OpenClawIDOwnerEnrolled?
    {
        let response = try await self.discovery.descriptorAndSnapshot(session, clawID: claw.id)
        let device = try await OpenClawIDNodeTrust.assessDevice(
            response: response, hostname: claw.hostname, clawID: claw.id, rootFingerprint: rootFingerprint,
            discoveryOrigin: self.discovery.origin, peerKey: keys.peer.peerKey, admission: .owner,
            previous: self.deviceStore.load(hostname: claw.hostname), now: self.now())
        if let observation = device.observation {
            try await self.deviceStore.observe(hostname: claw.hostname, state: observation)
        }
        switch device.verdict {
        case .failure(.notAdmitted), .failure(.staleSnapshot): return nil
        case let .failure(error): throw error
        case let .success(target):
            if let nodeStore, let node = keys.node {
                let nodeTarget = try OpenClawIDNodeTrust.assessDevice(
                    response: response, hostname: claw.hostname, clawID: claw.id, rootFingerprint: rootFingerprint,
                    discoveryOrigin: self.discovery.origin, peerKey: node.peerKey, admission: .node,
                    previous: target.state, now: self.now())
                guard case let .success(listed) = nodeTarget.verdict else { return nil }
                try await nodeStore.commit(listed)
            }
            try await self.deviceStore.commit(target)
            return .init(hostname: claw.hostname, clawID: claw.id, rootFingerprint: rootFingerprint)
        }
    }

    private static func random(_ count: Int) -> Data {
        var bytes = Data(count: count)
        _ = bytes.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, count, $0.baseAddress!) }
        return bytes
    }
}
