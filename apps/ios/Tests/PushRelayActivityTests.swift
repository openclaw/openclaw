import CryptoKit
import Foundation
import Testing
@testable import OpenClaw

private actor ActivityRelayBarrier {
    private var entered = false
    private var released = false
    private var arrival: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiter: CheckedContinuation<Void, Never>?

    func wait() async {
        self.entered = true
        self.arrival.forEach { $0.resume() }
        self.arrival.removeAll()
        if !self.released {
            await withCheckedContinuation { self.releaseWaiter = $0 }
        }
    }

    func waitUntilEntered() async {
        if !self.entered {
            await withCheckedContinuation { self.arrival.append($0) }
        }
    }

    func release() {
        self.released = true
        self.releaseWaiter?.resume()
        self.releaseWaiter = nil
    }
}

private final class ActivityRelayURLProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) async throws -> (Int, Data)
    private static let lock = NSLock()
    private nonisolated(unsafe) static var handlers: [String: Handler] = [:]
    private let taskLock = NSLock()
    private var loadingTask: Task<Void, Never>?

    static func install(host: String, handler: Handler?) {
        self.lock.withLock { self.handlers[host] = handler }
    }

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        let handler = Self.lock.withLock { Self.handlers[self.request.url?.host ?? ""] }
        self.taskLock.withLock {
            self.loadingTask = Task { @Sendable [self, handler] in
                do {
                    let handler = try #require(handler)
                    let (status, data) = try await handler(self.request)
                    try Task.checkCancellation()
                    let url = try #require(self.request.url)
                    let response = try #require(HTTPURLResponse(
                        url: url, statusCode: status,
                        httpVersion: nil, headerFields: ["Content-Type": "application/json"]))
                    self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                    self.client?.urlProtocol(self, didLoad: data)
                    self.client?.urlProtocolDidFinishLoading(self)
                } catch {
                    self.client?.urlProtocol(self, didFailWithError: error)
                }
            }
        }
    }

    override func stopLoading() {
        self.taskLock.withLock { self.loadingTask?.cancel() }
    }
}

