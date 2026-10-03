import AppKit
import ConcurrencyExtras
import CryptoKit
import Foundation
import Security
import Testing
@testable import OpenClaw
@testable import OpenClawKit

private enum RenewalCertificates {
    /// Public synthetic certificates only. Trust anchors and verification time are
    /// scoped to each SecTrust; no Keychain or system trust settings are changed.
    static let root =
        Data(
            base64Encoded: "MIIBOzCB4gIJAMzsRkLwnKG3MAoGCCqGSM49BAMCMCYxJDAiBgNVBAMMG09wZW5DbGF3IFJlbmV3YWwgRml4dHVyZSBDQTAeFw0yNjEwMDMxNzExMjZaFw0zNjA5MzAxNzExMjZaMCYxJDAiBgNVBAMMG09wZW5DbGF3IFJlbmV3YWwgRml4dHVyZSBDQTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABMTjTACpW2EYz0W9zkg3tNv8d5HkDSSCx5pUgnR9zQX8O5xfA6IjvEyKYmQMq8dghroSKxeKW6REB0MDo908APYwCgYIKoZIzj0EAwIDSAAwRQIhAI/0lA0SvMhrLd4aUq2CTmU60j0zqBUf/LxYP6xPKBQSAiB7baSZ+uBZu7+9SBwCHCCldjx+EtTJFRxDrBlDhm+OfA==")!
    static let old =
        Data(
            base64Encoded: "MIIBsDCCAVegAwIBAgIBATAKBggqhkjOPQQDAjAmMSQwIgYDVQQDDBtPcGVuQ2xhdyBSZW5ld2FsIEZpeHR1cmUgQ0EwHhcNMjYxMDAzMTcxMTI2WhcNMjcxMDAzMTcxMTI2WjAeMRwwGgYDVQQDDBNnYXRld2F5LmV4YW1wbGUuY29tMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEdgva0L+9BLTngMYjt0NGGL6t8AJoaO6zSMPHn7TiVHW3GR1UwjDK9jBF/ZqLSOqr/U8mazVayzqueI7/A+9u0aN+MHwwDAYDVR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCB4AwEwYDVR0lBAwwCgYIKwYBBQUHAwEwRwYDVR0RBEAwPoITZ2F0ZXdheS5leGFtcGxlLmNvbYIWZ2F0ZXdheS5leGFtcGxlLnRzLm5ldIIJbG9jYWxob3N0hwR/AAABMAoGCCqGSM49BAMCA0cAMEQCIBJqtf9DnhqRTytUHHTgW8cKZaV58tZ8WdbTMmZMOt/2AiB8UtQYgX2U2gqtp7Grg8S/TYUQM5EMElGt9VcPnpmn7Q==")!
    static let renewed =
        Data(
            base64Encoded: "MIIBsDCCAVegAwIBAgIBAjAKBggqhkjOPQQDAjAmMSQwIgYDVQQDDBtPcGVuQ2xhdyBSZW5ld2FsIEZpeHR1cmUgQ0EwHhcNMjYxMDAzMTcxMTI2WhcNMjcxMDAzMTcxMTI2WjAeMRwwGgYDVQQDDBNnYXRld2F5LmV4YW1wbGUuY29tMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAElTrGnEXb1uO63DRZy/Sud8vy7K/mQUhNjwX6DYvfnQt7EMDCJNOUTP5xgKHONNwV0AQJsmXnGXzoT28op+fOxKN+MHwwDAYDVR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCB4AwEwYDVR0lBAwwCgYIKwYBBQUHAwEwRwYDVR0RBEAwPoITZ2F0ZXdheS5leGFtcGxlLmNvbYIWZ2F0ZXdheS5leGFtcGxlLnRzLm5ldIIJbG9jYWxob3N0hwR/AAABMAoGCCqGSM49BAMCA0cAMEQCIDas7K8zVl1/iw2VqXuu8Pzrg7eIP0d9p+QhY8j27qASAiA24QFi7LevZqUb/Gu8jfAPrWyzBsDkHYPgw5cJJLKJzA==")!
    static let verificationDate = Date(timeIntervalSince1970: 1_791_133_886)

