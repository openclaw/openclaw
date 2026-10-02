import CryptoKit
import Foundation
import Security
import Testing
@testable import OpenClawKit
#if os(macOS)
import Network
#endif

private let gatewayTLSTestCertificateDER =
    Data(
        base64Encoded: "MIIDWDCCAkCgAwIBAgIUauCyPszeo0mp5lDu/ldJ80BblyEwDQYJKoZIhvcNAQELBQAwHTEbMBkGA1UEAwwST3BlbkNsYXcgVGVzdCBSb290MB4XDTI2MDkxNjIzNTI0OFoXDTI3MDkxNjIzNTI0OFowGjEYMBYGA1UEAwwPZ2F0ZXdheS5leGFtcGxlMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwDr4MWE7mhxcr7bDk0vAKmoh+7tdNx+xzwewikHjijfVeLR7ziIQ15OpCTU977vaCe/D9eb3sOzihHxqwEpCd1qSbJT47Me3lC2r1j22GVZQ/lxh/3Pb/KHLJs6rA0Ts6Qvcn+AN9ZMqlUMXP33ZrR69y7dhZmywAFH0LCJzEdKlLw53C5lTVsXwXntE9ARiZbnUPQANvRZP0ydRKaGzWKaF50xdaUwnTQSLWkF5H6QxlXohlN5l3INrOLNtHu5VxSqvdwJ5I/OeOPtyx3WoCcxd3TBpAOha0rPMCO4G0d6sp6nu6gP9aTTUyfcYC0KOnX+BAMqvEQCwMJZCQ5s9wwIDAQABo4GSMIGPMAwGA1UdEwEB/wQCMAAwDgYDVR0PAQH/BAQDAgWgMBMGA1UdJQQMMAoGCCsGAQUFBwMBMBoGA1UdEQQTMBGCD2dhdGV3YXkuZXhhbXBsZTAdBgNVHQ4EFgQU4nDtoZ7Mi1ucqIfG++KYKDa+weQwHwYDVR0jBBgwFoAUdnh7Zg6UOXq6ezrHR8XvyymGbIMwDQYJKoZIhvcNAQELBQADggEBAJ60ChP9kjlmUyPLkQO1g8k95TpICNXw19KZF5NhQn4+60ZkvcBQ1PlAQP4j1ry2I7tGLoV2RGl0GA347DKYvOE9OAJPT7fRHPq9CGqRzJOD1qXLXjaP6qszGxTu88J3WhNsXIC5sNI7Cc8ba7ybrEg4Q+Tyo4sB+c53/AtHnDdFbprOwZfyR55wnY1pTdPcZ4QBXwRPuV+sHVvXetkgApKuyXAbIGOpj4xGB2Lvvk8QKjsOvdvv3dsUwAKnyzCWmjKS8I168227W5ga9H1twNm8RoQnQLOfUiLFcaWtFDiFRtcXc+7pK1ER1kHus0rprzTF5e6UM0cVTIVOyIMp3Ow=")!

