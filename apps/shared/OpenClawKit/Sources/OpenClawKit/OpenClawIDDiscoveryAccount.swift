import Foundation

/// A Discovery account session (`ds_…`) from an OpenClaw ID sign-in. It authenticates the person
/// to Discovery only (listing claws, binding devices, device mail); it never grants claw access.
public struct OpenClawIDDiscoverySession: Sendable, Equatable {
    public let token: String
    public let accountID: String
    public let email: String?
    public let expiresAt: Int64

    public init(token: String, accountID: String, email: String?, expiresAt: Int64) {
        self.token = token
        self.accountID = accountID
        self.email = email
        self.expiresAt = expiresAt
    }
}

/// One claw from `listClaws`, as Discovery reports it (not verified).
public struct OpenClawIDDiscoveryClaw: Sendable, Equatable, Identifiable {
    public let id: String
    public let hostname: String
    public let relationship: String
    public let role: String?
    public let online: Bool

    public init(id: String, hostname: String, relationship: String, role: String?, online: Bool) {
        self.id = id
        self.hostname = hostname
        self.relationship = relationship
        self.role = role
        self.online = online
    }
}

/// One device-mail message: the fields enrollment reads, with the payload's string fields.
struct OpenClawIDDeviceMail: Sendable {
    let id: String
    let to: String
    let kind: String
    let requestID: String?
    let step: String?
    let event: String?
    let ref: String?
    let data: [String: String]
}

/// User- and device-authenticated Discovery calls (discovery.md). Responses are untrusted:
/// enrollment verifies every signed statement it acts on.
public struct OpenClawIDDiscoveryAccount: Sendable {
    let origin: URL
    let http: any OpenClawIDNodeEnrollmentHTTP
    let now: @Sendable () -> Int64

