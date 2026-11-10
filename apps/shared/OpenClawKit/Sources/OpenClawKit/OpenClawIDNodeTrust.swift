import CryptoKit
import Foundation

/// Public high-water facts retained by the application's existing native state owner.
/// `bindingSequence` is the pin: the highest R-signed binding verified. The snapshot order is kept
/// per K_gw (`snapshotGatewayKey`), and `snapshotBindingSequence` is only ever a verified binding's
/// seq (J5). A state without a key was stored before per-key order; load it through `clampedLegacy`.
public struct OpenClawIDNodeTrustState: Codable, Sendable, Equatable {
    public let clawID: String
    public let rootFingerprint: String
    public let bindingSequence: Int64
    public let snapshotSequence: Int64
    public let snapshotIssuedAt: Int64
    public let snapshotBindingSequence: Int64
    public let snapshotGatewayKey: String?

    /// Restores public state; verification rechecks scope and refuses any rollback.
    public init(
        clawID: String,
        rootFingerprint: String,
        bindingSequence: Int64,
        snapshotSequence: Int64,
        snapshotIssuedAt: Int64,
        snapshotBindingSequence: Int64,
        snapshotGatewayKey: String? = nil)
    {
        self.clawID = clawID
        self.rootFingerprint = rootFingerprint
        self.bindingSequence = bindingSequence
        self.snapshotSequence = snapshotSequence
        self.snapshotIssuedAt = snapshotIssuedAt
        self.snapshotBindingSequence = snapshotBindingSequence
        self.snapshotGatewayKey = snapshotGatewayKey
    }

    /// A keyless state's snapshot binding_seq may be a K_gw-signed claim, so it is capped at the pin,
    /// and its order cannot be attributed to a key, so it is dropped. Kept, a retired key's inflated
    /// order would refuse the replacement key for good. Accepted edge case: right after loading,
    /// older snapshots of the current key are not refused as replays until a newer one is stored.
    public func clampedLegacy() -> Self {
        guard self.snapshotGatewayKey == nil else { return self }
        return .init(
            clawID: self.clawID,
            rootFingerprint: self.rootFingerprint,
            bindingSequence: self.bindingSequence,
            snapshotSequence: 0,
            snapshotIssuedAt: 0,
            snapshotBindingSequence: min(self.snapshotBindingSequence, self.bindingSequence))
    }

    /// Whether this state orders snapshots of `gatewayKey` (a keyless legacy state counts as any key's).
    func orders(_ gatewayKey: String?) -> Bool {
        (self.snapshotGatewayKey ?? gatewayKey) == gatewayKey
    }
}

/// Adapter to the existing app state owner, not a parallel database or sidecar.
public protocol OpenClawIDNodeTrustStore: Sendable {
    func load(hostname: String) async throws -> OpenClawIDNodeTrustState?
    /// Merge verified facts with the CURRENT row using mergeObservation, without installing a route.
    /// Check cancellation/replaced attempt authority at this effect; persist before returning.
    func observe(hostname: String, state: OpenClawIDNodeTrustState) async throws
    /// Atomically refuse scope changes/rollback against the CURRENT row, then persist before returning.
    /// Cancellation/replaced attempt authority must be checked by the app owner at this effect.
    func commit(_ target: OpenClawIDNodeTrustTarget) async throws
}

/// Verified node-only dialing facts; construction is restricted to the verifier.
public struct OpenClawIDNodeTrustTarget: Sendable {
    public let hostname: String
    public let discoveryOrigin: URL
    public let relayURL: URL
    public let serverKey: String
    public let peerKey: String
    public let state: OpenClawIDNodeTrustState
    public let evidence: Data
}

/// Verified observations survive a refused dialing verdict. Persist observation before using verdict.
public struct OpenClawIDNodeTrustAssessment: Sendable {
    public let observation: OpenClawIDNodeTrustState?
    public let verdict: Result<OpenClawIDNodeTrustTarget, OpenClawIDNodeEnrollmentError>
}