private let gatewayTLSTestRootCertificateDER =
    Data(
        base64Encoded: "MIIDLjCCAhagAwIBAgIUZm9nSb93f+rEJJweoxU/auE9A3UwDQYJKoZIhvcNAQELBQAwHTEbMBkGA1UEAwwST3BlbkNsYXcgVGVzdCBSb290MB4XDTI2MDkxNjIzNTI0OFoXDTM2MDkxMzIzNTI0OFowHTEbMBkGA1UEAwwST3BlbkNsYXcgVGVzdCBSb290MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApWsa86zBy3I9AZ5m533iV1JLhFUtRYEHtF3Mq/00UrvZZlmfceY4bJUp38tX+UnT9sx+ilD45+VOl8VjSXmLtMo74TNjBQEn79SYbwaHMkLItYomwO+lgF9tcAjJM4MS3bQ1tK40VqxfuKtTKL1ZsqUZW1zHZ8Tf2dom+jLB8yKYelY35IxpNVBelzbiGUXw5OW8oGDqKjE9eezDpDpd4Bfgt/l8PPWlhXK2PLwNXZtCMUFPFt0ZOeo1o9Bal0cp/R46DyV1OvGkpL9RIyHbXfQJQZvugV2whWVsxHAM7cINV7rmOdf9ObbQPogTPLx08ZFDFv/MVjH5RAqYWz3LuwIDAQABo2YwZDAdBgNVHQ4EFgQUdnh7Zg6UOXq6ezrHR8XvyymGbIMwHwYDVR0jBBgwFoAUdnh7Zg6UOXq6ezrHR8XvyymGbIMwEgYDVR0TAQH/BAgwBgEB/wIBADAOBgNVHQ8BAf8EBAMCAQYwDQYJKoZIhvcNAQELBQADggEBAKPVh4LuWJf4rowdUkEEWu1fa/QBqK2/gLMdOryxkR9es2FU2LdL744KoBND89+fuisFa7gDxDCZBrJhBkDthjOnerl9Se/qpOfuODgfvSMF4Qkv97L52rhR7djV5+8LJYrGXBSbeRIMnsdOOyn1rH5GugLSCakLfmfkTIGmTwK/l7zDw7DcRNcYdLruE8wSccIDnPLKIEpyYeC2uLvLKigAV7gOjmVzObaSwKSzUaYAjFdi+zMxpHT8l8gXEfpqN+g5SgG/yRFWLy12lWNO4YXwt0jgTRqljouj1/SdozeMQCLKfoLrjDk8wlcplfSpKsJPtGVp81hAnEY9akYrw7s=")!

private func gatewayTLSTestTrust(systemTrusted: Bool) throws -> SecTrust {
    let certificate = try #require(SecCertificateCreateWithData(nil, gatewayTLSTestCertificateDER as CFData))
    let rootCertificate = try #require(
        SecCertificateCreateWithData(nil, gatewayTLSTestRootCertificateDER as CFData))
    let policy = systemTrusted
        ? SecPolicyCreateBasicX509()
        : SecPolicyCreateSSL(true, "gateway.example" as CFString)
    var trust: SecTrust?
    let certificateChain = [certificate, rootCertificate]
    try #require(SecTrustCreateWithCertificates(certificateChain as CFArray, policy, &trust) == errSecSuccess)
    let trustValue = try #require(trust)
    // Both trust outcomes use explicit fixture anchors, without default roots or issuer downloads.
    let anchors = systemTrusted ? [rootCertificate] : []
    try #require(SecTrustSetAnchorCertificates(trustValue, anchors as CFArray) == errSecSuccess)
    try #require(SecTrustSetAnchorCertificatesOnly(trustValue, true) == errSecSuccess)
    try #require(SecTrustSetNetworkFetchAllowed(trustValue, false) == errSecSuccess)
    return trustValue
}

@Suite(.gatewayTLSStoreIsolated)
struct GatewayTLSPinningTests {
    #if os(macOS)
    @Test @MainActor
    func `HTTP rejection belongs to its request and cannot turn bare cancellation into TLS failure`() async throws {
        let identity = try GatewayTLSHTTPFixture.makeIdentity()
        let server = try await GatewayTLSHTTPFixture.start(identity: identity.value)
        defer { server.stop() }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [GatewayTLSCancelledProtocol.self]
        let transport = GatewayTLSPinningSession(
            configuration: configuration,
            params: .init(required: true, expectedFingerprint: nil, allowTOFU: false, storeKey: nil),
            allowsRedirects: false,
            allowsStoredCredentials: false)
        defer { transport.finishTasksAndInvalidate() }
        let failure = try await Self.rejection(transport, url: server.url())
        #expect(failure.kind == .untrustedCertificate)
        #expect(!failure.systemTrustOk)
        #expect(failure.host == "localhost")
        #expect(failure.port == Int(server.port))
        #expect(transport.consumeLastTLSFailure() == nil)

        do {
            _ = try await transport.data(
                for: URLRequest(url: server.url("/bare-cancellation")),
                maximumBytes: 2)
            Issue.record("Bare cancellation unexpectedly succeeded")
        } catch {
            let cancellation = try #require(error as? URLError)
            #expect(cancellation.code == .cancelled)
        }
        #expect(transport.consumeLastTLSFailure() == nil)
    }

