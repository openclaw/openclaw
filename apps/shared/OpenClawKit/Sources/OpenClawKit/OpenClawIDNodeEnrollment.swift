import CryptoKit
import Foundation

/// Bounded Discovery response, injectable without granting test transports trust authority.
public struct OpenClawIDNodeEnrollmentHTTPResponse: Sendable {
    public let status: Int
    public let body: Data
    public init(status: Int, body: Data) {
        self.status = status
        self.body = body
    }
}

/// Implementations must honor cancellation/deadline, refuse redirects and cap response bytes.
public protocol OpenClawIDNodeEnrollmentHTTP: Sendable {
    func send(_ request: URLRequest) async throws -> OpenClawIDNodeEnrollmentHTTPResponse
}

/// Ephemeral, redirect-free URLSession transport with a one-MiB streaming response limit.
public struct OpenClawIDNodeEnrollmentURLSession: OpenClawIDNodeEnrollmentHTTP {
    public init() {}

    /// Does not use cookies, URL credentials, cache or platform credential storage.
    public func send(_ request: URLRequest) async throws -> OpenClawIDNodeEnrollmentHTTPResponse {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 15
        let session = URLSession(configuration: configuration, delegate: RedirectRefusal(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else { throw OpenClawIDNodeEnrollmentError.unavailable }
        guard !(300...399).contains(http.statusCode) else { throw OpenClawIDNodeEnrollmentError.redirect }
        guard response.expectedContentLength <= 1_048_576 else { throw OpenClawIDNodeEnrollmentError.responseTooLarge }
        var data = Data()
        for try await byte in bytes {
            try Task.checkCancellation()
            guard data.count < 1_048_576 else { throw OpenClawIDNodeEnrollmentError.responseTooLarge }
            data.append(byte)
        }
        return .init(status: http.statusCode, body: data)
    }

    private final class RedirectRefusal: NSObject, URLSessionTaskDelegate, Sendable {
        func urlSession(
            _ session: URLSession,
            task: URLSessionTask,
            willPerformHTTPRedirection response: HTTPURLResponse,
            newRequest request: URLRequest,
            completionHandler: @escaping @Sendable (URLRequest?) -> Void)
        {
            completionHandler(nil)
        }
    }
}

/// Accountless enrollment only: mail W's manifest and wait for verified explicit owner admission.
public struct OpenClawIDNodeEnrollmentClient: Sendable {
    private let http: any OpenClawIDNodeEnrollmentHTTP
    private let trustStore: any OpenClawIDNodeTrustStore
    private let now: @Sendable () -> Int64
    private let sleep: @Sendable (UInt64) async throws -> Void

    /// Production uses the system clock; tests may supply a deterministic clock and cancellable sleeper.
    public init(
        http: any OpenClawIDNodeEnrollmentHTTP = OpenClawIDNodeEnrollmentURLSession(),
        trustStore: any OpenClawIDNodeTrustStore,
        now: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970) },
        sleep: @escaping @Sendable (UInt64) async throws -> Void = { try await Task.sleep(nanoseconds: $0) })
    {
        self.http = http
        self.trustStore = trustStore
        self.now = now
        self.sleep = sleep
    }

    /// Validates inputs, retries one immutable redemption, and persists verified public trust before returning.
    /// 403 remains pending (not a claim of denial). Cancellation never installs a route.
    public func enroll(
        joinLink: String,
        discoveryOrigin: String,
        identity: OpenClawIDNodeIdentity,
        description: OpenClawIDNodeEnrollmentDescription,
        onVerificationCode: @escaping @Sendable (String) async -> Void) async throws
    -> OpenClawIDNodeTrustTarget {
        let origin = try OpenClawIDNodeEnrollmentLink.discoveryOrigin(discoveryOrigin)
        // Parse inside the attempt so no outer task retains decoded invite bytes during polling.
        // A hard monotonic deadline bounds stalled I/O as well as polling, independent of clock changes.
        return try await withThrowingTaskGroup(of: OpenClawIDNodeTrustTarget.self) { group in
            group.addTask {
                try await self.run(
                    joinLink: joinLink,
                    origin: origin,
                    identity: identity,
                    description: description,
                    onVerificationCode: onVerificationCode)
            }
            group.addTask {
                try await Task.sleep(for: .seconds(3600))
                throw OpenClawIDNodeEnrollmentError.timeout
            }
            defer { group.cancelAll() }
            guard let result = try await group.next() else { throw OpenClawIDNodeEnrollmentError.unavailable }
            return result
        }
    }

