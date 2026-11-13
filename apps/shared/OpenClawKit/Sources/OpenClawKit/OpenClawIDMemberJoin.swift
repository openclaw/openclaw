import CryptoKit
import Foundation

/// An owner's member invite link, `https://<claw>/join#i=<invite_id>.<secret>&r=<fp(R) hex>`
/// (invites.ts). The secret is transient: it is never Codable, logged or shown, and it is erased
/// once the redemption proof is computed.
public struct OpenClawIDInviteLink: Sendable {
    public let hostname: String
    public let inviteID: String
    /// fp(R) of the claw's owner root: the pin the joined device is verified against.
    public let rootFingerprint: String
    private var secret: Data

    /// Parses an invite link as the Control UI builds it. Fragment fields other than `i` and `r`
    /// are ignored, as the reference parser does; a repeated `i` or `r` is refused.
    public init(_ text: String) throws {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.utf16.count <= 2048, let url = URLComponents(string: text), url.scheme == "https",
              let host = url.host?.lowercased(), url.user == nil, url.password == nil, url.path == "/join",
              url.query == nil, let fragment = url.percentEncodedFragment
        else { throw OpenClawIDNodeEnrollmentError.invalidLink }
        let hostname = url.port.map { "\(host):\($0)" } ?? host
        var fields: [String: String] = [:]
        for pair in fragment.split(separator: "&") {
            let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard parts.count == 2,
                  let key = String(parts[0]).replacingOccurrences(of: "+", with: " ").removingPercentEncoding,
                  let value = String(parts[1]).replacingOccurrences(of: "+", with: " ").removingPercentEncoding
            else { throw OpenClawIDNodeEnrollmentError.invalidLink }
            guard key == "i" || key == "r" else { continue }
            guard fields[key] == nil else { throw OpenClawIDNodeEnrollmentError.invalidLink }
            fields[key] = value
        }
        let invite = (fields["i"] ?? "").split(separator: ".", omittingEmptySubsequences: false)
        guard OpenClawIDNodeEnrollmentLink.validHostname(hostname), invite.count == 2,
              OpenClawIDNodeEnrollmentLink.matches(String(invite[0]), "^[0-9a-f]{32}$"),
              OpenClawIDNodeEnrollmentLink.matches(fields["r"] ?? "", "^[0-9a-f]{64}$")
        else { throw OpenClawIDNodeEnrollmentError.invalidLink }
        do {
            self.secret = try OpenClawIDNodeIdentity.decodeBase64URL(String(invite[1]), count: 32)
        } catch {
            throw OpenClawIDNodeEnrollmentError.invalidLink
        }
        self.hostname = hostname
        self.inviteID = String(invite[0])
        self.rootFingerprint = "fp:" + fields["r"]!
    }

    /// The invite proof key, HKDF(secret, "openclaw/invite/v1", "proof-key"). Erases the secret.
    mutating func consumeProofKey() -> SymmetricKey {
        defer {
            self.secret.resetBytes(in: 0..<self.secret.count)
            self.secret.removeAll(keepingCapacity: false)
        }
        return HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: self.secret),
            salt: Data("openclaw/invite/v1".utf8),
            info: Data("proof-key".utf8),
            outputByteCount: 32)
    }
}

/// A member device admitted with its invite's role.
public struct OpenClawIDMemberJoined: Sendable, Equatable {
    public let hostname: String
    public let clawID: String
    public let rootFingerprint: String
    public let role: String
}

/// Invite redemption for an app (owner-key spec section 6.3), the native counterpart of the
/// loader's join.ts: D self-signs an InviteRedemption for this account and W, Discovery carries it
/// to the claw's Gateway, and an owner approves it. Nothing here admits anything: the device joins
/// only once the claw's K_gw-signed snapshot lists W as a member, verified against fp(R) from the
/// link. Members get no node.
public struct OpenClawIDMemberJoinClient: Sendable {
    private let discovery: OpenClawIDDiscoveryAccount
    private let trustStore: any OpenClawIDNodeTrustStore
    private let now: @Sendable () -> Int64

