import CryptoKit
import Foundation
import Security
import Testing
@testable import OpenClawKit

private let gatewayTLSTestCertificateDER =
    Data(
        base64Encoded: "MIIDWDCCAkCgAwIBAgIUauCyPszeo0mp5lDu/ldJ80BblyEwDQYJKoZIhvcNAQELBQAwHTEbMBkGA1UEAwwST3BlbkNsYXcgVGVzdCBSb290MB4XDTI2MDkxNjIzNTI0OFoXDTI3MDkxNjIzNTI0OFowGjEYMBYGA1UEAwwPZ2F0ZXdheS5leGFtcGxlMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwDr4MWE7mhxcr7bDk0vAKmoh+7tdNx+xzwewikHjijfVeLR7ziIQ15OpCTU977vaCe/D9eb3sOzihHxqwEpCd1qSbJT47Me3lC2r1j22GVZQ/lxh/3Pb/KHLJs6rA0Ts6Qvcn+AN9ZMqlUMXP33ZrR69y7dhZmywAFH0LCJzEdKlLw53C5lTVsXwXntE9ARiZbnUPQANvRZP0ydRKaGzWKaF50xdaUwnTQSLWkF5H6QxlXohlN5l3INrOLNtHu5VxSqvdwJ5I/OeOPtyx3WoCcxd3TBpAOha0rPMCO4G0d6sp6nu6gP9aTTUyfcYC0KOnX+BAMqvEQCwMJZCQ5s9wwIDAQABo4GSMIGPMAwGA1UdEwEB/wQCMAAwDgYDVR0PAQH/BAQDAgWgMBMGA1UdJQQMMAoGCCsGAQUFBwMBMBoGA1UdEQQTMBGCD2dhdGV3YXkuZXhhbXBsZTAdBgNVHQ4EFgQU4nDtoZ7Mi1ucqIfG++KYKDa+weQwHwYDVR0jBBgwFoAUdnh7Zg6UOXq6ezrHR8XvyymGbIMwDQYJKoZIhvcNAQELBQADggEBAJ60ChP9kjlmUyPLkQO1g8k95TpICNXw19KZF5NhQn4+60ZkvcBQ1PlAQP4j1ry2I7tGLoV2RGl0GA347DKYvOE9OAJPT7fRHPq9CGqRzJOD1qXLXjaP6qszGxTu88J3WhNsXIC5sNI7Cc8ba7ybrEg4Q+Tyo4sB+c53/AtHnDdFbprOwZfyR55wnY1pTdPcZ4QBXwRPuV+sHVvXetkgApKuyXAbIGOpj4xGB2Lvvk8QKjsOvdvv3dsUwAKnyzCWmjKS8I168227W5ga9H1twNm8RoQnQLOfUiLFcaWtFDiFRtcXc+7pK1ER1kHus0rprzTF5e6UM0cVTIVOyIMp3Ow=")!

private let gatewayTLSTestRootCertificateDER =
    Data(
        base64Encoded: "MIIDLjCCAhagAwIBAgIUZm9nSb93f+rEJJweoxU/auE9A3UwDQYJKoZIhvcNAQELBQAwHTEbMBkGA1UEAwwST3BlbkNsYXcgVGVzdCBSb290MB4XDTI2MDkxNjIzNTI0OFoXDTM2MDkxMzIzNTI0OFowHTEbMBkGA1UEAwwST3BlbkNsYXcgVGVzdCBSb290MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApWsa86zBy3I9AZ5m533iV1JLhFUtRYEHtF3Mq/00UrvZZlmfceY4bJUp38tX+UnT9sx+ilD45+VOl8VjSXmLtMo74TNjBQEn79SYbwaHMkLItYomwO+lgF9tcAjJM4MS3bQ1tK40VqxfuKtTKL1ZsqUZW1zHZ8Tf2dom+jLB8yKYelY35IxpNVBelzbiGUXw5OW8oGDqKjE9eezDpDpd4Bfgt/l8PPWlhXK2PLwNXZtCMUFPFt0ZOeo1o9Bal0cp/R46DyV1OvGkpL9RIyHbXfQJQZvugV2whWVsxHAM7cINV7rmOdf9ObbQPogTPLx08ZFDFv/MVjH5RAqYWz3LuwIDAQABo2YwZDAdBgNVHQ4EFgQUdnh7Zg6UOXq6ezrHR8XvyymGbIMwHwYDVR0jBBgwFoAUdnh7Zg6UOXq6ezrHR8XvyymGbIMwEgYDVR0TAQH/BAgwBgEB/wIBADAOBgNVHQ8BAf8EBAMCAQYwDQYJKoZIhvcNAQELBQADggEBAKPVh4LuWJf4rowdUkEEWu1fa/QBqK2/gLMdOryxkR9es2FU2LdL744KoBND89+fuisFa7gDxDCZBrJhBkDthjOnerl9Se/qpOfuODgfvSMF4Qkv97L52rhR7djV5+8LJYrGXBSbeRIMnsdOOyn1rH5GugLSCakLfmfkTIGmTwK/l7zDw7DcRNcYdLruE8wSccIDnPLKIEpyYeC2uLvLKigAV7gOjmVzObaSwKSzUaYAjFdi+zMxpHT8l8gXEfpqN+g5SgG/yRFWLy12lWNO4YXwt0jgTRqljouj1/SdozeMQCLKfoLrjDk8wlcplfSpKsJPtGVp81hAnEY9akYrw7s=")!