/// Strict schema, signature, pin and snapshot verification for the node descriptor response.
public enum OpenClawIDNodeTrust {
    /// Separates verified nonfuture high-water facts from permission to install a dialable target.
    /// A verified binding remains pinned even when its snapshot is invalid or future-dated.
    public static func assess(
        response: Data,
        link: OpenClawIDNodeEnrollmentLink,
        discoveryOrigin: URL,
        peerKey: String,
        previous: OpenClawIDNodeTrustState?,
        now: Int64) throws
        -> OpenClawIDNodeTrustAssessment
    {
        try self.assess(
            response: response,
            hostname: link.hostname,
            clawID: link.clawID,
            rootFingerprint: link.rootFingerprint,
            discoveryOrigin: discoveryOrigin,
            peerKey: peerKey,
            previous: previous,
            now: now)
    }

    /// A restart refresh is pinned to retained authority, not an invite or stored response.
    public static func assessRefresh(
        response: Data,
        hostname: String,
        discoveryOrigin: URL,
        peerKey: String,
        previous: OpenClawIDNodeTrustState,
        now: Int64) throws
        -> OpenClawIDNodeTrustAssessment
    {
        try self.assess(
            response: response,
            hostname: hostname,
            clawID: previous.clawID,
            rootFingerprint: previous.rootFingerprint,
            discoveryOrigin: discoveryOrigin,
            peerKey: peerKey,
            previous: previous,
            now: now)
    }

