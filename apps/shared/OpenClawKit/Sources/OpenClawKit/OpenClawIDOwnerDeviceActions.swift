import Foundation

/// An owner device's own membership writes, signed with D and sent directly to the Gateway's
/// tunnel API (`/_openclaw-id/v1/`) over the device's admitted connection, never through Discovery.
public struct OpenClawIDOwnerDeviceActions: Sendable {
    private let tunnel: OpenClawIDNodeTunnel
    private let hostname: String
    private let device: OpenClawIDNodeIdentity
    private let now: @Sendable () -> Int64

    public init(
        tunnel: OpenClawIDNodeTunnel,
        hostname: String,
        device: OpenClawIDNodeIdentity,
        now: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970) })
    {
        self.tunnel = tunnel
        self.hostname = hostname
        self.device = device
        self.now = now
    }

    /// "Stop using this Mac for tools": `remove_node` for this device's node only; the device stays.
    public func removeNode(peerKey: String) async throws {
        let view = try await self.membership()
        try await self.submit(OpenClawIDStatement.sign("MembershipChange", body: .object([
            "claw_id": .string(view.clawID),
            "seq": .integer(view.seq + 1),
            "target": .object(["op": .string("remove_node"), "peer_key": .string(peerKey)]),
            "issued_at": .integer(self.now()),
        ]), signer: self.device))
    }

    /// "Use this Mac for tools": re-adds this device with its own caps and a new node key. The
    /// Gateway allows a device to re-add itself without raising its capabilities.
    public func addNode(
        peer: String,
        node: OpenClawIDNodeIdentity,
        label: String,
        description: OpenClawIDNodeEnrollmentDescription) async throws
    {
        let view = try await self.membership()
        let cert = try OpenClawIDStatement.sign("OwnerDeviceCert", body: .object([
            "device_pub": .string(self.device.signingKey),
            "peer_keys": .array([.string(peer)]),
            "label": .string(label),
            "scope": .string("owner"),
            "caps": .array(view.ownCaps.map { .string($0) }),
            "issued_at": .integer(self.now()),
            "expires_at": .null,
            "root_epoch": .integer(1),
        ]), signer: self.device)
        try await self.submit(OpenClawIDStatement.sign(
            "MembershipChange",
            body: OpenClawIDOwnerEnrollmentClient
                .addOwnerDevice(
                    clawID: view.clawID, seq: view.seq + 1, cert: cert, nodeKey: node, label: label, node: description,
                    issuedAt: self.now()),
            signer: self.device))
    }

    /// "Remove this Mac": revokes this owner device, which also removes its node.
    public func removeDevice() async throws {
        let view = try await self.membership()
        try await self.submit(Self.revocation(
            clawID: view.clawID, seq: view.seq, device: self.device, issuedAt: self.now()))
    }

    static func revocation(clawID: String, seq: Int64, device: OpenClawIDNodeIdentity, issuedAt: Int64) throws
        -> OpenClawIDCanonicalJSON
    {
        try OpenClawIDStatement.sign("Revocation", body: .object([
            "claw_id": .string(clawID),
            "seq": .integer(seq),
            "target_fp": .string(OpenClawIDStatement.fingerprint(device.signingKey)),
            "target_kind": .string("owner_device"),
            "reason": .string("removed from this Mac"),
            "root_epoch": .integer(1),
            "issued_at": .integer(issuedAt),
        ]), signer: device)
    }

    private func membership() async throws -> (clawID: String, seq: Int64, ownCaps: [String]) {
        let (status, body) = try await self.request("GET", "membership", body: nil)
        guard status == 200, let view = try JSONSerialization.jsonObject(with: body) as? [String: Any],
              let clawID = view["claw_id"] as? String, let seq = (view["seq"] as? NSNumber)?.int64Value,
              let owners = view["owner_devices"] as? [[String: Any]]
        else { throw OpenClawIDOwnerDeviceActionError(status: status, code: Self.errorCode(body)) }
        let own = owners.first { owner in
            ((owner["cert"] as? [String: Any])?["body"] as? [String: Any])?["device_pub"] as? String ==
                self.device.signingKey
        }
        guard let caps = own?["caps"] as? [String] else {
            throw OpenClawIDOwnerDeviceActionError(status: 403, code: "not_owner")
        }
        return (clawID, seq, caps)
    }

    private func submit(_ statement: OpenClawIDCanonicalJSON) async throws {
        let (status, body) = try await self.request(
            "POST", "statements", body: OpenClawIDCanonicalJSON.object(["statement": statement]).encoded)
        guard status == 200 else {
            throw OpenClawIDOwnerDeviceActionError(status: status, code: Self.errorCode(body))
        }
    }

    private func request(_ method: String, _ name: String, body: Data?) async throws -> (Int, Data) {
        var headers = [["host", self.hostname], ["accept", "application/json"]]
        if let body {
            headers += [["content-type", "application/json"], ["content-length", String(body.count)]]
        }
        let stream = try await OpenClawIDNodeHTTPStream.open(
            tunnel: self.tunnel, method: method, path: "/_openclaw-id/v1/\(name)", headers: headers)
        do {
            if let body { try await stream.writeBody(body) }
            try await stream.finishBody()
            let status = try await stream.responseHead().status
            var response = Data()
            while let chunk = try await stream.nextBody() {
                response.append(chunk)
                guard response.count <= 1_048_576 else { throw OpenClawIDNodeEnrollmentError.responseTooLarge }
            }
            await stream.cancel()
            return (status, response)
        } catch {
            await stream.cancel()
            throw error
        }
    }

    private static func errorCode(_ data: Data) -> String? {
        ((try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? [String: Any])?["code"]
            as? String
    }
}

/// A refused tunnel API write: HTTP status and the authority's refusal code, never remote text.
public struct OpenClawIDOwnerDeviceActionError: Error, Sendable, Equatable {
    public let status: Int
    public let code: String?
}