    static func fingerprint(_ certificate: Data) -> String {
        SHA256.hash(data: certificate).map { String(format: "%02x", $0) }.joined()
    }

    static func trust(
        certificate: Data = RenewalCertificates.renewed,
        root: Data = RenewalCertificates.root,
        trusted: Bool = true,
        expired: Bool = false,
        verificationDate: Date = RenewalCertificates.verificationDate) throws -> SecTrust
    {
        let leaf = try #require(SecCertificateCreateWithData(nil, certificate as CFData))
        let anchor = try #require(SecCertificateCreateWithData(nil, root as CFData))
        var trust: SecTrust?
        try #require(SecTrustCreateWithCertificates(
            [leaf, anchor] as CFArray, SecPolicyCreateBasicX509(), &trust) == errSecSuccess)
        let result = try #require(trust)
        try #require(SecTrustSetAnchorCertificates(result, (trusted ? [anchor] : []) as CFArray) == errSecSuccess)
        try #require(SecTrustSetAnchorCertificatesOnly(result, true) == errSecSuccess)
        try #require(SecTrustSetNetworkFetchAllowed(result, false) == errSecSuccess)
        let date = expired ? Date(timeIntervalSince1970: 2_208_988_800) : verificationDate
        try #require(SecTrustSetVerifyDate(result, date as CFDate) == errSecSuccess)
        return result
    }
}

private final class RenewalConnectionFixture: @unchecked Sendable {
    let url: URL
    let storeKey: String
    let configuredFingerprint: String?
    let primaryRevision: UInt64?
    let requests = LockIsolated<[String]>([])
    let failures = LockIsolated<[GatewayTLSValidationFailure]>([])
    let beforeTrust: (@Sendable () async -> Void)?
    let certificate: Data
    let root: Data
    let trusted: Bool
    let expired: Bool
    let verificationDate: Date
    let token = LockIsolated("synthetic-renewal-token")

    init(
        url: URL,
        configuredFingerprint: String? = nil,
        primaryRevision: UInt64? = nil,
        certificate: Data = RenewalCertificates.renewed,
        root: Data = RenewalCertificates.root,
        trusted: Bool = true,
        expired: Bool = false,
        verificationDate: Date = RenewalCertificates.verificationDate,
        beforeTrust: (@Sendable () async -> Void)? = nil)
    {
        self.url = url
        self.storeKey = primaryRevision == nil ? "renewal-\(UUID().uuidString)" : GatewayTLSRoute.storeKey(for: url)
        self.primaryRevision = primaryRevision
        self.configuredFingerprint = configuredFingerprint
        self.certificate = certificate
        self.root = root
        self.trusted = trusted
        self.expired = expired
        self.verificationDate = verificationDate
        self.beforeTrust = beforeTrust
    }

    func endpoint() -> GatewayConnection.EndpointSnapshot {
        GatewayConnection.EndpointSnapshot(
            config: (self.url, self.token.value, nil),
            tls: GatewayTLSRoute.resolve(
                url: self.url, connectionMode: .remote,
                configuredFingerprint: self.configuredFingerprint, storeKey: self.storeKey),
            routeAuthority: nil,
            deviceAuthGatewayID: self.primaryRevision == nil ? self.storeKey : nil,
            revision: self.primaryRevision)
    }

    func connection(beforeEndpoint: @escaping @Sendable () async -> Void = {}) -> GatewayConnection {
        GatewayConnection(
            endpointProvider: { await beforeEndpoint()
                return self.endpoint()
            },
            supportsSharedEndpointRecovery: false,
            activationBindingKeyProvider: { nil },
            sessionProvider: { route in
                route.map { self.sessionBox(route: $0) }
            })
    }