    private static func assess(
        response: Data,
        hostname expectedHostname: String,
        clawID: String,
        rootFingerprint: String,
        discoveryOrigin: URL,
        peerKey: String,
        previous: OpenClawIDNodeTrustState?,
        now: Int64) throws -> OpenClawIDNodeTrustAssessment
    {
        guard now >= 0, now <= 9_007_199_254_740_991 else { throw OpenClawIDNodeEnrollmentError.malformed }
        let response = try OpenClawIDCanonicalJSON.parse(response).fields(["descriptor", "snapshot"])
        let descriptor = try response["descriptor"]!.fields([
            "v", "claw_id", "transport", "relay_url", "root_pub", "binding", "published_at",
        ], optional: ["reset"])
        try self.version(descriptor["v"]!)
        guard try descriptor["transport"]!.text() == "iroh" else { throw OpenClawIDNodeEnrollmentError.malformed }
        if let reset = descriptor["reset"] { try self.validateReset(reset) }
        let claw = try identifier(descriptor["claw_id"]!)
        guard claw == clawID else { throw OpenClawIDNodeEnrollmentError.wrongClaw }
        let root = try key(descriptor["root_pub"]!, prefix: "ed25519:")
        let rootBytes = try OpenClawIDNodeIdentity.unhex(root, prefix: "ed25519:")
        guard "fp:" + OpenClawIDNodeIdentity.hex(SHA256.hash(data: rootBytes)) == rootFingerprint else {
            throw OpenClawIDNodeEnrollmentError.rootMismatch
        }
        let relay = try OpenClawIDNodeEnrollmentLink.routingURL(descriptor["relay_url"]!.text(), originOnly: false)
        _ = try descriptor["published_at"]!.number()
        let binding = try envelope(descriptor["binding"]!, type: "ServerBinding", signer: root)
        let body = try binding.fields([
            "claw_id",
            "hostname",
            "k_srv",
            "k_gw",
            "binding_seq",
            "root_epoch",
            "issued_at",
        ])
        guard try self.identifier(body["claw_id"]!) == claw else { throw OpenClawIDNodeEnrollmentError.wrongClaw }
        let hostname = try body["hostname"]!.text()
        guard OpenClawIDNodeEnrollmentLink.validHostname(hostname), hostname == expectedHostname else {
            throw OpenClawIDNodeEnrollmentError.wrongHost
        }
        let server = try key(body["k_srv"]!, prefix: "iroh:")
        let gateway = try key(body["k_gw"]!, prefix: "ed25519:")
        let bindingSequence = try body["binding_seq"]!.number(minimum: 1)
        guard try body["root_epoch"]!.number() == 1 else { throw OpenClawIDNodeEnrollmentError.malformed }
        _ = try body["issued_at"]!.number()
        // Match the canonical pin boundary before considering snapshot evidence.
        if let previous {
            guard previous.clawID == claw, previous.rootFingerprint == rootFingerprint else {
                throw OpenClawIDNodeEnrollmentError.rootMismatch
            }
            guard bindingSequence >= previous.bindingSequence else { throw OpenClawIDNodeEnrollmentError.rollback }
        }
        let pinned = OpenClawIDNodeTrustState(
            clawID: claw,
            rootFingerprint: rootFingerprint,
            bindingSequence: bindingSequence,
            snapshotSequence: previous?.snapshotSequence ?? 0,
            snapshotIssuedAt: previous?.snapshotIssuedAt ?? 0,
            snapshotBindingSequence: previous?
                .snapshotBindingSequence ?? bindingSequence,
            snapshotGatewayKey: previous?.snapshotGatewayKey)
        do {
            let snapshot = try envelope(response["snapshot"]!, type: "MembershipSnapshot", signer: gateway)
            let fields = try validateSnapshot(snapshot)
            guard try self.identifier(fields["claw_id"]!) == claw else { throw OpenClawIDNodeEnrollmentError.wrongClaw }
            let sequence = try fields["seq"]!.number()
            let issued = try fields["issued_at"]!.number()
            let snapshotBinding = try fields["binding_seq"]!.number(minimum: 1)
            if snapshotBinding > bindingSequence {
                return .init(observation: pinned, verdict: .failure(.rollback))
            }
            let candidate = OpenClawIDNodeTrustState(
                clawID: claw,
                rootFingerprint: rootFingerprint,
                bindingSequence: bindingSequence,
                snapshotSequence: sequence,
                snapshotIssuedAt: issued,
                snapshotBindingSequence: bindingSequence,
                snapshotGatewayKey: gateway)
            // Future evidence may refuse a dial, but must never poison durable high-water state.
            let observation = issued <= now + 300 ? try self.mergeObservation(candidate, with: previous) : pinned
            let refusal: OpenClawIDNodeEnrollmentError? = if (previous?.snapshotBindingSequence ?? 0) >
                bindingSequence
            {
                .rollback
            } else if issued > now + 300 || issued < now - 10800 {
                .staleSnapshot
            } else if let previous, previous.orders(gateway), olderSnapshot(candidate, than: previous) {
                .rollback
            } else if snapshotBinding < bindingSequence {
                .rollback
            } else if try !self.strings(fields["node_peer_keys"]!, prefix: "iroh:").contains(peerKey) {
                .notAdmitted
            } else {
                nil
            }
            if let refusal {
                return .init(observation: observation, verdict: .failure(refusal))
            }
            let target = OpenClawIDNodeTrustTarget(
                hostname: hostname,
                discoveryOrigin: discoveryOrigin,
                relayURL: relay,
                serverKey: server,
                peerKey: peerKey,
                state: observation ?? candidate,
                evidence: OpenClawIDCanonicalJSON.object(response).encoded)
            return .init(observation: observation, verdict: .success(target))
        } catch let error as OpenClawIDNodeEnrollmentError {
            return .init(observation: pinned, verdict: .failure(error))
        }
    }

    /// Merges an observation inside the state owner's transaction: pin never decreases. Snapshot order
    /// is per K_gw: for the same key the newest by seq then issued_at wins (including a refused/stale
    /// observation); a new key's order replaces it only under a newer verified binding (a re-bind).
    /// Binding retirement is an independent high-water fact, never erased by newer membership.
    public static func mergeObservation(
        _ candidate: OpenClawIDNodeTrustState,
        with current: OpenClawIDNodeTrustState?) throws -> OpenClawIDNodeTrustState
    {
        guard let current else { return candidate }
        guard candidate.clawID == current.clawID, candidate.rootFingerprint == current.rootFingerprint else {
            throw OpenClawIDNodeEnrollmentError.rootMismatch
        }
        let sameKey = current.orders(candidate.snapshotGatewayKey)
        let newest = sameKey
            ? (olderSnapshot(current, than: candidate) ? candidate : current)
            : (candidate.snapshotBindingSequence > current.snapshotBindingSequence ? candidate : current)
        return .init(
            clawID: candidate.clawID,
            rootFingerprint: candidate.rootFingerprint,
            bindingSequence: max(candidate.bindingSequence, current.bindingSequence),
            snapshotSequence: newest.snapshotSequence,
            snapshotIssuedAt: newest.snapshotIssuedAt,
            snapshotBindingSequence: max(candidate.snapshotBindingSequence, current.snapshotBindingSequence),
            snapshotGatewayKey: sameKey ? (candidate.snapshotGatewayKey ?? current.snapshotGatewayKey)
                : newest.snapshotGatewayKey)
    }