private actor ActivityRelayServer {
    struct Reply: Sendable {
        let status: Int
        let body: String
    }

    private(set) var requests: [URLRequest] = []
    private(set) var events: [String] = []
    private var challenges = 0
    private var replies: [Reply]
    private var barrier: ActivityRelayBarrier?
    private var failNextResponse: Bool

    init(replies: [Reply] = [], barrier: ActivityRelayBarrier? = nil, failNextResponse: Bool = false) {
        self.replies = replies
        self.barrier = barrier
        self.failNextResponse = failNextResponse
    }

    func respond(_ request: URLRequest) async throws -> (Int, Data) {
        if request.url?.path == "/v1/push/challenge" {
            self.challenges += 1
            self.events.append("challenge")
            return (200, Data("""
            {"challengeId":"challenge-id-\(self.challenges)","challenge":"actual-challenge-\(self.challenges)","expiresAtMs":1800000000000}
            """.utf8))
        }
        var recorded = request
        recorded.httpBody = try Self.body(request)
        self.requests.append(recorded)
        let body = try Self.object(recorded)
        let operation = body["operation"] as? String ?? "ordinary"
        self.events.append(operation)
        let barrier = self.barrier
        self.barrier = nil
        let shouldFail = self.failNextResponse
        self.failNextResponse = false
        if let barrier { await barrier.wait() }
        self.events.append("response:\(operation)")
        if shouldFail { throw URLError(.networkConnectionLost) }
        if !self.replies.isEmpty {
            let reply = self.replies.removeFirst()
            return (reply.status, Data(reply.body.utf8))
        }
        switch operation {
        case "discover":
            return (200, Data(Self.live.utf8))
        case "revoke":
            return (410, Data(#"{"status":"gone"}"#.utf8))
        default:
            let revision = (body["expectedRevision"] as? Int64 ?? 0) + 1
            return (200, Data("""
            {"status":"active","revision":\(revision),"expiresAtMs":1800000000000,"relayHandle":"activity-handle","sendGrant":"activity-grant"}
            """.utf8))
        }
    }

    static let live = #"{"status":"active","revision":1,"expiresAtMs":1800000000000}"#

    nonisolated static func object(_ request: URLRequest) throws -> [String: Any] {
        try #require(JSONSerialization.jsonObject(with: self.body(request)) as? [String: Any])
    }

    private nonisolated static func body(_ request: URLRequest) throws -> Data {
        if let body = request.httpBody { return body }
        let stream = try #require(request.httpBodyStream)
        stream.open()
        defer { stream.close() }
        var result = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count >= 0 else { throw URLError(.cannotDecodeContentData) }
            if count == 0 { break }
            result.append(contentsOf: buffer.prefix(count))
        }
        return result
    }
}

private actor ActivityAttestDevice {
    let key = "selected-app-attest-key"
    private(set) var generated = 0
    private(set) var attestations: [(String, Data)] = []
    private(set) var assertions: [(String, Data)] = []
    private var failAssertion = false

    func generate() -> String {
        self.generated += 1
        return self.key
    }

    func attest(_ key: String, _ hash: Data) -> Data {
        self.attestations.append((key, hash))
        return Data("attestation".utf8)
    }

    func assert(_ key: String, _ hash: Data) throws -> Data {
        self.assertions.append((key, hash))
        if self.failAssertion {
            self.failAssertion = false
            throw URLError(.unknown)
        }
        return Data("assertion".utf8)
    }

    func failNextAssertion() {
        self.failAssertion = true
    }
}

private struct ActivityRelayFixture {
    let host: String
    let scope: PushRelayRegistrationStore.AppAttestScope
    let session: URLSession
    let server: ActivityRelayServer
    let device: ActivityAttestDevice
    let appAttest: PushRelayAppAttestService
    let client: PushRelayClient
    let input: PushRelayActivityInput

    init(
        attested: Bool = true,
        replies: [ActivityRelayServer.Reply] = [],
        barrier: ActivityRelayBarrier? = nil,
        failNextResponse: Bool = false) throws
    {
        self.host = "\(UUID().uuidString.lowercased()).example.invalid"
        let url = try #require(URL(string: "https://\(self.host)"))
        self.scope = PushRelayRegistrationStore.AppAttestScope(
            relayOrigin: url.absoluteString, apnsEnvironment: "sandbox",
            relayProfile: "deviceSandbox", proofPolicy: "appleDevelopment")
        self.device = ActivityAttestDevice()
        let device = self.device
        self.appAttest = PushRelayAppAttestService(device: PushRelayAppAttestDevice(
            isSupported: { true }, generateKey: { await device.generate() },
            attestKey: { await device.attest($0, $1) },
            generateAssertion: { try await device.assert($0, $1) }))
        self.server = ActivityRelayServer(
            replies: replies, barrier: barrier, failNextResponse: failNextResponse)
        let server = self.server
        ActivityRelayURLProtocol.install(host: self.host) { try await server.respond($0) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ActivityRelayURLProtocol.self]
        self.session = URLSession(configuration: config)
        self.client = PushRelayClient(
            baseURL: url, session: self.session, appAttest: self.appAttest,
            loadReceipt: { Data("receipt".utf8).base64EncodedString() })
        self.input = PushRelayActivityInput(
            owner: PushRelayActivityOwner(
                activityId: "activity-id", profileId: "profile-id",
                gatewayIdentity: PushRelayGatewayIdentity(deviceId: "gateway-id", publicKey: "gateway-public-key")),
            installationId: "installation-id", bundleId: "ai.openclaw.tests",
            environment: .sandbox, relayProfile: .deviceSandbox, proofPolicy: .appleDevelopment)
        if attested {
            #expect(PushRelayRegistrationStore.saveAppAttestKeyID("selected-app-attest-key", scope: self.scope))
            #expect(PushRelayRegistrationStore.saveAttestedKeyID("selected-app-attest-key", scope: self.scope))
        }
    }

    var ordinary: PushRelayRegistrationInput {
        PushRelayRegistrationInput(
            installationId: self.input.installationId, bundleId: self.input.bundleId, appVersion: "1.0",
            environment: .sandbox, relayProfile: .deviceSandbox, proofPolicy: .appleDevelopment,
            distribution: .official, apnsTokenHex: String(repeating: "ab", count: 32),
            gatewayIdentity: self.input.owner.gatewayIdentity)
    }

    func close() {
        self.session.invalidateAndCancel()
        ActivityRelayURLProtocol.install(host: self.host, handler: nil)
        PushRelayRegistrationStore.clearAppAttestKeyID(scope: self.scope)
        PushRelayRegistrationStore.clearAttestedKeyID(scope: self.scope)
    }
}

@Suite(.timeLimit(.minutes(1)))
struct PushRelayActivityTests {
    @Test func `activity operations sign selected key and actual challenge without ordinary fields`() async throws {
        let fixture = try ActivityRelayFixture()
        defer { fixture.close() }
        let token = String(repeating: "aB", count: 32)
        let operations: [PushRelayActivityOperation] = try [
            .create(token: token), .discover,
            .rotate(revision: PushRelayActivityRevision(1), token: token),
            .revoke(revision: PushRelayActivityRevision(2)),
        ]
        for operation in operations {
            _ = try await fixture.client.performActivityOperation(operation, input: fixture.input)
        }
        let requests = await fixture.server.requests
        let assertions = await fixture.device.assertions
        try #require(requests.count == 4)
        try #require(assertions.count == 4)
        for (index, request) in requests.enumerated() {
            let body = try ActivityRelayServer.object(request)
            let proof = try #require(body["appAttest"] as? [String: Any])
            let signedPayloadBase64 = try #require(proof["signedPayloadBase64"] as? String)
            let bytes = try #require(Data(base64Encoded: signedPayloadBase64))
            let signed = try #require(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
            var expected = body
            expected.removeValue(forKey: "appAttest")
            expected.removeValue(forKey: "receipt")
            expected["appAttestKeyId"] = "selected-app-attest-key"
            expected["challenge"] = "actual-challenge-\(index + 1)"
            #expect(NSDictionary(dictionary: signed) == NSDictionary(dictionary: expected))
            #expect(proof["keyId"] as? String == "selected-app-attest-key")
            #expect(assertions[index].0 == "selected-app-attest-key")
            #expect(assertions[index].1 == Data(SHA256.hash(data: bytes)))
            #expect(proof["clientDataHash"] as? String == Self.base64URL(Data(SHA256.hash(data: bytes))))
            let operation = operations[index]
            var keys: Set = [
                "purpose", "activityId", "installationId", "profileId", "bundleId", "relayProfile",
                "apnsEnvironment", "proofPolicy", "distribution", "gateway", "operation",
                "challengeId", "appAttest", "receipt",
            ]
            if operation.expectedRevision != nil { keys.insert("expectedRevision") }
            if operation.token != nil { keys.insert("apnsToken") }
            #expect(Set(body.keys) == keys)
            #expect(body["expectedRevision"] as? Int64 == operation.expectedRevision)
            #expect(body["apnsToken"] as? String == operation.token)
            #expect(body["purpose"] as? String == "liveActivity")
            #expect(request.url?.path == "/v1/push/activity/\(operation.name == "revoke" ? "revoke" : "register")")
            #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
            #expect(request.value(forHTTPHeaderField: "CF-Access-Client-Secret") == nil)
        }
        #expect(await fixture.device.generated == 0)
        #expect(await fixture.device.attestations.isEmpty)
        _ = try await fixture.client.register(fixture.ordinary)
        let ordinary = try ActivityRelayServer.object(#require(await fixture.server.requests.last))
        let proof = try #require(ordinary["appAttest"] as? [String: Any])
        let signedPayloadBase64 = try #require(proof["signedPayloadBase64"] as? String)
        let bytes = try #require(Data(base64Encoded: signedPayloadBase64))
        let signed = try #require(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        let ordinaryKeys: Set = [
            "challengeId", "installationId", "bundleId", "environment", "relayProfile",
            "apnsEnvironment", "proofPolicy", "distribution", "gateway", "appVersion", "apnsToken",
        ]
        #expect(Set(signed.keys) == ordinaryKeys)
        #expect(NSDictionary(dictionary: signed) == NSDictionary(
            dictionary: ordinary.filter { ordinaryKeys.contains($0.key) }))
    }

    @Test func `proof encodes once after key selection and hashes the exact retained bytes`() async throws {
        let fixture = try ActivityRelayFixture(attested: false)
        defer { fixture.close() }
        var encodings = 0
        let bytes = Data(" {\"selected\":\"selected-app-attest-key\", \"nonce\":17}\n".utf8)
        let proof = try await fixture.appAttest.createProof(
            challenge: "actual-challenge",
            makeSignedPayload: { key in
                encodings += 1
                #expect(key == "selected-app-attest-key")
                #expect(PushRelayRegistrationStore.loadAppAttestKeyID(scope: fixture.scope) == key)
                return bytes
            }, scope: fixture.scope)
        #expect(encodings == 1)
        #expect(Data(base64Encoded: proof.signedPayloadBase64) == bytes)
        #expect(proof.clientDataHash == Self.base64URL(Data(SHA256.hash(data: bytes))))
        let attestations = await fixture.device.attestations
        let assertions = await fixture.device.assertions
        #expect(attestations.count == 1)
        #expect(attestations.first?.1 == Data(SHA256.hash(data: Data("actual-challenge".utf8))))
        #expect(assertions.first?.1 == Data(SHA256.hash(data: bytes)))
    }

    @Test func `response outcomes keep discovery metadata separate from credentials`() async throws {
        let rows: [(Int, String, PushRelayActivityOutcome)] = [
            (404, #"{"status":"unknown"}"#, .unknown),
            (410, #"{"status":"gone"}"#, .gone),
            (409, #"{"status":"conflict"}"#, .conflict),
            (401, #"{"status":"unauthorized"}"#, .unauthorized),
            (403, #"{"status":"unauthorized"}"#, .unauthorized),
            (429, #"{"status":"rate_limited"}"#, .rateLimited),
            (503, #"{"status":"unavailable"}"#, .unavailable),
            (
                200,
                #"{"status":"active","revision":1,"expiresAtMs":1800000000000,"sendGrant":"must-not-escape"}"#,
                .operationOutcomeUnknown),
            (200, #"{"status":"active","revision":9007199254740992,"expiresAtMs":1}"#, .operationOutcomeUnknown),
            (200, #"{"status":"active","revision":1.5,"expiresAtMs":1}"#, .operationOutcomeUnknown),
            (200, #"{"status":"active","revision":1,"expiresAtMs":9007199254740992}"#, .operationOutcomeUnknown),
            (200, "{}", .operationOutcomeUnknown),
        ]
        let fixture = try ActivityRelayFixture(replies: rows.map { .init(status: $0.0, body: $0.1) })
        defer { fixture.close() }
        for (_, _, expected) in rows {
            #expect(try await fixture.client.performActivityOperation(.discover, input: fixture.input) == expected)
        }
        let requests = await fixture.server.requests
        #expect(requests.count == rows.count)
        #expect(try requests.allSatisfy { try ActivityRelayServer.object($0)["operation"] as? String == "discover" })
        let live = try await fixture.client.performActivityOperation(.discover, input: fixture.input)
        guard case let .live(metadata) = live else {
            Issue.record("Discovery must return credential-free metadata")
            return
        }
        let token = String(repeating: "ab", count: 32)
        let rotated = try await fixture.client.performActivityOperation(
            .rotate(revision: metadata.revision, token: token), input: fixture.input)
        guard case let .grant(grant) = rotated else {
            Issue.record("Explicit rotation must return a transient grant")
            return
        }
        #expect(grant.metadata.revision.rawValue == 2)
        #expect(grant.topic == "ai.openclaw.tests")
        #expect(grant.installationId == fixture.input.installationId)
        #expect(try await fixture.client.performActivityOperation(
            .revoke(revision: grant.metadata.revision), input: fixture.input) == .gone)
    }

    @Test(arguments: [true, false], [true, false])
    func `ordinary and activity enrollments serialize through response and failure`(
        ordinaryFirst: Bool, failResponse: Bool) async throws
    {
        let barrier = ActivityRelayBarrier()
        let fixture = try ActivityRelayFixture(barrier: barrier, failNextResponse: failResponse)
        defer { fixture.close() }
        let first = Task { try await Self.enroll(fixture, ordinary: ordinaryFirst) }
        await barrier.waitUntilEntered()
        let second = Task { try await Self.enroll(fixture, ordinary: !ordinaryFirst) }
        await Task.yield()
        #expect(await fixture.server.events == ["challenge", ordinaryFirst ? "ordinary" : "discover"])
        await barrier.release()
        _ = await first.result
        try await second.value
        let firstName = ordinaryFirst ? "ordinary" : "discover"
        let secondName = ordinaryFirst ? "discover" : "ordinary"
        #expect(await fixture.server.events == [
            "challenge", firstName, "response:\(firstName)",
            "challenge", secondName, "response:\(secondName)",
        ])
    }

    @Test func `queued cancellation spends no challenge and in flight cancellation releases enrollment`() async throws {
        let barrier = ActivityRelayBarrier()
        let fixture = try ActivityRelayFixture(barrier: barrier)
        defer { fixture.close() }
        let first = Task { try await fixture.client.performActivityOperation(.discover, input: fixture.input) }
        await barrier.waitUntilEntered()
        let queued = Task { try await fixture.client.register(fixture.ordinary) }
        await Task.yield()
        queued.cancel()
        do {
            _ = try await queued.value
            Issue.record("Cancelled enrollment must not run")
        } catch {
            #expect(error is CancellationError)
        }
        #expect(await fixture.server.events == ["challenge", "discover"])
        first.cancel()
        #expect(try await first.value == .operationOutcomeUnknown)
        await barrier.release()
        _ = try await fixture.client.register(fixture.ordinary)
        #expect(await fixture.server.requests.count == 2)
    }

    @Test func `ordinary assertion errors and unauthorized responses preserve the activity key`() async throws {
        let fixture = try ActivityRelayFixture(replies: [
            .init(status: 401, body: #"{"error":"unauthorized"}"#),
        ])
        defer { fixture.close() }
        await fixture.device.failNextAssertion()
        await #expect(throws: (any Error).self) { try await fixture.client.register(fixture.ordinary) }
        await #expect(throws: (any Error).self) { try await fixture.client.register(fixture.ordinary) }
        #expect(PushRelayRegistrationStore.loadAppAttestKeyID(scope: fixture.scope) == "selected-app-attest-key")
        #expect(PushRelayRegistrationStore.loadAttestedKeyID(scope: fixture.scope) == "selected-app-attest-key")
        _ = try await fixture.client.performActivityOperation(.discover, input: fixture.input)
        #expect(await fixture.device.generated == 0)
        #expect(await fixture.device.attestations.isEmpty)
        #expect(await fixture.device.assertions.count == 3)
    }

    @Test(arguments: [true, false], [true, false])
    func `lost enrollment acknowledgment never clears a key or implicitly recreates`(
        fresh: Bool, ordinary: Bool) async throws
    {
        let fixture = try ActivityRelayFixture(attested: !fresh, failNextResponse: true)
        defer { fixture.close() }
        if ordinary {
            do {
                _ = try await fixture.client.register(fixture.ordinary)
                Issue.record("A lost response cannot acknowledge ordinary enrollment")
            } catch {
                if fresh {
                    guard case PushRelayError.freshAttestationUnacknowledged = error else {
                        Issue.record("First-key acknowledgment loss must remain explicit")
                        return
                    }
                }
            }
        } else {
            let outcome = try await fixture.client.performActivityOperation(
                .create(token: String(repeating: "ab", count: 32)), input: fixture.input)
            #expect(outcome == (fresh ? .freshAttestationUnacknowledged : .operationOutcomeUnknown))
        }
        #expect(await fixture.server.requests.count == 1)
        #expect(PushRelayRegistrationStore.loadAppAttestKeyID(scope: fixture.scope) == "selected-app-attest-key")
        #expect(PushRelayRegistrationStore.loadAttestedKeyID(scope: fixture.scope) == "selected-app-attest-key")
        #expect(await fixture.device.generated == (fresh ? 1 : 0))
        #expect(await fixture.device.attestations.count == (fresh ? 1 : 0))
    }

    @Test func `safe integer revisions and device only policy fail before enrollment`() async throws {
        let revisions: [Int64] = [-1, 0, 9_007_199_254_740_992, Int64.max]
        for revision in revisions {
            #expect(throws: PushRelayError.self) { try PushRelayActivityRevision(revision) }
        }
        #expect(try PushRelayActivityRevision(9_007_199_254_740_991).rawValue == 9_007_199_254_740_991)
        let fixture = try ActivityRelayFixture()
        defer { fixture.close() }
        let simulator = PushRelayActivityInput(
            owner: fixture.input.owner, installationId: fixture.input.installationId, bundleId: fixture.input.bundleId,
            environment: .sandbox, relayProfile: .simulatorSandbox, proofPolicy: .internalSimulator)
        await #expect(throws: PushRelayError.self) {
            try await fixture.client.performActivityOperation(.discover, input: simulator)
        }
        await #expect(throws: PushRelayError.self) {
            try await fixture.client.performActivityOperation(.create(token: "not-a-token"), input: fixture.input)
        }
        #expect(await fixture.server.events.isEmpty)
    }

    @Test func `oversized retained owner fails before first attestation`() async throws {
        let fixture = try ActivityRelayFixture(attested: false)
        defer { fixture.close() }
        let input = PushRelayActivityInput(
            owner: PushRelayActivityOwner(
                activityId: fixture.input.owner.activityId, profileId: String(repeating: "p", count: 512),
                gatewayIdentity: PushRelayGatewayIdentity(
                    deviceId: "gateway-id", publicKey: String(repeating: "k", count: 512))),
            installationId: fixture.input.installationId, bundleId: fixture.input.bundleId,
            environment: .sandbox, relayProfile: .deviceSandbox, proofPolicy: .appleDevelopment)
        await #expect(throws: PushRelayError.self) {
            try await fixture.client.performActivityOperation(.discover, input: input)
        }
        #expect(await fixture.device.generated == 1)
        #expect(await fixture.device.attestations.isEmpty)
        #expect(await fixture.device.assertions.isEmpty)
        #expect(await fixture.server.requests.isEmpty)
    }

    private static func enroll(_ fixture: ActivityRelayFixture, ordinary: Bool) async throws {
        if ordinary {
            _ = try await fixture.client.register(fixture.ordinary)
        } else {
            _ = try await fixture.client.performActivityOperation(.discover, input: fixture.input)
        }
    }

    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