private let gatewayTLSAlternateCertificateDER =
    Data(
        base64Encoded: "MIIDDDCCAfSgAwIBAgIBAjANBgkqhkiG9w0BAQsFADAmMSQwIgYDVQQDDBtPcGVuQ2xhdyBTeW50aGV0aWMgUmVwcm8gQ0EwHhcNMjYxMDE0MTM1MTIzWhcNMjYxMDE2MTM1MTIzWjAaMRgwFgYDVQQDDA9nYXRld2F5LmV4YW1wbGUwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCu7JRoYxl8wwsI7MsPbkmJVrKm9Fx4zzUsXPxq89m2RGjjtZIXEHIhFu+LqOgp5dwQEDsx7YQYY7ypUcxqEU0/NsuasWbv2X0KL39SoC+4I9BW+XE1flR3cevdXNHXcuuhr2yGw+QlwdjaVbxp4C56jRMK/25DJDSbcW4hLF5lurHBr+LPvlHdjM643LvzDJArd9lAgo61+x1e6JkUidp3hMUlNSpwPpWRRgLXE5XUtcjmlq7ovc+39w//1ar6aCC8V0sg12iMQUs8k319Ke6G5+aG1wvQViUJtdYtb9nMmLXHFrIdkkc2vmeGxEeETWhOaMlreM3uLv2DosBLpdw3AgMBAAGjUTBPMAwGA1UdEwEB/wQCMAAwDgYDVR0PAQH/BAQDAgWgMBMGA1UdJQQMMAoGCCsGAQUFBwMBMBoGA1UdEQQTMBGCD2dhdGV3YXkuZXhhbXBsZTANBgkqhkiG9w0BAQsFAAOCAQEAHV3UbLIy10CVGuKGFT/qbAGSPbhYwiYjNpbf0HmP4Qo5sfG047Ew1EcYC8+DKqXBU3EQH+jF7JjMDErxUR+vNuCCcIKybYQkYYC0jG1qwlM1SYLuqBVgm0FKHXNOVu7p92DjwY9YYNVE4sZ9+fYFNuhGRrYjkJs0R6VvEWY46QF66a47nY5xwSxvYOVGv1kD2yOX627qLBwLDlkyxCOVb1nJjvtq3l5dxfr0aub4YsKTJjhyArhKoftWnsVSK4KdrmsWVjr2i7du9jMW5FRM6F8nhAZkKltYMrkhomYPmqpKVyfsjRQfXKv+W4iMZlu/6IrwwO42gt6qRhssItGHBA==")!