    private static func olderSnapshot(
        _ candidate: OpenClawIDNodeTrustState,
        than current: OpenClawIDNodeTrustState) -> Bool
    {
        candidate.snapshotSequence < current.snapshotSequence ||
            (candidate.snapshotSequence == current.snapshotSequence && candidate.snapshotIssuedAt < current
                .snapshotIssuedAt)
    }

    /// Refuses a stale commit against the current row inside the existing state owner's transaction.
    public static func validateCommit(
        _ candidate: OpenClawIDNodeTrustState,
        replacing current: OpenClawIDNodeTrustState?) throws
    {
        guard let current else { return }
        guard candidate.clawID == current.clawID, candidate.rootFingerprint == current.rootFingerprint else {
            throw OpenClawIDNodeEnrollmentError.rootMismatch
        }
        let ordered = current.orders(candidate.snapshotGatewayKey)
            ? !self.olderSnapshot(candidate, than: current)
            : candidate.snapshotBindingSequence > current.snapshotBindingSequence
        guard candidate.bindingSequence >= current.bindingSequence,
              candidate.bindingSequence >= current.snapshotBindingSequence, ordered
        else { throw OpenClawIDNodeEnrollmentError.rollback }
    }

    /// Envelope signatures cover the canonical body, not the outer routing metadata.
    static func envelope(
        _ value: OpenClawIDCanonicalJSON,
        type: String,
        signer: String) throws -> OpenClawIDCanonicalJSON
    {
        let fields = try value.fields(["v", "type", "body", "signer", "alg", "sig"])
        try self.version(fields["v"]!)
        guard try fields["type"]!.text() == type, try fields["alg"]!.text() == "ed25519",
              try self.key(fields["signer"]!, prefix: "ed25519:") == signer
        else { throw OpenClawIDNodeEnrollmentError.badSignature }
        let signature = try OpenClawIDNodeIdentity.decodeBase64URL(fields["sig"]!.text(), count: 64)
        let publicKey = try Curve25519.Signing.PublicKey(rawRepresentation:
            OpenClawIDNodeIdentity.unhex(signer, prefix: "ed25519:"))
        let body = fields["body"]!
        guard publicKey.isValidSignature(signature, for: Data("openclaw/\(type)/v1\0".utf8) + body.encoded) else {
            throw OpenClawIDNodeEnrollmentError.badSignature
        }
        return body
    }

    private static func validateSnapshot(_ value: OpenClawIDCanonicalJSON) throws -> [String: OpenClawIDCanonicalJSON] {
        let fields = try value.fields([
            "claw_id",
            "seq",
            "binding_seq",
            "owner_devices",
            "owner_peer_keys",
            "node_peer_keys",
            "members",
            "protocols",
            "issued_at",
        ])
        let capabilities = ["approve_device", "bind", "invite", "manage_members"]
        for item in try fields["owner_devices"]!.list() {
            let owner = try item.fields(["device_pub", "caps"])
            _ = try self.key(owner["device_pub"]!, prefix: "ed25519:")
            let caps = try strings(owner["caps"]!)
            guard caps.allSatisfy(capabilities.contains) else { throw OpenClawIDNodeEnrollmentError.malformed }
        }
        _ = try self.strings(fields["owner_peer_keys"]!, prefix: "iroh:")
        _ = try self.strings(fields["node_peer_keys"]!, prefix: "iroh:")
        for item in try fields["members"]!.list() {
            let member = try item.fields(["account_id", "role", "peer_keys"])
            let account = try member["account_id"]!.text()
            guard !account.isEmpty, account.utf16.count <= 256,
                  try ["operator", "viewer"].contains(member["role"]!.text())
            else { throw OpenClawIDNodeEnrollmentError.malformed }
            _ = try self.strings(member["peer_keys"]!, prefix: "iroh:")
        }
        let protocols = try fields["protocols"]!.fields(["statement", "descriptor"])
        for value in protocols.values {
            let versions = try value.list().map { try $0.number(minimum: 1) }
            guard !versions.isEmpty, zip(versions, versions.dropFirst()).allSatisfy({ pair in pair.0 < pair.1 }) else {
                throw OpenClawIDNodeEnrollmentError.malformed
            }
        }
        return fields
    }