    @Test(arguments: [false, true]) @MainActor
    func `overlapping HTTP accept and rejections preserve request authority and pending WS failure`(
        reverse: Bool) async throws
    {
        let identity = try GatewayTLSHTTPFixture.makeIdentity()
        let accepted = try await GatewayTLSHTTPFixture.start(identity: identity.value, holdBody: true)
        let rejected = try await GatewayTLSHTTPFixture.start(identity: identity.value)
        let other = try await GatewayTLSHTTPFixture.start(identity: identity.value)
        defer {
            accepted.stop()
            rejected.stop()
            other.stop()
        }
        let transport = GatewayTLSPinningSession(
            params: .init(
                required: true, expectedFingerprint: identity.fingerprint, allowTOFU: false, storeKey: nil),
            allowsRedirects: false,
            allowsStoredCredentials: false)
        defer { transport.finishTasksAndInvalidate() }
        let authority = transport.makeWebSocketTask(url: accepted.url(scheme: "wss"))
        defer { authority.cancel(with: .goingAway, reason: nil) }
        let socket = transport.makeWebSocketTask(url: rejected.url(scheme: "wss"))
        socket.resume()
        defer { socket.cancel(with: .goingAway, reason: nil) }
        do {
            _ = try await socket.receive()
            Issue.record("WebSocket crossed its registered authority")
        } catch {
            #expect(error is URLError)
        }

        // Both accepting and rejecting HTTP challenges must preserve this pending WS failure.
        let reading = Task {
            try await transport.data(for: URLRequest(url: accepted.url()), maximumBytes: 2)
        }
        defer { reading.cancel() }
        let pendingBody = try await accepted.nextRequest()
        let urls = reverse ? [other.url(), rejected.url()] : [rejected.url(), other.url()]
        let tasks = urls.map { url in Task { try await Self.rejection(transport, url: url) } }
        defer { tasks.forEach { $0.cancel() } }
        for (index, task) in tasks.enumerated() {
            let failure = try await task.value
            #expect(failure.kind == .authorityMismatch)
            #expect(failure.port == urls[index].port)
        }
        accepted.completeBody(pendingBody)
        let (data, _) = try await reading.value
        #expect(data == Data("ok".utf8))
        let websocketFailure = try #require(transport.consumeLastTLSFailure())
        #expect(websocketFailure.kind == .authorityMismatch)
        #expect(websocketFailure.port == Int(rejected.port))
        #expect(transport.consumeLastTLSFailure() == nil)
    }

    @Test @MainActor
    func `cancelling a held HTTP body stays cancellation after another request rejects`() async throws {
        let identity = try GatewayTLSHTTPFixture.makeIdentity()
        let accepted = try await GatewayTLSHTTPFixture.start(identity: identity.value, holdBody: true)
        let rejected = try await GatewayTLSHTTPFixture.start(identity: identity.value)
        defer {
            accepted.stop()
            rejected.stop()
        }
        let transport = GatewayTLSPinningSession(
            params: .init(
                required: true, expectedFingerprint: identity.fingerprint, allowTOFU: false, storeKey: nil),
            allowsRedirects: false,
            allowsStoredCredentials: false)
        defer { transport.finishTasksAndInvalidate() }
        let reading = Task {
            try await transport.data(for: URLRequest(url: accepted.url()), maximumBytes: 2)
        }
        defer { reading.cancel() }
        _ = try await accepted.nextRequest()
        let failure = try await Self.rejection(transport, url: rejected.url())
        #expect(failure.kind == .authorityMismatch)
        reading.cancel()
        do {
            _ = try await reading.value
            Issue.record("Cancelled body unexpectedly completed")
        } catch {
            #expect(error is CancellationError)
        }
        #expect(transport.consumeLastTLSFailure() == nil)
    }