private let gatewayTLSAlternateRootDER =
    Data(
        base64Encoded: "MIIC8jCCAdqgAwIBAgIJAI9yGAYuu1zaMA0GCSqGSIb3DQEBCwUAMCYxJDAiBgNVBAMMG09wZW5DbGF3IFN5bnRoZXRpYyBSZXBybyBDQTAeFw0yNjEwMTQxMzUxMjNaFw0yNjEwMTYxMzUxMjNaMCYxJDAiBgNVBAMMG09wZW5DbGF3IFN5bnRoZXRpYyBSZXBybyBDQTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAMAXjGzbtPX9x7UdtqNGmmfRYBRazfj0BejQhPjvDCPq1y1mcj1AqvUwzg2OR3wpOP95b1McyPekzN4gcETEpB7eWdG1GVv/CZTlM9e1eskpxrjaEi0H+G75HIZtQ3D3bKHYtAH1KQsd/n0gT3YfSsY4p3sN1UTYTzzLKz4A5KLd0bKVg9B3P0yfXQcFIt2+uT/BgpTZqztUWaSXGKjnxMgxwdEWNii77r5GwyhfTPvMS/iQ7F1ia3+54f2zYamPr79Sb94BmMYAv9TE3TZf8KFCWK7MArOEiWwXRTQvqSoOL4F2+E1pRcjpVmoTiSYZwzP/PWnA2MXYzAf8J2vOB30CAwEAAaMjMCEwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAQYwDQYJKoZIhvcNAQELBQADggEBADG95+ZtzkEqZhGlyLpaIYepRbyWOQpLbf1icjLrfbShqFa8k03wZVhQUDfwlPBTQK4seHEp5D0u7N7CAcUZGoxPCEwrC5inKlgxN8uJrEAgMEQBhg9EfPCbtjgF0zqBp+xMgAvEdb7Gfcq0QB5XexcHMMumCzgTzTDrtDjQkPkaT1JR8n+lFvGTgYUoAz8zWH8vo3Bv7Xom97Xow99kR69XG3xYSdTxTZPShIdEDHl+GoU7yiLxmdW1IQoT++QrCf1C+Kn+BBzXeXHgyCeckMJK7HhLj6Nw1IG0VQ4eU9GfBHc+EqWAm2Gkpfiq7bEffZljMsFRkrWOk4KSFa1DzZM=")!

private func gatewayTLSTestTrust(
    systemTrusted: Bool,
    certificateDER: Data = gatewayTLSTestCertificateDER,
    rootDER: Data = gatewayTLSTestRootCertificateDER,
    verifyDate: Date? = nil) throws -> SecTrust
{
    let certificate = try #require(SecCertificateCreateWithData(nil, certificateDER as CFData))
    let rootCertificate = try #require(
        SecCertificateCreateWithData(nil, rootDER as CFData))
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
    if let verifyDate {
        try #require(SecTrustSetVerifyDate(trustValue, verifyDate as CFDate) == errSecSuccess)
    }
    return trustValue
}

@Suite(.gatewayTLSStoreIsolated)
struct GatewayTLSPinningTests {
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