    func sessionBox(route: GatewayTLSRoute) -> WebSocketSessionBox {
        let pinning = GatewayTLSPinningSession(params: route.params)
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { socket, message, index in
                guard index > 0,
                      let method = GatewayWebSocketTestSupport.requestMethod(from: message),
                      let id = GatewayWebSocketTestSupport.requestID(from: message)
                else { return }
                self.requests.withValue { $0.append(method) }
                socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
            }, receiveHook: { socket, index in
                if index == 0 {
                    await self.beforeTrust?()
                    let trust = try RenewalCertificates.trust(
                        certificate: self.certificate, root: self.root,
                        trusted: self.trusted, expired: self.expired,
                        verificationDate: self.verificationDate)
                    guard pinning.validateServerTrust(trust, for: self.url) else {
                        let failure = try #require(pinning.consumeLastTLSFailure())
                        self.failures.withValue { $0.append(failure) }
                        throw GatewayTLSValidationError(failure: failure, context: "renewal fixture")
                    }
                    return .data(GatewayWebSocketTestSupport.connectChallengeData())
                }
                return .data(GatewayWebSocketTestSupport.connectOkData(
                    id: socket.snapshotConnectRequestID() ?? "connect"))
            })
        })
        return WebSocketSessionBox(session: session)
    }

    func learnOriginalCertificate(legacy: Bool = false) throws {
        if legacy {
            let fixture = try #require(GatewayTLSStoreFixture.current)
            fixture.seed(
                account: self.storeKey,
                data: Data(RenewalCertificates.fingerprint(RenewalCertificates.old).utf8))
        } else {
            let trust = try RenewalCertificates.trust(certificate: RenewalCertificates.old)
            let session = GatewayTLSPinningSession(params: GatewayTLSParams(
                required: true, expectedFingerprint: nil, allowTOFU: true, storeKey: self.storeKey))
            try #require(session.validateServerTrust(trust, for: self.url))
        }
        try #require(GatewayTLSStore.loadFingerprint(stableID: self.storeKey) ==
            RenewalCertificates.fingerprint(RenewalCertificates.old))
    }
}

private func withRenewalIdentity(
    isolation: isolated (any Actor)? = #isolation,
    _ operation: () async throws -> Void) async throws
{
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    try await DeviceIdentityStore.withStateDirectory(directory, operation: operation)
}