    private static func rejection(
        _ transport: GatewayTLSPinningSession,
        url: URL) async throws -> GatewayTLSValidationFailure
    {
        do {
            var request = URLRequest(url: url)
            request.timeoutInterval = 5
            _ = try await transport.data(for: request, maximumBytes: 2)
            throw URLError(.badServerResponse)
        } catch {
            return try #require(error as? GatewayTLSValidationError).failure
        }
    }
    #endif

    @Test(
        arguments: [true, false],
        ["https://other.example/", "http://gateway.example/", "https://gateway.example/login"])
    func `credential routes can refuse every transport redirect`(
        _ allowsRedirects: Bool,
        destination: String) async throws
    {
        let originalURL = try #require(URL(string: "https://gateway.example/artifact"))
        let targetURL = try #require(URL(string: destination))
        let policy = GatewayTLSPinningSession(
            params: .init(required: true, expectedFingerprint: nil, allowTOFU: false, storeKey: nil),
            allowsRedirects: allowsRedirects)
        let transport = URLSession(configuration: .ephemeral)
        let task = transport.dataTask(with: originalURL)
        defer {
            task.cancel()
            transport.invalidateAndCancel()
        }
        let response = try #require(HTTPURLResponse(
            url: originalURL, statusCode: 302, httpVersion: nil, headerFields: ["Location": destination]))
        var request = URLRequest(url: targetURL)
        request.setValue("synthetic-session", forHTTPHeaderField: "CF-Access-Token")
        let redirected = await withCheckedContinuation { continuation in
            policy.urlSession(
                transport,
                task: task,
                willPerformHTTPRedirection: response,
                newRequest: request,
                completionHandler: { continuation.resume(returning: $0) })
        }
        #expect(redirected?.url == (allowsRedirects ? targetURL : nil))
    }

    @Test func `keychain namespace configures once and fails closed after use`() {
        var state = GatewayTLSKeychainNamespaceState()
        let configuredWork = state.configure(suffix: ".profile.work")
        let reconfiguredWork = state.configure(suffix: ".profile.work")
        let configuredOther = state.configure(suffix: ".profile.other")
        let workService = state.service(base: "ai.openclaw.tls-pinning")
        let configuredWorkAfterUse = state.configure(suffix: ".profile.work")
        let configuredDefaultAfterUse = state.configure(suffix: "")
        #expect(configuredWork)
        #expect(reconfiguredWork)
        #expect(!configuredOther)
        #expect(workService == "ai.openclaw.tls-pinning.profile.work")
        #expect(configuredWorkAfterUse)
        #expect(!configuredDefaultAfterUse)

        var usedDefault = GatewayTLSKeychainNamespaceState()
        let defaultService = usedDefault.service(base: "ai.openclaw.tls-pinning")
        let configuredDefault = usedDefault.configure(suffix: "")
        let configuredProfileAfterDefaultUse = usedDefault.configure(suffix: ".profile.work")
        #expect(defaultService == "ai.openclaw.tls-pinning")
        #expect(configuredDefault)
        #expect(!configuredProfileAfterDefaultUse)
    }

    @Test func `TLS authority includes normalized host and effective port`() throws {
        let url = try #require(URL(string: "wss://Gateway.Example.com/path"))
        let route = try #require(GatewayTLSAuthority(url: url))
        let explicitPortURL = try #require(URL(string: "wss://gateway.example.com:8443/path"))
        let explicitPort = try #require(GatewayTLSAuthority(url: explicitPortURL))

        #expect(route.host == "gateway.example.com")
        #expect(route.port == 443)
        #expect(route.matches(host: "gateway.example.com", port: 0))
        #expect(route.matches(host: "gateway.example.com", port: 443))
        #expect(!route.matches(host: "redirect.example.com", port: 443))
        #expect(!route.matches(host: "gateway.example.com", port: 8443))
        #expect(!explicitPort.matches(host: "gateway.example.com", port: 0))
        #expect(explicitPort.matches(host: "gateway.example.com", port: 8443))
    }

    @Test func `matching explicit pin overrides system trust`() {
        let decision = GatewayTLSValidationPolicy.decide(
            expectedFingerprint: "expected",
            observedFingerprint: "expected",
            allowTOFU: false,
            required: true,
            systemTrustOk: false)

        #expect(decision == .accept(
            fingerprint: "expected",
            enforcePin: true,
            saveFirstUse: false))
    }

    @Test func `server trust evaluator accepts matching pin and rejects mismatch`() throws {
        let trust = try gatewayTLSTestTrust(systemTrusted: false)
        let fingerprint = SHA256.hash(data: gatewayTLSTestCertificateDER)
            .map { String(format: "%02x", $0) }.joined()
        let matching = GatewayTLSParams(
            required: true,
            expectedFingerprint: fingerprint,
            allowTOFU: false,
            storeKey: "profile:matching")
        let mismatch = GatewayTLSParams(
            required: true,
            expectedFingerprint: String(repeating: "0", count: 64),
            allowTOFU: false,
            storeKey: "profile:mismatch")

        #expect(GatewayTLSServerTrust.evaluate(
            trust: trust,
            host: "gateway.example",
            port: 443,
            params: matching) == .accept)
        #expect(GatewayTLSServerTrust.evaluate(
            trust: trust,
            host: "gateway.example",
            port: 443,
            params: mismatch) == .reject)
    }

    @Test func `server trust evaluator rejects a different system-trusted certificate after pinning`() throws {
        let trust = try gatewayTLSTestTrust(systemTrusted: true)
        let pinnedFingerprint = SHA256.hash(data: Data("previous certificate".utf8))
            .map { String(format: "%02x", $0) }.joined()
        let params = GatewayTLSParams(
            required: true,
            expectedFingerprint: pinnedFingerprint,
            allowTOFU: false,
            storeKey: "profile:pinned")

        #expect(GatewayTLSServerTrust.evaluate(
            trust: trust,
            host: "gateway.example",
            port: 443,
            params: params) == .reject)
    }

    @Test func `server trust evaluator claims trusted first use`() throws {
        let trust = try gatewayTLSTestTrust(systemTrusted: true)
        let fingerprint = SHA256.hash(data: gatewayTLSTestCertificateDER)
            .map { String(format: "%02x", $0) }.joined()
        let params = GatewayTLSParams(
            required: true,
            expectedFingerprint: nil,
            allowTOFU: true,
            storeKey: "profile:first-use")

        #expect(GatewayTLSServerTrust.evaluate(
            trust: trust,
            host: "gateway.example",
            port: 443,
            params: params) == .accept)
        #expect(GatewayTLSStore.loadFingerprint(stableID: "profile:first-use") == fingerprint)
    }

    @Test func `server trust evaluator binds system trust to the requested hostname`() throws {
        let trust = try gatewayTLSTestTrust(systemTrusted: true)
        let params = GatewayTLSParams(
            required: true,
            expectedFingerprint: nil,
            allowTOFU: true,
            storeKey: "profile:wrong-host")

        #expect(GatewayTLSServerTrust.evaluate(
            trust: trust,
            host: "other.example",
            port: 443,
            params: params) == .reject)
        #expect(GatewayTLSStore.loadFingerprint(stableID: "profile:wrong-host") == nil)
    }

    @Test func `server trust evaluator reuses persisted first use pin`() throws {
        let trust = try gatewayTLSTestTrust(systemTrusted: false)
        let fingerprint = SHA256.hash(data: gatewayTLSTestCertificateDER)
            .map { String(format: "%02x", $0) }.joined()
        let storeKey = "profile:reconnect"
        let params = GatewayTLSParams(
            required: true,
            expectedFingerprint: nil,
            allowTOFU: true,
            storeKey: storeKey)
        let claimed = GatewayTLSStore.claimFirstUseFingerprint(fingerprint, stableID: storeKey)
        #expect(claimed == fingerprint)

        #expect(GatewayTLSServerTrust.evaluate(
            trust: trust,
            host: "gateway.example",
            port: 443,
            params: params) == .accept)
    }

    @Test func `server trust evaluator rejects required untrusted first use`() throws {
        let trust = try gatewayTLSTestTrust(systemTrusted: false)
        let params = GatewayTLSParams(
            required: true,
            expectedFingerprint: nil,
            allowTOFU: true,
            storeKey: "profile:untrusted")

        #expect(GatewayTLSServerTrust.evaluate(
            trust: trust,
            host: "gateway.example",
            port: 443,
            params: params) == .reject)
    }

    @Test func `explicit pin mismatch and unavailable certificate fail closed`() {
        #expect(GatewayTLSValidationPolicy.decide(
            expectedFingerprint: "expected",
            observedFingerprint: "different",
            allowTOFU: false,
            required: true,
            systemTrustOk: true) == .reject(.pinMismatch))
        #expect(GatewayTLSValidationPolicy.decide(
            expectedFingerprint: "expected",
            observedFingerprint: nil,
            allowTOFU: false,
            required: true,
            systemTrustOk: true) == .reject(.certificateUnavailable))
        #expect(GatewayTLSValidationPolicy.decide(
            expectedFingerprint: nil,
            observedFingerprint: nil,
            allowTOFU: true,
            required: true,
            systemTrustOk: true) == .reject(.certificateUnavailable))
    }

    @Test func `trusted first use is saved and enforced`() {
        let decision = GatewayTLSValidationPolicy.decide(
            expectedFingerprint: nil,
            observedFingerprint: "observed",
            allowTOFU: true,
            required: true,
            systemTrustOk: true)

        #expect(decision == .accept(
            fingerprint: "observed",
            enforcePin: true,
            saveFirstUse: true))
    }

    @Test func `concurrent first use sessions share one durable fingerprint`() async {
        let stableID = "test-first-use-claim"
        let results = await withTaskGroup(of: String?.self, returning: [String?].self) { group in
            for fingerprint in ["first", "second"] {
                group.addTask {
                    GatewayTLSStore.claimFirstUseFingerprint(fingerprint, stableID: stableID)
                }
            }
            var results: [String?] = []
            for await result in group {
                results.append(result)
            }
            return results
        }
        let claimed = results.compactMap(\.self)

        #expect(claimed.count == 2)
        #expect(Set(claimed).count == 1)
        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == claimed.first)
    }

    @Test func `first use claim fails closed without a storage owner`() {
        #expect(GatewayTLSStore.claimFirstUseFingerprint("observed", stableID: "") == nil)
    }

    @Test func `losing first use session adopts the shared winner`() {
        var state = GatewayTLSPinningState(expectedFingerprint: nil)

        state.enforceFingerprint("winner")

        #expect(state.enforcedFingerprint == "winner")
        #expect(state.acceptedFingerprint == nil)
    }

    @Test func `pin replacement compares the stored value atomically`() {
        let stableID = "test-pin-cas"
        GatewayTLSStore.saveFingerprint("old", stableID: stableID)

        #expect(!GatewayTLSStore.replaceFingerprint("wrong", ifCurrent: "missing", stableID: stableID))
        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == "old")
        #expect(GatewayTLSStore.replaceFingerprint("new", ifCurrent: "old", stableID: stableID))
        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == "new")
    }

    @Test func `pin storage canonicalizes accepted fingerprint spelling`() {
        let stableID = "test-pin-canonical-spelling"
        let uppercase = String(repeating: "AB", count: 32)
        let lowercase = uppercase.lowercased()

        GatewayTLSStore.saveFingerprint("SHA256: \(uppercase)", stableID: stableID)

        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == lowercase)
        #expect(GatewayTLSStore.replaceFingerprint(
            String(repeating: "c", count: 64),
            ifCurrent: uppercase,
            stableID: stableID))
    }

    @Test func `canonical pin without comparison metadata is upgraded for replacement`() throws {
        let stableID = "测试-pin-canonical-migration"
        let component = Data(stableID.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        try #require(GatewayTLSStoreFixture.current).seed(
            account: "fingerprint.v2.\(component)",
            data: Data("old".utf8))

        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == "old")
        #expect(GatewayTLSStore.replaceFingerprint("new", ifCurrent: "old", stableID: stableID))
        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == "new")
    }

    @Test func `unreadable v2 pin blocks a new first use claim`() throws {
        let stableID = "test-pin-unreadable-v2"
        let component = Data(stableID.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        try #require(GatewayTLSStoreFixture.current).seed(account: "fingerprint.v2.\(component)", data: Data([0xFF]))

        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == nil)
        #expect(GatewayTLSStore.claimFirstUseFingerprint("new", stableID: stableID) == nil)
    }

    @Test func `legacy raw pin is migrated before conditional replacement`() throws {
        let stableID = "test-pin-legacy-migration"
        try #require(GatewayTLSStoreFixture.current).seed(account: stableID, data: Data("old".utf8))

        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == "old")
        #expect(GatewayTLSStore.replaceFingerprint("new", ifCurrent: "old", stableID: stableID))
        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == "new")
    }

    @Test func `first use fingerprint remains enforced for reconnects`() {
        var state = GatewayTLSPinningState(expectedFingerprint: nil)

        state.recordAcceptance("first", enforcePin: true)

        #expect(state.acceptedFingerprint == "first")
        #expect(state.enforcedFingerprint == "first")
    }

    @Test func `untrusted first use is rejected`() {
        #expect(GatewayTLSValidationPolicy.decide(
            expectedFingerprint: nil,
            observedFingerprint: "observed",
            allowTOFU: true,
            required: true,
            systemTrustOk: false) == .reject(.untrustedCertificate))
    }

    @Test func `clear all fingerprints removes every canonical pin without live storage`() {
        GatewayTLSStore.saveFingerprint("11", stableID: "gateway-1")
        GatewayTLSStore.saveFingerprint("22", stableID: "gateway-2")

        #expect(GatewayTLSStore.clearAllFingerprints())
        #expect(GatewayTLSStore.loadFingerprint(stableID: "gateway-1") == nil)
        #expect(GatewayTLSStore.loadFingerprint(stableID: "gateway-2") == nil)
    }
}