    /// Match parseClawDescriptor's reset schema only. Reset metadata never authorizes a pin change;
    /// dialing still requires the descriptor root to match the invitation or retained fingerprint.
    private static func validateReset(_ value: OpenClawIDCanonicalJSON) throws {
        let reset = try value.fields(["previous_root_pub", "previous_binding", "statement"])
        _ = try self.key(reset["previous_root_pub"]!, prefix: "ed25519:")
        let previous = try resetStatementBody(reset["previous_binding"]!, type: "ServerBinding").fields([
            "claw_id", "hostname", "k_srv", "k_gw", "binding_seq", "root_epoch", "issued_at",
        ])
        _ = try self.identifier(previous["claw_id"]!)
        guard try OpenClawIDNodeEnrollmentLink.validHostname(previous["hostname"]!.text()),
              try previous["root_epoch"]!.number() == 1 else { throw OpenClawIDNodeEnrollmentError.malformed }
        _ = try self.key(previous["k_srv"]!, prefix: "iroh:")
        _ = try self.key(previous["k_gw"]!, prefix: "ed25519:")
        _ = try previous["binding_seq"]!.number(minimum: 1)
        _ = try previous["issued_at"]!.number()
        let statement = try resetStatementBody(reset["statement"]!, type: "RootReset").fields([
            "claw_id", "new_root_pub", "binding_seq", "issued_at",
        ])
        _ = try self.identifier(statement["claw_id"]!)
        _ = try self.key(statement["new_root_pub"]!, prefix: "ed25519:")
        _ = try statement["binding_seq"]!.number(minimum: 1)
        _ = try statement["issued_at"]!.number()
    }

    private static func resetStatementBody(
        _ value: OpenClawIDCanonicalJSON,
        type: String) throws -> OpenClawIDCanonicalJSON
    {
        let fields = try value.fields(["v", "type", "body", "signer", "alg", "sig"])
        try self.version(fields["v"]!)
        guard try fields["type"]!.text() == type, try fields["alg"]!.text() == "ed25519",
              try OpenClawIDNodeEnrollmentLink.matches(fields["sig"]!.text(), "^[A-Za-z0-9_-]{86}$")
        else { throw OpenClawIDNodeEnrollmentError.malformed }
        _ = try self.key(fields["signer"]!, prefix: "ed25519:")
        return fields["body"]!
    }

    private static func version(_ value: OpenClawIDCanonicalJSON) throws {
        guard try value.number(minimum: 1) == 1 else { throw OpenClawIDNodeEnrollmentError.unsupportedVersion }
    }

    private static func identifier(_ value: OpenClawIDCanonicalJSON) throws -> String {
        let text = try value.text()
        guard OpenClawIDNodeEnrollmentLink.matches(text, "^[0-9a-f]{32}$") else {
            throw OpenClawIDNodeEnrollmentError.malformed
        }
        return text
    }

    private static func key(_ value: OpenClawIDCanonicalJSON, prefix: String) throws -> String {
        let text = try value.text()
        _ = try OpenClawIDNodeIdentity.unhex(text, prefix: prefix)
        return text
    }

    private static func strings(_ value: OpenClawIDCanonicalJSON, prefix: String? = nil) throws -> [String] {
        let items = try value.list().map { try $0.text() }
        guard Set(items.map { Data($0.utf8) }).count == items.count
        else { throw OpenClawIDNodeEnrollmentError.malformed }
        if let prefix { for item in items {
            _ = try OpenClawIDNodeIdentity.unhex(item, prefix: prefix)
        } }
        return items
    }
}