@Suite(.gatewayTLSStoreIsolated, .testWaitLimit)
struct GatewayCertificateRenewalTests {
    @Test(arguments: ["gateway.example.com", "gateway.example.ts.net"], [false, true])
    func `cold dashboard repairs a trusted renewal including legacy learned pins`(
        host: String, legacy: Bool) async throws
    {
        try await withRenewalIdentity {
            let fixture = try RenewalConnectionFixture(url: #require(URL(string: "wss://\(host)")))
            try fixture.learnOriginalCertificate(legacy: legacy)
            let connection = fixture.connection()
            let result: Result<Void, Error>
            do {
                #expect(try await connection.controlUiBrowserIdentityURL(config: fixture.endpoint().config) == nil)
                let lease = try #require(await connection.captureServerLease())
                #expect(lease.route.tls?.params.expectedFingerprint == RenewalCertificates
                    .fingerprint(fixture.certificate))
                #expect(GatewayTLSStore.loadFingerprint(stableID: fixture.storeKey) ==
                    RenewalCertificates.fingerprint(fixture.certificate))
                #expect(fixture.failures.value.count == 1)
                #expect(fixture.failures.value.first?.systemTrustOk == true)
                #expect(fixture.requests.value == ["health"])
                result = .success(())
            } catch { result = .failure(error) }
            await connection.shutdown()
            try result.get()
        }
    }

    @Test(arguments: ["strict", "untrusted", "expired", "wrong-host"])
    func `renewal never replaces a strict pin or an invalid certificate`(scenario: String) async throws {
        try await withRenewalIdentity {
            let url = try #require(URL(string: scenario == "wrong-host"
                    ? "wss://wrong.example.com" : "wss://gateway.example.com"))
            let old = RenewalCertificates.fingerprint(RenewalCertificates.old)
            let fixture = RenewalConnectionFixture(
                url: url, configuredFingerprint: scenario == "strict" ? old : nil,
                trusted: scenario != "untrusted", expired: scenario == "expired")
            // A previously learned endpoint may now present a wrong-host certificate.
            GatewayTLSStore.saveFingerprint(old, stableID: fixture.storeKey)
            let connection = fixture.connection()
            await #expect(throws: GatewayTLSValidationError.self) {
                try await connection.controlUiBrowserIdentityURL(config: fixture.endpoint().config)
            }
            #expect(GatewayTLSStore.loadFingerprint(stableID: fixture.storeKey) == old)
            #expect(fixture.requests.value.isEmpty)
            #expect(fixture.failures.value.first?.systemTrustOk == (scenario == "strict"))
            await connection.shutdown()
        }
    }

    @Test
    func `route-bound requests do not acquire certificate repair or retries`() async throws {
        try await withRenewalIdentity {
            let fixture = try RenewalConnectionFixture(url: #require(URL(string: "wss://gateway.example.com")))
            try fixture.learnOriginalCertificate()
            let connection = fixture.connection()
            let route = try await connection.captureRequiredRoute()
            await #expect(throws: GatewayTLSValidationError.self) {
                try await connection.request(method: "config.set", params: nil, ifCurrentRoute: route)
            }
            #expect(GatewayTLSStore.loadFingerprint(stableID: fixture.storeKey) ==
                RenewalCertificates.fingerprint(RenewalCertificates.old))
            #expect(fixture.requests.value.isEmpty)
            await connection.shutdown()
        }
    }

    @Test(arguments: ["cancel", "shutdown", "credentials", "newer-pin"])
    func `late renewal cannot repair retired work`(retirement: String) async throws {
        try await withRenewalIdentity {
            let entered = AsyncTestGate()
            let released = AsyncTestGate()
            let fixture = try RenewalConnectionFixture(
                url: #require(URL(string: "wss://gateway.example.com")),
                beforeTrust: { entered.open()
                    await released.wait()
                })
            try fixture.learnOriginalCertificate()
            let connection = fixture.connection()
            let config = fixture.endpoint().config
            let request = Task { try await connection.controlUiBrowserIdentityURL(config: config) }
            await entered.wait()
            switch retirement {
            case "cancel": request.cancel()
            case "shutdown": await connection.shutdown()
            case "credentials": fixture.token.withValue { $0 = "replacement-credential" }
            case "newer-pin": GatewayTLSStore.saveFingerprint("a-newer-pin", stableID: fixture.storeKey)
            default: Issue.record("unknown retirement")
            }
            released.open()
            let result = await request.result
            if case .success = result { Issue.record("retired renewal unexpectedly succeeded") }
            #expect(fixture.requests.value.isEmpty)
            #expect(GatewayTLSStore.loadFingerprint(stableID: fixture.storeKey) ==
                (retirement == "newer-pin" ? "a-newer-pin" : RenewalCertificates.fingerprint(RenewalCertificates.old)))
            await connection.shutdown()
        }
    }

    @Test
    func `cancellation during repair store read cannot replace the learned pin`() async throws {
        try await withRenewalIdentity {
            let armed = LockIsolated(false)
            let reads = LockIsolated(0)
            let cancelled = LockIsolated(false)
            let requestHandle = LockIsolated<Task<URL?, Error>?>(nil)
            let fixture = try RenewalConnectionFixture(
                url: #require(URL(string: "wss://gateway.example.com")),
                beforeTrust: { armed.withValue { $0 = true } })
            try fixture.learnOriginalCertificate()
            let connection = fixture.connection()
            let original = GatewayTLSStore.keychainOperations
            let operations = GatewayTLSKeychainOperations(
                copyMatching: { query, result in
                    // After the TLS failure, the endpoint owner rereads once. The
                    // next read belongs to repair, after ownership validation.
                    if armed.value, reads.withValue({ $0 += 1
                        return $0 }) == 2
                    {
                        cancelled.withValue { $0 = true }
                        requestHandle.value?.cancel()
                    }
                    return original.copyMatching(query, result)
                },
                add: original.add, update: original.update, delete: original.delete)
            let start = AsyncTestGate()
            let request = Task {
                await start.wait()
                return try await GatewayTLSStore.$keychainOperations.withValue(operations) {
                    try await connection.controlUiBrowserIdentityURL(config: fixture.endpoint().config)
                }
            }
            requestHandle.withValue { $0 = request }
            start.open()
            let result = await request.result
            requestHandle.withValue { $0 = nil }
            if case .success = result { Issue.record("cancelled repair unexpectedly succeeded") }
            #expect(cancelled.value)
            #expect(fixture.requests.value.isEmpty)
            #expect(GatewayTLSStore.loadFingerprint(stableID: fixture.storeKey) ==
                RenewalCertificates.fingerprint(RenewalCertificates.old))
            await connection.shutdown()
        }
    }

    @Test
    func `cold preflight does not connect with superseding credentials`() async throws {
        try await withRenewalIdentity {
            let entered = AsyncTestGate()
            let released = AsyncTestGate()
            let reads = LockIsolated(0)
            let fixture = try RenewalConnectionFixture(url: #require(URL(string: "wss://gateway.example.com")))
            try fixture.learnOriginalCertificate()
            let connection = fixture.connection(beforeEndpoint: {
                if reads.withValue({ $0 += 1
                    return $0 }) == 3
                {
                    entered.open()
                    await released.wait()
                }
            })
            let config = fixture.endpoint().config
            let request = Task { try await connection.controlUiBrowserIdentityURL(config: config) }
            await entered.wait()
            fixture.token.withValue { $0 = "superseding-credential" }
            released.open()
            let result = await request.result
            if case .success = result { Issue.record("superseded preflight unexpectedly succeeded") }
            #expect(fixture.failures.value.isEmpty)
            #expect(fixture.requests.value.isEmpty)
            #expect(GatewayTLSStore.loadFingerprint(stableID: fixture.storeKey) ==
                RenewalCertificates.fingerprint(RenewalCertificates.old))
            await connection.shutdown()
        }
    }

    @Test
    func `concurrent connections accept the same trusted renewal`() async throws {
        try await withRenewalIdentity {
            let entered = AsyncTestGate()
            let released = AsyncTestGate()
            let handshakes = LockIsolated(0)
            let fixture = try RenewalConnectionFixture(
                url: #require(URL(string: "wss://gateway.example.com")),
                beforeTrust: {
                    if handshakes.withValue({ $0 += 1
                        return $0 }) == 1
                    {
                        entered.open()
                        await released.wait()
                    }
                })
            try fixture.learnOriginalCertificate()
            let first = fixture.connection()
            let second = fixture.connection()
            let delayed = Task { try await first.acquireServerLease() }
            defer { released.open()
                delayed.cancel()
            }
            await entered.wait()
            let result: Result<Void, Error>
            do {
                let secondLease = try await second.acquireServerLease()
                released.open()
                let firstLease = try await delayed.value
                #expect(firstLease.route.tls == secondLease.route.tls)
                #expect(GatewayTLSStore.loadFingerprint(stableID: fixture.storeKey) ==
                    RenewalCertificates.fingerprint(fixture.certificate))
                #expect(fixture.requests.value == ["health", "health"])
                result = .success(())
            } catch {
                released.open()
                delayed.cancel()
                _ = await delayed.result
                result = .failure(error)
            }
            await first.shutdown()
            await second.shutdown()
            try result.get()
        }
    }

    @Test(arguments: [true, false])
    func `a losing renewal CAS accepts only the identical winner`(identical: Bool) async throws {
        try await withRenewalIdentity {
            let fixture = try RenewalConnectionFixture(url: #require(URL(string: "wss://gateway.example.com")))
            try fixture.learnOriginalCertificate()
            let connection = fixture.connection()
            let winner = identical ? RenewalCertificates.fingerprint(fixture.certificate) : String(
                repeating: "b",
                count: 64)
            let injected = LockIsolated(false)
            let original = GatewayTLSStore.keychainOperations
            let operations = GatewayTLSKeychainOperations(
                copyMatching: original.copyMatching,
                add: original.add,
                update: { query, changes in
                    let inject = injected.withValue { value in
                        guard !value else { return false }
                        value = true
                        return true
                    }
                    // Another writer commits between the read and conditional update.
                    // Keep the real store's comparison behavior; do not mock its result.
                    if inject { GatewayTLSStore.saveFingerprint(winner, stableID: fixture.storeKey) }
                    return original.update(query, changes)
                },
                delete: original.delete)
            let result: Result<Void, Error>
            do {
                _ = try await GatewayTLSStore.$keychainOperations.withValue(operations) {
                    try await connection.controlUiBrowserIdentityURL(config: fixture.endpoint().config)
                }
                #expect(identical)
                result = .success(())
            } catch {
                if identical { result = .failure(error) }
                else {
                    #expect(error is GatewayTLSValidationError)
                    result = .success(())
                }
            }
            #expect(injected.value)
            #expect(GatewayTLSStore.loadFingerprint(stableID: fixture.storeKey) == winner)
            #expect(fixture.requests.value == (identical ? ["health"] : []))
            await connection.shutdown()
            try result.get()
        }
    }

    @Test
    func `ordinary reconnect renews the learned certificate without an opt in`() async throws {
        try await withRenewalIdentity {
            let fixture = try RenewalConnectionFixture(url: #require(URL(string: "wss://gateway.example.com")))
            try fixture.learnOriginalCertificate()
            let connection = fixture.connection()
            let result: Result<Void, Error>
            do {
                await connection.shutdown()
                let lease = try await connection.acquireServerLease()
                #expect(lease.route.tls?.params.expectedFingerprint == RenewalCertificates
                    .fingerprint(fixture.certificate))
                #expect(fixture.requests.value == ["health"])
                #expect(fixture.failures.value.count == 1)
                result = .success(())
            } catch { result = .failure(error) }
            await connection.shutdown()
            try result.get()
        }
    }

    @Test(arguments: [
        "current", "revoked", "refreshed", "credentials", "revoked-after-failure",
        "cancel-after-failure", "same-renewal-after-failure", "other-pin-after-failure",
    ])
    @MainActor
    func `companion renewal writes only for its current connection attempt`(scenario: String) async throws {
        let entered = AsyncTestGate()
        let release = AsyncTestGate()
        let endpointRead = AsyncTestGate()
        let endpointRelease = AsyncTestGate()
        let fixture = RenewalConnectionFixture(
            url: try #require(URL(string: "wss://gateway.example.com")),
            beforeTrust: { entered.open(); await release.wait() })
        try fixture.learnOriginalCertificate()
        let endpoint = fixture.endpoint()
        let tls = try #require(endpoint.tls)
        let session = GatewayNodeSession()
        let suite = "NodeRenewalTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let coordinator = MacNodeModeCoordinator(
            session: session,
            runtime: MacNodeRuntime(computerControlEnabled: { false }),
            endpointProvider: {
                if scenario.hasSuffix("after-failure") {
                    endpointRead.open()
                    await endpointRelease.wait()
                }
                return fixture.endpoint()
            },
            presenceReporter: MacNodePresenceReporter(reportingEnabled: false),
            desktopAvailability: MacDesktopAvailabilityCoordinator(defaults: defaults),
            channelStatus: MacNodeChannelStatusStore(),
            notificationCenter: NotificationCenter(),
            initialPaused: false,
            initialComputerControlEnabled: false,
            initialComputerControlProvider: .peekaboo)
        let attempt = Task {
            try await coordinator.connectForTesting(
                endpoint: endpoint,
                sessionBox: fixture.sessionBox(route: tls))
        }
        await entered.wait()
        switch scenario {
        case "revoked": coordinator.enqueueRouteInvalidationForTesting()
        case "refreshed": coordinator.refreshForTesting(isPaused: false, computerControlEnabled: false)
        case "credentials": fixture.token.withValue { $0 = "superseding-node-token" }
        default: break
        }
        release.open()
        if scenario.hasSuffix("after-failure") {
            await endpointRead.wait()
            switch scenario {
            case "cancel-after-failure": attempt.cancel()
            case "same-renewal-after-failure":
                GatewayTLSStore.saveFingerprint(
                    RenewalCertificates.fingerprint(RenewalCertificates.renewed), stableID: fixture.storeKey)
            case "other-pin-after-failure":
                GatewayTLSStore.saveFingerprint("newer-node-pin", stableID: fixture.storeKey)
            default: coordinator.enqueueRouteInvalidationForTesting()
            }
            endpointRelease.open()
        }
        let result = await attempt.result
        await coordinator.stopAndWait()
        if scenario == "current" || scenario == "same-renewal-after-failure" {
            #expect(try result.get() == false)
            #expect(GatewayTLSStore.loadFingerprint(stableID: fixture.storeKey) ==
                RenewalCertificates.fingerprint(RenewalCertificates.renewed))
        } else {
            if case .success = result { Issue.record("retired node attempt repaired TLS") }
            #expect(GatewayTLSStore.loadFingerprint(stableID: fixture.storeKey) ==
                (scenario == "other-pin-after-failure"
                    ? "newer-node-pin" : RenewalCertificates.fingerprint(RenewalCertificates.old)))
        }
        if scenario != "revoked" {
            #expect(fixture.failures.value.first?.systemTrustOk == true)
        }
    }

    @Test
    @MainActor
    func `Switch Gateway uses the renewed pin for the actual dashboard window`() async throws {
        try await TestIsolation.withIsolatedState {
            try await withRenewalIdentity {
                _ = AppKitTestSupport.application
                let identity = try await DashboardTLSFixture()
                let server = try await DashboardHTTPFixture.start(tlsIdentity: identity.identity)
                defer { server.stop() }
                let url = try #require(URL(string: "wss://localhost:\(server.port)/"))
                let fixture = RenewalConnectionFixture(
                    url: url,
                    certificate: identity.certificate,
                    root: identity.certificate, verificationDate: Date())
                try fixture.learnOriginalCertificate()
                let connection = fixture.connection()
                let initialServer = try await DashboardHTTPFixture.start()
                defer { initialServer.stop() }
                let initial = try DashboardIdentityFixture(announcement: nil, source: GatewayConnectionEndpointSource(
                    endpoint: .init(config: (initialServer.websocketURL(), "initial-token", nil), routeAuthority: nil)))
                let suiteName = "GatewayCertificateRenewalTests.\(UUID().uuidString)"
                let defaults = try #require(UserDefaults(suiteName: suiteName))
                defer { defaults.removePersistentDomain(forName: suiteName) }
                let target = DashboardGatewayTarget.profile("renewed")
                let manager = DashboardManager._testMake(
                    selection: MacGatewaySelectionPreferences(defaults: defaults),
                    connectionProvider: { $0 == target ? connection : initial.connection },
                    browserIdentityURLProvider: nil,
                    legacyCredentialsProvider: { selected, endpoint in
                        if selected == target {
                            return try await connection.controlUiLegacyCredentials(endpoint: endpoint)
                        }
                        return .init(credentials: [:], isCurrent: { true }, waitForInvalidation: nil)
                    },
                    automaticGatewayProfileRefreshEnabled: false,
                    profileEndpointProvider: { $0 == "renewed" ? fixture.endpoint() : initial.source.snapshot() })
                let result: Result<Void, Error>
                do {
                    await manager._testOpenWindow(for: .profile("initial"))
                    let original = try #require(manager._testAuxiliaryWindows().first?.controller)
                    let window = try #require(original.window)
                    _ = await manager.switchTarget(target, in: original)?.value
                    let current = try #require(manager._testAuxiliaryWindows().first)
                    try #require(current.target == target)
                    #expect(current.controller.window === window)
                    try #require(current.controller.documentHost.tlsParams?.expectedFingerprint ==
                        RenewalCertificates.fingerprint(identity.certificate))
                    #expect(current.controller.currentURL.host == "localhost")
                    try await DashboardTestWait.document(current.controller, "renewed gateway dashboard") {
                        current.controller.webView.url?.port == Int(server.port)
                    }
                    #expect(try await current.controller.webView
                        .evaluateJavaScript("document.body.textContent") as? String == "Ready")
                    #expect(GatewayTLSStore.loadFingerprint(stableID: fixture.storeKey) ==
                        RenewalCertificates.fingerprint(identity.certificate))
                    result = .success(())
                } catch { result = .failure(error) }
                manager.close()
                await connection.shutdown()
                await initial.connection.shutdown()
                try result.get()
            }
        }
    }

    @Test
    @MainActor
    func `primary endpoint notifications renew the pin without losing the route revision`() async throws {
        try await TestIsolation.withIsolatedState {
            try await withRenewalIdentity {
                _ = AppKitTestSupport.application
                let identity = try await DashboardTLSFixture()
                let server = try await DashboardHTTPFixture.start(tlsIdentity: identity.identity)
                defer { server.stop() }
                let url = try #require(URL(string: "wss://localhost:\(server.port)/"))
                let fixture = RenewalConnectionFixture(
                    url: url, primaryRevision: 42,
                    certificate: identity.certificate,
                    root: identity.certificate, verificationDate: Date())
                try fixture.learnOriginalCertificate()
                let connection = fixture.connection()
                let initial = try await DashboardHTTPFixture.start()
                defer { initial.stop() }
                let suiteName = "PrimaryRenewalTests.\(UUID().uuidString)"
                let defaults = try #require(UserDefaults(suiteName: suiteName))
                defer { defaults.removePersistentDomain(forName: suiteName) }
                let manager = DashboardManager._testMake(
                    selection: MacGatewaySelectionPreferences(defaults: defaults),
                    connectionProvider: { _ in connection },
                    browserIdentityURLProvider: nil,
                    legacyCredentialsProvider: { _, endpoint in
                        try await connection.controlUiLegacyCredentials(endpoint: endpoint)
                    },
                    automaticGatewayProfileRefreshEnabled: false,
                    primaryEndpointProvider: { _ in
                        let endpoint = fixture.endpoint()
                        // Immediate primary configuration has no notification revision.
                        return .init(config: endpoint.config, tls: endpoint.tls, routeAuthority: nil)
                    })
                let original = DashboardWindowController(
                    url: initial.url(),
                    auth: DashboardWindowAuth(
                        gatewayUrl: initial.websocketURL().absoluteString,
                        token: "initial",
                        password: nil),
                    websiteDataStore: .nonPersistent(),
                    windowAutosaveName: "",
                    requestBrowserProfileImportOffer: { _ in false })
                manager._testSetController(original)
                manager._testSetMainTarget(.primary)
                original.show()
                let result: Result<Void, Error>
                do {
                    let window = try #require(original.window)
                    await manager.handleEndpointState(.ready(
                        mode: .remote, url: url, token: fixture.token.value, password: nil, routeRevision: 42))
                    let current = try #require(manager._testController())
                    try #require(!current.isShowingFailurePage)
                    try #require(current.documentHost.tlsParams?.expectedFingerprint ==
                        RenewalCertificates.fingerprint(identity.certificate))
                    #expect(current.window === window)
                    try await DashboardTestWait.document(current, "primary renewed dashboard") {
                        current.webView.url?.port == Int(server.port)
                    }
                    #expect(try await current.webView
                        .evaluateJavaScript("document.body.textContent") as? String == "Ready")
                    #expect(await connection.captureServerLease()?.endpointRevision == 42)
                    result = .success(())
                } catch { result = .failure(error) }
                manager.close()
                await connection.shutdown()
                try result.get()
            }
        }
    }
}