#if os(macOS)
private final class GatewayTLSCancelledProtocol: URLProtocol, @unchecked Sendable {
    override static func canInit(with request: URLRequest) -> Bool {
        request.url?.path == "/bare-cancellation"
    }

    override static func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        self.client?.urlProtocol(self, didFailWithError: URLError(.cancelled))
    }

    override func stopLoading() {}
}

/// Loopback TLS uses an in-memory identity, never an installed trust root or Keychain identity.
@MainActor
private final class GatewayTLSHTTPFixture {
    let port: UInt16
    private let listener: NWListener
    private let holdBody: Bool
    private var connections: [NWConnection] = []
    private var stopped = false
    private let requests = AsyncStream<NWConnection>.makeStream()

    private init(listener: NWListener, port: UInt16, holdBody: Bool) {
        self.listener = listener
        self.port = port
        self.holdBody = holdBody
        listener.newConnectionHandler = { [weak self] connection in
            Task { @MainActor in
                guard let self, !self.stopped else {
                    connection.cancel()
                    return
                }
                self.connections.append(connection)
                connection.start(queue: .main)
                self.receive(connection, buffer: Data())
            }
        }
    }

    static func makeIdentity() throws -> (value: sec_identity_t, fingerprint: String) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: directory) }
        for arguments in [
            [
                "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost",
                "-keyout", "key.pem", "-out", "cert.pem",
            ],
            [
                "pkcs12", "-export", "-inkey", "key.pem", "-in", "cert.pem", "-out", "identity.p12",
                "-passout", "pass:fixture", "-keypbe", "PBE-SHA1-3DES", "-certpbe", "PBE-SHA1-3DES",
                "-macalg", "sha1",
            ],
        ] {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/openssl")
            process.currentDirectoryURL = directory
            process.arguments = arguments
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            try process.run()
            process.waitUntilExit()
            try #require(process.terminationStatus == 0)
        }
        let bytes = try Data(contentsOf: directory.appendingPathComponent("identity.p12"))
        var items: CFArray?
        let options: [String: Any] = [
            kSecImportExportPassphrase as String: "fixture",
            kSecImportToMemoryOnly as String: true,
        ]
        try #require(SecPKCS12Import(bytes as CFData, options as CFDictionary, &items) == errSecSuccess)
        let imported = try #require((items as? [[String: Any]])?.first?[kSecImportItemIdentity as String])
        try #require(CFGetTypeID(imported as CFTypeRef) == SecIdentityGetTypeID())
        let identity = unsafeDowncast(imported as AnyObject, to: SecIdentity.self)
        var certificate: SecCertificate?
        try #require(SecIdentityCopyCertificate(identity, &certificate) == errSecSuccess)
        let der = try SecCertificateCopyData(#require(certificate)) as Data
        let fingerprint = SHA256.hash(data: der).map { String(format: "%02x", $0) }.joined()
        return try (#require(sec_identity_create(identity)), fingerprint)
    }

    static func start(identity: sec_identity_t, holdBody: Bool = false) async throws -> GatewayTLSHTTPFixture {
        let tls = NWProtocolTLS.Options()
        sec_protocol_options_set_local_identity(tls.securityProtocolOptions, identity)
        let parameters = NWParameters(tls: tls)
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let listener = try NWListener(using: parameters, on: .any)
        let states = AsyncThrowingStream<UInt16, any Error>.makeStream()
        listener.newConnectionHandler = { $0.cancel() }
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready:
                if let port = listener.port {
                    states.continuation.yield(port.rawValue)
                    states.continuation.finish()
                }
            case let .failed(error):
                states.continuation.finish(throwing: error)
            case .cancelled:
                states.continuation.finish(throwing: CancellationError())
            default:
                break
            }
        }
        listener.start(queue: DispatchQueue(label: "gateway-tls-fixture"))
        do {
            let port = try await AsyncTimeout.withTimeout(
                seconds: 5,
                onTimeout: { URLError(.timedOut) },
                operation: {
                    var iterator = states.stream.makeAsyncIterator()
                    guard let port = try await iterator.next() else { throw CancellationError() }
                    return port
                })
            listener.stateUpdateHandler = nil
            return GatewayTLSHTTPFixture(listener: listener, port: port, holdBody: holdBody)
        } catch {
            listener.stateUpdateHandler = nil
            listener.cancel()
            throw error
        }
    }

    func url(_ path: String = "/", scheme: String = "https") -> URL {
        URL(string: "\(scheme)://localhost:\(self.port)\(path)")!
    }

    func nextRequest() async throws -> NWConnection {
        let stream = self.requests.stream
        return try await AsyncTimeout.withTimeout(
            seconds: 5,
            onTimeout: { URLError(.timedOut) },
            operation: {
                var iterator = stream.makeAsyncIterator()
                guard let connection = await iterator.next() else { throw CancellationError() }
                return connection
            })
    }

    func completeBody(_ connection: NWConnection) {
        connection.send(content: Data("ok".utf8), completion: .contentProcessed { _ in connection.cancel() })
    }

    func stop() {
        self.stopped = true
        self.listener.newConnectionHandler = nil
        self.listener.cancel()
        self.connections.forEach { $0.cancel() }
        self.connections.removeAll()
        self.requests.continuation.finish()
    }

    private func receive(_ connection: NWConnection, buffer: Data) {
        connection.receive(
            minimumIncompleteLength: 1,
            maximumLength: 8192 - buffer.count)
        { [weak self] data, _, complete, error in
            Task { @MainActor in
                guard let self, !self.stopped else {
                    connection.cancel()
                    return
                }
                let buffer = buffer + (data ?? Data())
                if buffer.range(of: Data("\r\n\r\n".utf8)) != nil {
                    let headers = Data("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n".utf8)
                    connection.send(content: headers, completion: .contentProcessed { _ in
                        Task { @MainActor in
                            guard !self.stopped else { return }
                            self.requests.continuation.yield(connection)
                            if !self.holdBody { self.completeBody(connection) }
                        }
                    })
                } else if error != nil || complete || buffer.count >= 8192 {
                    connection.cancel()
                } else {
                    self.receive(connection, buffer: buffer)
                }
            }
        }
    }
}
#endif