    public init(
        origin: URL,
        http: any OpenClawIDNodeEnrollmentHTTP = OpenClawIDNodeEnrollmentURLSession(),
        now: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970) })
    {
        self.origin = origin
        self.http = http
        self.now = now
    }

    /// POST /v1/sessions: exchanges the OpenClaw ID token for an account session.
    public func createSession(idToken: String) async throws -> OpenClawIDDiscoverySession {
        struct Response: Decodable { let session: String
            let account_id: String
            let email: String?
            let expires_at: Int64
        }
        let data = try await self.call("POST", "/v1/sessions", body: Data("{}".utf8), bearer: idToken)
        let response = try Self.decode(Response.self, data)
        guard response.session.hasPrefix("ds_") else { throw OpenClawIDNodeEnrollmentError.malformed }
        return .init(
            token: response.session,
            accountID: response.account_id,
            email: response.email,
            expiresAt: response.expires_at)
    }

    public func listClaws(_ session: OpenClawIDDiscoverySession) async throws -> [OpenClawIDDiscoveryClaw] {
        struct Response: Decodable {
            struct Claw: Decodable { let claw_id: String
                let hostname: String
                let relationship: String
                let role: String?
                let online: Bool
            }

            let claws: [Claw]
        }
        let data = try await self.call("GET", "/v1/claws", bearer: session.token)
        return try Self.decode(Response.self, data).claws.compactMap { claw in
            guard OpenClawIDNodeEnrollmentLink.matches(claw.claw_id, "^[0-9a-f]{32}$"),
                  OpenClawIDNodeEnrollmentLink.validHostname(claw.hostname) else { return nil }
            return .init(
                id: claw.claw_id,
                hostname: claw.hostname,
                relationship: claw.relationship,
                role: claw.role,
                online: claw.online)
        }
    }

    /// The claw's descriptor and snapshot in the `{ descriptor, snapshot }` shape the verifier reads.
    func descriptorAndSnapshot(_ session: OpenClawIDDiscoverySession, clawID: String) async throws -> Data {
        let descriptor = try await OpenClawIDCanonicalJSON.parse(
            self.call("GET", "/v1/claws/\(clawID)/descriptor", bearer: session.token)).fields(["descriptor"])
        let snapshot = try await OpenClawIDCanonicalJSON.parse(
            self.call("GET", "/v1/claws/\(clawID)/snapshot", bearer: session.token)).fields(["snapshot"])
        return OpenClawIDCanonicalJSON.object([
            "descriptor": descriptor["descriptor"]!,
            "snapshot": snapshot["snapshot"]!,
        ]).encoded
    }

    /// POST /v1/devices: links D and W to the account so Discovery can address device mail.
    func bindDevice(
        _ session: OpenClawIDDiscoverySession,
        device: OpenClawIDNodeIdentity,
        peer: OpenClawIDNodeIdentity,
        label: String) async throws
    {
        let ts = self.now()
        let body = try OpenClawIDCanonicalJSON.object([
            "device_pub": .string(device.signingKey),
            "peer_key": .string(peer.peerKey),
            "label": .string(label),
            "ts": .integer(ts),
            "peer_key_proof": .string(OpenClawIDStatement.peerKeyProof(
                accountID: session.accountID, device: device, peer: peer, ts: ts)),
        ]).encoded
        _ = try await self.call("POST", "/v1/devices", body: body, bearer: session.token, device: device)
    }

    /// POST /v1/claws/{id}/mailbox, device-signed.
    func send(
        _ session: OpenClawIDDiscoverySession,
        device: OpenClawIDNodeIdentity,
        clawID: String,
        to: String,
        payload: OpenClawIDCanonicalJSON) async throws
    {
        let body = OpenClawIDCanonicalJSON.object(["to": .string(to), "payload": payload]).encoded
        _ = try await self.call(
            "POST", "/v1/claws/\(clawID)/mailbox", body: body, bearer: session.token, device: device)
    }

    /// GET /v1/claws/{id}/mailbox/device: mail to this device's fingerprint (and to owners once it is one).
    func receive(
        _ session: OpenClawIDDiscoverySession,
        device: OpenClawIDNodeIdentity,
        clawID: String,
        after: String?,
        wait: Int) async throws -> (messages: [OpenClawIDDeviceMail], cursor: String?)
    {
        var query = "wait=\(wait)"
        if let after, OpenClawIDNodeEnrollmentLink.matches(after, "^[0-9]{1,15}$") { query = "after=\(after)&" + query }
        let data = try await self.call(
            "GET", "/v1/claws/\(clawID)/mailbox/device?\(query)", bearer: session.token, device: device)
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let messages = root["messages"] as? [[String: Any]]
        else { throw OpenClawIDNodeEnrollmentError.malformed }
        let parsed = messages.compactMap { message -> OpenClawIDDeviceMail? in
            guard let id = message["message_id"] as? String, let to = message["to"] as? String,
                  let payload = message["payload"] as? [String: Any], let kind = payload["kind"] as? String
            else { return nil }
            let data = (payload["data"] as? [String: Any] ?? [:]).compactMapValues { $0 as? String }
            return .init(
                id: id,
                to: to,
                kind: kind,
                requestID: payload["request_id"] as? String,
                step: payload["step"] as? String,
                event: payload["event"] as? String,
                ref: payload["ref"] as? String,
                data: data)
        }
        return (parsed, root["cursor"] as? String)
    }

    private func call(
        _ method: String,
        _ path: String,
        body: Data? = nil,
        bearer: String,
        device: OpenClawIDNodeIdentity? = nil) async throws -> Data
    {
        guard let url = URL(string: path, relativeTo: self.origin)?.absoluteURL else {
            throw OpenClawIDNodeEnrollmentError.invalidLink
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 40)
        request.httpMethod = method
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("Bearer \(bearer)", forHTTPHeaderField: "authorization")
        if let device {
            try request.setValue(
                OpenClawIDNodeEnrollmentClient.discoverySignature(
                    identity: device, method: method, path: path, body: body ?? Data(), now: self.now()),
                forHTTPHeaderField: "openclaw-signature")
        }
        try Task.checkCancellation()
        let response = try await self.http.send(request)
        try Task.checkCancellation()
        guard (200...299).contains(response.status) else {
            throw OpenClawIDDiscoveryAccountError(status: response.status, code: Self.errorCode(response.body))
        }
        return response.body
    }

    private static func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        do { return try JSONDecoder().decode(type, from: data) } catch { throw OpenClawIDNodeEnrollmentError.malformed }
    }

    /// Discovery's error `code` only; the message is never surfaced.
    private static func errorCode(_ data: Data) -> String? {
        struct Failure: Decodable { struct Details: Decodable { let code: String }
            let error: Details
        }
        return try? JSONDecoder().decode(Failure.self, from: data).error.code
    }
}

/// A refused Discovery call: HTTP status and the protocol's error code, never remote text.
public struct OpenClawIDDiscoveryAccountError: Error, Sendable, Equatable {
    public let status: Int
    public let code: String?
}