    /// `trustStore` keeps the pin and W's restart inputs, as for an owner device.
    public init(
        discoveryOrigin: URL,
        trustStore: any OpenClawIDNodeTrustStore,
        http: any OpenClawIDNodeEnrollmentHTTP = OpenClawIDNodeEnrollmentURLSession(),
        now: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970) })
    {
        self.discovery = .init(origin: discoveryOrigin, http: http, now: now)
        self.trustStore = trustStore
        self.now = now
    }

    /// The claw id behind the link's hostname: from the account's claws when it already belongs to
    /// the claw, else from a Discovery join ticket, which an invitee may request. Unverified: the
    /// redemption proof covers it, and admission is verified against fp(R).
    public func clawID(hostname: String, session: OpenClawIDDiscoverySession) async throws -> String {
        if let claw = try await self.discovery.listClaws(session).first(where: { $0.hostname == hostname }) {
            return claw.id
        }
        do {
            return try await self.discovery.joinTicketClawID(session, hostname: hostname)
        } catch let refused as OpenClawIDDiscoveryAccountError where refused.status == 404 {
            throw OpenClawIDNodeEnrollmentError.wrongHost
        }
    }

    /// Binds D and W to the account, then mails the InviteRedemption to the claw's Gateway, where
    /// it waits for an owner. `label` names this device to the owner and in the member's devices.
    /// Consumes the link's secret.
    public func redeem(
        _ link: inout OpenClawIDInviteLink,
        clawID: String,
        session: OpenClawIDDiscoverySession,
        device: OpenClawIDNodeIdentity,
        peer: OpenClawIDNodeIdentity,
        label: String) async throws
    {
        let redemption = try Self.redemption(
            link: &link,
            clawID: clawID,
            accountID: session.accountID,
            device: device,
            peer: peer,
            label: label,
            now: self.now())
        try await self.discovery.bindDevice(session, device: device, peer: peer, label: label)
        try await self.discovery.send(
            session, device: device, clawID: clawID, to: "gateway", payload: .object([
                "kind": .string("invite_redemption"),
                "redemption": redemption,
            ]))
    }

    /// One check of a pending join: the member entry for W in the claw's verified snapshot, with
    /// its role, or nil while no owner has approved it. Persists the pin once W is listed.
    public func admitted(
        hostname: String,
        clawID: String,
        rootFingerprint: String,
        session: OpenClawIDDiscoverySession,
        peer: OpenClawIDNodeIdentity) async throws -> OpenClawIDMemberJoined?
    {
        // Discovery serves the claw's descriptor only once the account belongs to it.
        guard try await self.discovery.listClaws(session).contains(where: { $0.id == clawID }) else { return nil }
        let response = try await self.discovery.descriptorAndSnapshot(session, clawID: clawID)
        let assessment = try await OpenClawIDNodeTrust.assessDevice(
            response: response,
            hostname: hostname,
            pin: (clawID, rootFingerprint),
            discoveryOrigin: self.discovery.origin,
            listed: (peer.peerKey, .member),
            previous: self.trustStore.load(hostname: hostname),
            now: self.now())
        if let observation = assessment.observation {
            try await self.trustStore.observe(hostname: hostname, state: observation)
        }
        switch assessment.verdict {
        case .failure(.notAdmitted), .failure(.staleSnapshot): return nil
        case let .failure(error): throw error
        case let .success(target):
            let role = try Self.role(of: peer.peerKey, in: response)
            try await self.trustStore.commit(target)
            return .init(hostname: hostname, clawID: clawID, rootFingerprint: rootFingerprint, role: role)
        }
    }

    /// InviteRedemption signed by D, with proof = hex HMAC-SHA-256(proof key,
    /// "openclaw/invite-proof/v1\0" || JCS({claw_id, invite_id, account_id, device_pub, peer_key})).
    /// The label is signed but not part of the proof.
    static func redemption(
        link: inout OpenClawIDInviteLink,
        clawID: String,
        accountID: String,
        device: OpenClawIDNodeIdentity,
        peer: OpenClawIDNodeIdentity,
        label: String,
        now: Int64) throws -> OpenClawIDCanonicalJSON
    {
        let parts: [String: OpenClawIDCanonicalJSON] = [
            "claw_id": .string(clawID),
            "invite_id": .string(link.inviteID),
            "account_id": .string(accountID),
            "device_pub": .string(device.signingKey),
            "peer_key": .string(peer.peerKey),
        ]
        let proof = HMAC<SHA256>.authenticationCode(
            for: Data("openclaw/invite-proof/v1\0".utf8) + OpenClawIDCanonicalJSON.object(parts).encoded,
            using: link.consumeProofKey())
        var body = parts
        body["label"] = .string(label)
        body["proof"] = .string(OpenClawIDNodeIdentity.hex(proof))
        body["requested_at"] = .integer(now)
        return try OpenClawIDStatement.sign("InviteRedemption", body: .object(body), signer: device)
    }

    /// The role of the member listing `peerKey` in an already verified snapshot response.
    private static func role(of peerKey: String, in response: Data) throws -> String {
        let snapshot = try OpenClawIDCanonicalJSON.parse(response).fields(["descriptor", "snapshot"])["snapshot"]!
        guard case let .object(envelope) = snapshot, case let .object(body)? = envelope["body"],
              let members = try body["members"]?.list()
        else { throw OpenClawIDNodeEnrollmentError.malformed }
        for member in members {
            let fields = try member.fields(["account_id", "role", "peer_keys"])
            if try fields["peer_keys"]!.list().contains(.string(peerKey)) { return try fields["role"]!.text() }
        }
        throw OpenClawIDNodeEnrollmentError.notAdmitted
    }
}