    /// Reconnect after restart without a new invite or redemption. The caller restores W from the
    /// saved enrollment's dedicated Keychain item; neither the stored route nor evidence grants a dial.
    public func refresh(
        hostname: String,
        enrollment: OpenClawIDNodeSavedEnrollment,
        identity: OpenClawIDNodeIdentity) async throws -> OpenClawIDNodeTrustTarget
    {
        try Task.checkCancellation()
        guard identity.peerKey == enrollment.peerKey else { throw OpenClawIDNodeEnrollmentError.invalidIdentity }
        guard let previous = try await trustStore.load(hostname: hostname) else {
            throw OpenClawIDNodeEnrollmentError.notAdmitted
        }
        let response = try await call(
            origin: enrollment.discoveryOrigin,
            clawID: previous.clawID,
            identity: identity,
            mail: nil)
        guard (200...299).contains(response.status) else {
            throw OpenClawIDNodeEnrollmentError.discoveryRejected(response.status)
        }
        let assessment = try OpenClawIDNodeTrust.assessRefresh(
            response: response.body,
            hostname: hostname,
            discoveryOrigin: enrollment.discoveryOrigin,
            peerKey: identity.peerKey,
            previous: previous,
            now: self.now())
        return try await self.persist(assessment, hostname: hostname)
    }

    private func persist(_ assessment: OpenClawIDNodeTrustAssessment, hostname: String) async throws
    -> OpenClawIDNodeTrustTarget {
        try Task.checkCancellation()
        // Refusal is not permission to forget verified revocation/rotation evidence.
        if let observation = assessment.observation {
            try await self.trustStore.observe(hostname: hostname, state: observation)
            try Task.checkCancellation()
        }
        let target = try assessment.verdict.get()
        try await self.trustStore.commit(target)
        try Task.checkCancellation()
        return target
    }

    private func run(
        joinLink: String,
        origin: URL,
        identity: OpenClawIDNodeIdentity,
        description: OpenClawIDNodeEnrollmentDescription,
        onVerificationCode: @Sendable (String) async -> Void) async throws -> OpenClawIDNodeTrustTarget
    {
        var link = try OpenClawIDNodeEnrollmentLink(joinLink)
        try Task.checkCancellation()
        let previous = try await trustStore.load(hostname: link.hostname)
        try Task.checkCancellation()
        if let previous, previous.clawID != link.clawID || previous.rootFingerprint != link.rootFingerprint {
            throw OpenClawIDNodeEnrollmentError.rootMismatch
        }
        let redemption = try Self.redemption(link: &link, identity: identity, description: description, now: self.now())
        await onVerificationCode(Self.verificationCode(link: link, peerKey: identity.peerKey, description: description))
        let body = OpenClawIDCanonicalJSON.object([
            "to": .string("gateway"),
            "payload": .object(["kind": .string("node_redemption"), "redemption": redemption]),
        ]).encoded
        try await self.deliverRedemption(body, origin: origin, clawID: link.clawID, identity: identity)
        // Pending responses back off to 15 seconds after mail delivery succeeds.
        var delay: UInt64 = 1
        let started = self.now()
        while true {
            try Task.checkCancellation()
            guard self.now() - started < 3600 else { throw OpenClawIDNodeEnrollmentError.timeout }
            let response = try await call(origin: origin, clawID: link.clawID, identity: identity, mail: nil)
            if (200...299).contains(response.status) {
                let assessment = try OpenClawIDNodeTrust.assess(
                    response: response.body,
                    link: link,
                    discoveryOrigin: origin,
                    peerKey: identity.peerKey,
                    previous: previous,
                    now: self.now())
                return try await self.persist(assessment, hostname: link.hostname)
            }
            guard [403, 404, 429, 503].contains(response.status) else {
                throw OpenClawIDNodeEnrollmentError.discoveryRejected(response.status)
            }
            let retry = Self.retryAfter(response.body)
            let wait = max(delay, retry)
            guard wait < 3600, self.now() - started + Int64(wait) < 3600 else {
                throw OpenClawIDNodeEnrollmentError.timeout
            }
            try await self.sleep(wait * 1_000_000_000)
            delay = min(delay * 2, 15)
        }
    }

    private func deliverRedemption(
        _ body: Data,
        origin: URL,
        clawID: String,
        identity: OpenClawIDNodeIdentity) async throws
    {
        // Discovery deduplicates the signed redemption, not just W. Preserve the exact
        // bytes (including requested_at and signature) if a successful POST response is lost.
        // Only the outer request authentication is refreshed on each attempt.
        var delay: UInt64 = 1
        for attempt in 0..<5 {
            var retry: UInt64 = 0
            do {
                let response = try await call(origin: origin, clawID: clawID, identity: identity, mail: body)
                if (200...299).contains(response.status) { return }
                guard [429, 503].contains(response.status), attempt < 4 else {
                    throw OpenClawIDNodeEnrollmentError.discoveryRejected(response.status)
                }
                retry = Self.retryAfter(response.body)
            } catch let error as URLError {
                guard [
                    .timedOut,
                    .networkConnectionLost,
                    .notConnectedToInternet,
                    .cannotFindHost,
                    .cannotConnectToHost,
                    .dnsLookupFailed,
                ].contains(error.code), attempt < 4
                else { throw error }
            }
            try Task.checkCancellation()
            let wait = max(delay, retry)
            guard wait < 3600 else { throw OpenClawIDNodeEnrollmentError.timeout }
            try await self.sleep(wait * 1_000_000_000)
            delay *= 2
        }
    }

