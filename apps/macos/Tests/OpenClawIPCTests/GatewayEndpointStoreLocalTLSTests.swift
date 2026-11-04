import Foundation
@testable import OpenClaw
@testable import OpenClawKit
import Testing

@Suite(.gatewayTLSStoreIsolated, .testWaitLimit)
struct GatewayEndpointStoreLocalTLSTests {
    @Test func `local TLS trusts only the matching loopback service certificate`() async throws {
        let configPath = TestIsolation.tempConfigPath()
        let certificatePath = configPath + ".cert.pem"
        let certificate = """
        -----BEGIN CERTIFICATE-----
        MIIBsDCCAVegAwIBAgIBATAKBggqhkjOPQQDAjAmMSQwIgYDVQQDDBtPcGVuQ2xhdyBS
        ZW5ld2FsIEZpeHR1cmUgQ0EwHhcNMjYxMDAzMTcxMTI2WhcNMjcxMDAzMTcxMTI2WjAe
        MRwwGgYDVQQDDBNnYXRld2F5LmV4YW1wbGUuY29tMFkwEwYHKoZIzj0CAQYIKoZIzj0D
        AQcDQgAEdgva0L+9BLTngMYjt0NGGL6t8AJoaO6zSMPHn7TiVHW3GR1UwjDK9jBF/ZqL
        SOqr/U8mazVayzqueI7/A+9u0aN+MHwwDAYDVR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMC
        B4AwEwYDVR0lBAwwCgYIKwYBBQUHAwEwRwYDVR0RBEAwPoITZ2F0ZXdheS5leGFtcGxl
        LmNvbYIWZ2F0ZXdheS5leGFtcGxlLnRzLm5ldIIJbG9jYWxob3N0hwR/AAABMAoGCCqG
        SM49BAMCA0cAMEQCIBJqtf9DnhqRTytUHHTgW8cKZaV58tZ8WdbTMmZMOt/2AiB8UtQY
        gX2U2gqtp7Grg8S/TYUQM5EMElGt9VcPnpmn7Q==
        -----END CERTIFICATE-----
        """
        try Data(certificate.utf8).write(to: URL(fileURLWithPath: certificatePath))
        defer { try? FileManager.default.removeItem(atPath: certificatePath) }
        let configURL = URL(fileURLWithPath: configPath)
        let root: [String: Any] = ["gateway": ["tls": ["enabled": true, "certPath": certificatePath]]]
        let launchd = Self.launchd(configPath: configPath)
        let url = try #require(URL(string: "wss://127.0.0.1:18789"))
        let fingerprint = GatewayEndpointStore._testLocalGatewayTLSCertificateFingerprint(
            url: url,
            root: root,
            launchdSnapshot: launchd,
            profile: .current,
            appConfigURL: configURL
        )
        #expect(fingerprint == "414bdfdf5d789e3e1750ad2e8bc2edb093e35c151a938b74a6848895d89b8927")

        let source = GatewayEndpointStore.SourceSnapshot(
            routingGeneration: nil,
            mode: .local,
            token: nil,
            password: nil,
            deviceAuthGatewayID: "local-tls-test",
            localPort: 18789,
            localHost: "127.0.0.1",
            scheme: "wss",
            bindMode: "loopback",
            personalIdentityEnabled: false,
            localTLSCertificateFingerprint: fingerprint,
            remoteTransport: .ssh,
            directRemoteURL: nil,
            remoteTLSFingerprint: nil,
            sshRouteIdentity: nil
        )
        let store = GatewayEndpointStore(deps: .init(
            token: { nil },
            password: { nil },
            localPort: { 18789 },
            localUnavailableReason: { nil },
            remoteRouteIfRunning: { nil },
            remoteRouteIsCurrent: { _ in true },
            canStartRemoteTunnel: { false },
            ensureRemoteTunnel: { throw CancellationError() },
            liveSourceIsCurrent: { _ in true },
            sourceSnapshot: { source }
        ))
        let endpoint = try await store.requireEndpoint()
        #expect(endpoint.config.url == url)
        #expect(endpoint.tls?.params.expectedFingerprint == fingerprint)
        #expect(endpoint.tls?.params.allowTOFU == false)
        #expect(endpoint.tls?.allowsTrustedPinReplacement == false)

        let storedRoute = try #require(GatewayTLSRoute.resolve(
            url: url,
            connectionMode: .local,
            configuredFingerprint: nil,
            storedFingerprint: "previous-local-pin",
            storeKey: "local-tls-service-test:18789",
            localServiceCertificateFingerprint: fingerprint
        ))
        #expect(storedRoute.params.expectedFingerprint == "previous-local-pin")
        #expect(storedRoute.params.allowTOFU == false)

        let tailnetURL = try #require(URL(string: "wss://100.64.0.9:18789"))
        let tailnetRoute = try #require(GatewayTLSRoute.resolve(
            url: tailnetURL,
            connectionMode: .local,
            configuredFingerprint: nil,
            storedFingerprint: "existing-tailnet-pin",
            storeKey: "100.64.0.9:18789"
        ))
        #expect(tailnetRoute.params.expectedFingerprint == "existing-tailnet-pin")
        #expect(tailnetRoute.params.allowTOFU == false)
        let systemTrustRoute = try #require(GatewayTLSRoute.resolve(
            url: tailnetURL,
            connectionMode: .local,
            configuredFingerprint: nil,
            storedFingerprint: nil,
            storeKey: "100.64.0.9:18789"
        ))
        #expect(systemTrustRoute.params.expectedFingerprint == nil)
        #expect(systemTrustRoute.params.allowTOFU)

        let mismatchedService = LaunchAgentPlistSnapshot(
            programArguments: launchd.programArguments,
            environment: [
                "OPENCLAW_CONFIG_PATH": configPath + ".other",
                "OPENCLAW_GATEWAY_PORT": "18789",
                "OPENCLAW_GATEWAY_TLS": "1",
            ],
            stdoutPath: launchd.stdoutPath,
            stderrPath: launchd.stderrPath,
            port: launchd.port,
            bind: launchd.bind,
            token: launchd.token,
            password: launchd.password
        )
        #expect(GatewayEndpointStore._testLocalGatewayTLSCertificateFingerprint(
            url: url,
            root: root,
            launchdSnapshot: mismatchedService,
            profile: .current,
            appConfigURL: configURL
        ) == nil)
        let remoteURL = try #require(URL(string: "wss://gateway.example:18789"))
        #expect(GatewayEndpointStore._testLocalGatewayTLSCertificateFingerprint(
            url: remoteURL,
            root: root,
            launchdSnapshot: launchd,
            profile: .current,
            appConfigURL: configURL
        ) == nil)
        let missingCertificateRoot: [String: Any] = ["gateway": ["tls": ["enabled": true]]]
        let missingCertificate = GatewayEndpointStore._testLocalGatewayTLSCertificateFingerprint(
            url: url,
            root: missingCertificateRoot,
            launchdSnapshot: launchd,
            profile: .current,
            appConfigURL: configURL
        )
        #expect(missingCertificate == nil)
        let storedPinWithoutServiceCertificate = try #require(GatewayTLSRoute.resolve(
            url: url,
            connectionMode: .local,
            configuredFingerprint: nil,
            storedFingerprint: "existing-local-pin",
            storeKey: "127.0.0.1:18789",
            localServiceCertificateFingerprint: missingCertificate
        ))
        #expect(storedPinWithoutServiceCertificate.params.expectedFingerprint == "existing-local-pin")
        #expect(storedPinWithoutServiceCertificate.params.allowTOFU == false)
    }

    @Test func `local service pin accepts only its certificate and missing pins still require trust`() throws {
        let url = try #require(URL(string: "wss://127.0.0.1:18789"))
        let fingerprint = "414bdfdf5d789e3e1750ad2e8bc2edb093e35c151a938b74a6848895d89b8927"
        let serviceRoute = try #require(GatewayTLSRoute.resolve(
            url: url,
            connectionMode: .local,
            configuredFingerprint: nil,
            storedFingerprint: nil,
            localServiceCertificateFingerprint: fingerprint
        ))
        #expect(GatewayTLSValidationPolicy.decide(
            expectedFingerprint: serviceRoute.params.expectedFingerprint,
            observedFingerprint: fingerprint,
            allowTOFU: serviceRoute.params.allowTOFU,
            required: true,
            systemTrustOk: false
        ) == .accept(fingerprint: fingerprint, enforcePin: true, saveFirstUse: false))
        #expect(GatewayTLSValidationPolicy.decide(
            expectedFingerprint: serviceRoute.params.expectedFingerprint,
            observedFingerprint: "replacement-certificate",
            allowTOFU: serviceRoute.params.allowTOFU,
            required: true,
            systemTrustOk: true
        ) == .reject(.pinMismatch))

        let routeWithoutServiceCert = try #require(GatewayTLSRoute.resolve(
            url: url,
            connectionMode: .local,
            configuredFingerprint: nil,
            storedFingerprint: nil
        ))
        #expect(GatewayTLSValidationPolicy.decide(
            expectedFingerprint: routeWithoutServiceCert.params.expectedFingerprint,
            observedFingerprint: fingerprint,
            allowTOFU: routeWithoutServiceCert.params.allowTOFU,
            required: true,
            systemTrustOk: false
        ) == .reject(.untrustedCertificate))
        #expect(GatewayTLSValidationPolicy.decide(
            expectedFingerprint: routeWithoutServiceCert.params.expectedFingerprint,
            observedFingerprint: fingerprint,
            allowTOFU: routeWithoutServiceCert.params.allowTOFU,
            required: true,
            systemTrustOk: true
        ) == .accept(fingerprint: fingerprint, enforcePin: true, saveFirstUse: true))
    }

    private static func launchd(configPath: String) -> LaunchAgentPlistSnapshot {
        LaunchAgentPlistSnapshot(
            programArguments: [],
            environment: [
                "OPENCLAW_CONFIG_PATH": configPath,
                "OPENCLAW_GATEWAY_PORT": "18789",
                "OPENCLAW_GATEWAY_TLS": "1",
            ],
            stdoutPath: nil,
            stderrPath: nil,
            port: nil,
            bind: nil,
            token: nil,
            password: nil
        )
    }
}