    @Test func `approved alternating leaves survive new sessions without widening explicit pins`() throws {
        // The synthetic alternate chain is valid on this fixed date, independent of the host clock.
        let date = Date(timeIntervalSince1970: 1_792_069_200)
        let trustA = try gatewayTLSTestTrust(systemTrusted: true, verifyDate: date)
        let trustB = try gatewayTLSTestTrust(
            systemTrusted: true,
            certificateDER: gatewayTLSAlternateCertificateDER,
            rootDER: gatewayTLSAlternateRootDER,
            verifyDate: date)
        try #require(SecTrustEvaluateWithError(trustA, nil))
        try #require(SecTrustEvaluateWithError(trustB, nil))
        let fingerprintA = try #require(GatewayTLSServerTrust.certificateFingerprint(trustA))
        let fingerprintB = try #require(GatewayTLSServerTrust.certificateFingerprint(trustB))
        let route = "profile:alternating"
        let account = "fingerprint.v3." + Data(route.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let existingPin: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: GatewayTLSStore.resolvedKeychainService(suffix: ".tests"),
            kSecAttrAccount as String: account,
            kSecValueData as String: Data(fingerprintA.utf8),
            kSecAttrGeneric as String: Data(fingerprintA.utf8),
        ]
        // Stable v2026.10.3 writes a scalar v3 item without approval metadata.
        try #require(GatewayTLSStore.keychainOperations.add(existingPin as CFDictionary) == errSecSuccess)
        func session(allowsAlternates: Bool = true, routeKey: String = route) -> GatewayTLSPinningSession {
            GatewayTLSPinningSession(params: GatewayTLSParams(
                required: true,
                expectedFingerprint: GatewayTLSStore.loadFingerprint(stableID: routeKey),
                allowTOFU: false,
                storeKey: routeKey,
                allowsApprovedAlternates: allowsAlternates))
        }
        let url = try #require(URL(string: "wss://gateway.example"))
        #expect(session().validateServerTrust(trustA, for: url))
        #expect(!session().validateServerTrust(trustB, for: url))
        try #require(GatewayTLSStore.approveFingerprint(fingerprintB, ifCurrent: fingerprintA, stableID: route))
        // New sessions read durable approvals, rather than relying on the approving session's cache.
        #expect(session().validateServerTrust(trustB, for: url))
        #expect(session().validateServerTrust(trustA, for: url))
        // A retained edge can be the live session's pin while B remains the scalar store pin.
        // Reviewing a new rotation from that session must not fail the conditional write.
        let fingerprintC = String(repeating: "c", count: 64)
        try #require(GatewayTLSStore.approveFingerprint(fingerprintC, ifCurrent: fingerprintA, stableID: route))
        #expect(session().validateServerTrust(trustA, for: url))
        #expect(session().validateServerTrust(trustB, for: url))
        #expect(!session(allowsAlternates: false).validateServerTrust(trustA, for: url))
        let untrustedA = try gatewayTLSTestTrust(systemTrusted: false, verifyDate: date)
        #expect(!session().validateServerTrust(untrustedA, for: url))
        let wrongHost = try #require(URL(string: "wss://other.example"))
        #expect(!session().validateServerTrust(trustA, for: wrongHost))
        let otherRoute = "profile:other"
        try #require(GatewayTLSStore.replaceFingerprint(fingerprintB, stableID: otherRoute))
        #expect(!session(routeKey: otherRoute).validateServerTrust(trustA, for: url))
        #expect(!GatewayTLSStore.approveFingerprint(
            fingerprintA, ifCurrent: String(repeating: "f", count: 64), stableID: route))
        // Explicit setup/configuration writes retire alternates, including identical-pin writes.
        try #require(GatewayTLSStore.replaceFingerprint(fingerprintB, stableID: route))
        #expect(!session().validateServerTrust(trustA, for: url))
    }

    @Test(arguments: [false, true])
    func `withdrawn approvals reject a retained session pin on its next handshake`(forget: Bool) throws {
        let trust = try gatewayTLSTestTrust(systemTrusted: true)
        let fingerprint = try #require(GatewayTLSServerTrust.certificateFingerprint(trust))
        let replacement = String(repeating: "b", count: 64)
        let route = "profile:withdrawn"
        try #require(GatewayTLSStore.replaceFingerprint(fingerprint, stableID: route))
        try #require(GatewayTLSStore.approveFingerprint(replacement, ifCurrent: fingerprint, stableID: route))
        let session = GatewayTLSPinningSession(params: .init(
            required: true,
            expectedFingerprint: replacement,
            allowTOFU: false,
            storeKey: route,
            allowsApprovedAlternates: true))
        let url = try #require(URL(string: "wss://gateway.example"))
        try #require(session.validateServerTrust(trust, for: url))
        let untrusted = try gatewayTLSTestTrust(systemTrusted: false)
        #expect(!session.validateServerTrust(untrusted, for: url))
        #expect(session.consumeLastTLSFailure()?.kind == .untrustedCertificate)
        if forget {
            try #require(GatewayTLSStore.clearFingerprint(stableID: route))
        } else {
            try #require(GatewayTLSStore.replaceFingerprint(replacement, stableID: route))
        }
        #expect(!session.validateServerTrust(trust, for: url))
        #expect(session.consumeLastTLSFailure()?.kind == .pinMismatch)
    }

    @Test func `approved leaves are bounded and retired by forget or older-client writes`() throws {
        let route = "profile:bounded"
        let leaves = (0..<6).map { String(repeating: String($0), count: 64) }
        try #require(GatewayTLSStore.replaceFingerprint(leaves[0], stableID: route))
        for index in 1..<leaves.count {
            try #require(GatewayTLSStore.approveFingerprint(
                leaves[index], ifCurrent: leaves[index - 1], stableID: route))
        }
        for index in 0..<leaves.count {
            #expect((GatewayTLSStore.approvedFingerprints(stableID: route)?.contains(leaves[index]) == true) ==
                (index >= 2))
        }
        // Simulate a v3 client updating the scalar pin without knowing approval metadata.
        let account = "fingerprint.v3." + Data(route.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: GatewayTLSStore.resolvedKeychainService(suffix: ".tests"),
            kSecAttrAccount as String: account,
        ]
        let olderWrite: [String: Any] = [
            kSecValueData as String: Data(leaves[0].utf8),
            kSecAttrGeneric as String: Data(leaves[0].utf8),
        ]
        try #require(GatewayTLSStore.keychainOperations.update(
            query as CFDictionary, olderWrite as CFDictionary) == errSecSuccess)
        #expect(GatewayTLSStore.loadFingerprint(stableID: route) == leaves[0])
        #expect(GatewayTLSStore.approvedFingerprints(stableID: route)?.contains(leaves[4]) == false)
        try #require(GatewayTLSStore.clearFingerprint(stableID: route))
        try #require(GatewayTLSStore.replaceFingerprint(leaves[5], stableID: route))
        #expect(GatewayTLSStore.approvedFingerprints(stableID: route)?.contains(leaves[4]) == false)
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