    private func call(origin: URL, clawID: String, identity: OpenClawIDNodeIdentity, mail: Data?) async throws
    -> OpenClawIDNodeEnrollmentHTTPResponse {
        let path = "/v1/claws/\(clawID)/" + (mail == nil ? "node/descriptor" : "mailbox/node")
        guard let url = URL(string: path, relativeTo: origin)?.absoluteURL else {
            throw OpenClawIDNodeEnrollmentError.invalidLink
        }
        let method = mail == nil ? "GET" : "POST"
        let body = mail ?? Data()
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        request.httpMethod = method
        request.httpBody = mail
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        try request.setValue(
            Self.discoverySignature(identity: identity, method: method, path: path, body: body, now: self.now()),
            forHTTPHeaderField: "openclaw-signature")
        try Task.checkCancellation()
        let result = try await http.send(request)
        try Task.checkCancellation()
        guard result.body.count <= 1_048_576 else { throw OpenClawIDNodeEnrollmentError.responseTooLarge }
        guard !(300...399).contains(result.status) else { throw OpenClawIDNodeEnrollmentError.redirect }
        return result
    }

    static func redemption(
        link: inout OpenClawIDNodeEnrollmentLink,
        identity: OpenClawIDNodeIdentity,
        description: OpenClawIDNodeEnrollmentDescription,
        now: Int64) throws -> OpenClawIDCanonicalJSON
    {
        let parts: [String: OpenClawIDCanonicalJSON] = [
            "claw_id": .string(link.clawID),
            "invite_id": .string(link.inviteID),
            "peer_key": .string(identity.peerKey),
        ]
        let proofKey = link.consumeSecret { secret in
            HKDF<SHA256>.deriveKey(
                inputKeyMaterial: SymmetricKey(data: secret),
                salt: Data("openclaw/invite/v1".utf8),
                info: Data("proof-key".utf8),
                outputByteCount: 32)
        }
        let proof = HMAC<SHA256>.authenticationCode(
            for: Data("openclaw/node-invite-proof/v1\0".utf8) +
                OpenClawIDCanonicalJSON.object(parts).encoded,
            using: proofKey)
        var fields = parts
        fields["proof"] = .string(OpenClawIDNodeIdentity.hex(proof))
        fields["description"] = description.json
        fields["requested_at"] = .integer(now)
        let body = OpenClawIDCanonicalJSON.object(fields)
        let signature = try identity.sign(Data("openclaw/NodeRedemption/v1\0".utf8) + body.encoded)
        return .object([
            "v": .integer(1),
            "type": .string("NodeRedemption"),
            "body": body,
            "signer": .string(identity.signingKey),
            "alg": .string("ed25519"),
            "sig": .string(OpenClawIDNodeIdentity.base64URL(signature)),
        ])
    }

    static func verificationCode(
        link: OpenClawIDNodeEnrollmentLink,
        peerKey: String,
        description: OpenClawIDNodeEnrollmentDescription) -> String
    {
        let parts = OpenClawIDCanonicalJSON.object([
            "claw_id": .string(link.clawID),
            "invite_id": .string(link.inviteID),
            "peer_key": .string(peerKey),
            "description": description.json,
        ])
        let digest = SHA256.hash(data: Data("openclaw/node-verification-code/v1\0".utf8) + parts.encoded)
        let number = digest.prefix(4).reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        return String(format: "%06u", number % 1_000_000)
    }

    static func discoverySignature(
        identity: OpenClawIDNodeIdentity,
        method: String,
        path: String,
        body: Data,
        now: Int64) throws -> String
    {
        let parts = OpenClawIDCanonicalJSON.object([
            "body_sha256": .string(OpenClawIDNodeIdentity.hex(SHA256.hash(data: body))),
            "method": .string(method.uppercased()),
            "path": .string(path),
            "ts": .integer(now),
        ])
        let signature = try identity.sign(Data("openclaw/discovery-request/v1\0".utf8) + parts.encoded)
        return "keyid=\(identity.signingKey),ts=\(now),sig=\(OpenClawIDNodeIdentity.base64URL(signature))"
    }

    private static func retryAfter(_ data: Data) -> UInt64 {
        // Error hints are not signed protocol bodies; permit fractional seconds but round up.
        // Decode only the numeric hint and never surface the remote message.
        struct Failure: Decodable {
            struct Details: Decodable { let retry_after: Double? }
            let error: Details
        }
        guard let failure = try? JSONDecoder().decode(Failure.self, from: data),
              let seconds = failure.error.retry_after, seconds.isFinite, seconds > 0 else { return 0 }
        return UInt64(min(seconds.rounded(.up), 3600))
    }
}
