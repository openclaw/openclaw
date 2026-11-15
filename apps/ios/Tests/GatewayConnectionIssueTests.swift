import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@Suite(.serialized) struct GatewayConnectionIssueTests {
    @Test func `detects structured password missing`() {
        let problem = GatewayConnectionProblem(
            kind: .gatewayAuthPasswordMissing,
            owner: .gateway,
            title: "Gateway password required",
            message: "This gateway requires a password.",
            retryable: true,
            pauseReconnect: false)
        let issue = GatewayConnectionIssue.detect(problem: problem)
        #expect(issue == .passwordMissing)
        #expect(issue.needsAuthCredentials)
    }

    @Test(arguments: [
        "gateway.tailnet.ts.net", "GATEWAY.TAILNET.TS.NET.", "100.64.0.0", "100.127.255.255",
        "fd7a:115c:a1e0::1", "[FD7A:115C:A1E0:0000:0000:0000:0000:0001]",
    ])
    func `recognizes tailscale endpoint hints`(host: String) {
        #expect(GatewayConnectionIssue.isTailnetEndpoint(host))
    }

    @Test(arguments: [
        "gateway.ts.net.example.com", "ts.net", ".ts.net", "gateway..ts.net", "bad host.ts.net",
        "-gateway.ts.net", "gateway-.ts.net", "100.63.255.255", "100.128.0.0",
        "100.64.999.1", "100.64.-1.1", "100.64.1", "100.0100.0.1", "100.64.0.01",
        "192.168.1.1", "127.0.0.1",
        "fd7a:115c:a1e1::1", "fd00::1", "::1", "fd7a:115c:a1e0::invalid",
    ])
    func `does not misclassify other or malformed endpoints`(host: String) {
        #expect(!GatewayConnectionIssue.isTailnetEndpoint(host))
    }

    @Test func `transport guidance is endpoint aware and keeps retry semantics`() throws {
        let timeout = try #require(GatewayConnectionProblemMapper.map(error: URLError(.timedOut)))
        let guided = GatewayConnectionIssue.addingEndpointGuidance(to: timeout, host: "gateway.tail.ts.net")

        #expect(guided.kind == .timeout)
        #expect(guided.message.contains(timeout.message))
        #expect(guided.docsURL == GatewayConnectionIssue.tailscaleSetupURL)
        #expect(guided.actionLabel == "Retry")
        #expect(guided.retryable && !guided.pauseReconnect)
        #expect(GatewayConnectionIssue.detect(problem: guided) == .network)
        #expect(GatewayConnectionIssue.addingEndpointGuidance(to: guided, host: "gateway.tail.ts.net") == guided)
        #expect(GatewayConnectionIssue.addingEndpointGuidance(to: timeout, host: "gateway.example.com") == timeout)
    }

    /// A gateway behind Tailscale Serve listens on loopback only: dialing its tailnet address on the
    /// gateway port is refused while Tailscale works. The message named neither the address nor the
    /// fix and told the user to open Tailscale.
    @Test @MainActor func `refused tailnet route names the address and the working route`() throws {
        let model = NodeAppModel()
        defer { model.disconnectGateway() }
        model.activeGatewayConnectConfig = try GatewayConnectConfig(
            url: #require(URL(string: "wss://100.77.74.91:18809")),
            stableID: "refused-route-test",
            tls: nil,
            token: nil,
            bootstrapToken: nil,
            password: nil,
            nodeOptions: GatewayWebSocketTestSupport.identityFreeOperatorConnectOptions)

        let problem = model.mapNodeGatewayConnectionError(URLError(.cannotConnectToHost))

        #expect(problem.kind == .connectionRefused)
        #expect(problem.localizedMessage.contains("100.77.74.91:18809"))
        #expect(problem.localizedMessage.contains("Tailscale Serve"))
        #expect(!problem.localizedMessage.contains("install or open Tailscale"))
        #expect(problem.actionCommand == "openclaw qr")
        #expect(problem.docsURL == GatewayConnectionIssue.tailscaleServeDocsURL)
        #expect(problem.retryable && !problem.pauseReconnect)
        #expect(GatewayConnectionIssue.addingEndpointGuidance(
            to: problem, host: "100.77.74.91", port: 18809) == problem)
    }

    @Test func `transport failures name the dialed address once`() throws {
        let timeout = try #require(GatewayConnectionProblemMapper.map(error: URLError(.timedOut)))
        let named = GatewayConnectionIssue.addingEndpointGuidance(
            to: timeout, host: "gateway.example.com", port: 18789)
        #expect(named.localizedMessage.contains("Address: gateway.example.com:18789"))
        #expect(named.docsURL == timeout.docsURL)
        #expect(GatewayConnectionIssue.addingEndpointGuidance(
            to: named, host: "gateway.example.com", port: 18789) == named)

        // A message that already names its address (TLS probe failures) is left as it is.
        let probe = GatewayConnectionProblem(
            kind: .reachabilityFailed,
            owner: .network,
            title: "Gateway is not reachable",
            message: "Can't reach gateway at gateway.example.com:18789.",
            messagePresentation: .verbatim("Can't reach gateway at gateway.example.com:18789."),
            retryable: true,
            pauseReconnect: false)
        #expect(GatewayConnectionIssue.addingEndpointGuidance(
            to: probe, host: "gateway.example.com", port: 18789) == probe)
    }

    @Test(arguments: [
        GatewayConnectionProblem.Kind.gatewayAuthTokenMismatch, .pairingRequired, .tlsPinMismatch,
        .tlsCertificateUnavailable, .websocketCancelled,
    ])
    func `tailscale hints do not replace auth approval or certificate problems`(
        kind: GatewayConnectionProblem.Kind)
    {
        let problem = GatewayConnectionProblem(
            kind: kind,
            owner: .gateway,
            title: "Original problem",
            message: "Original remedy",
            requestId: "original-request",
            retryable: false,
            pauseReconnect: true)
        #expect(GatewayConnectionIssue.addingEndpointGuidance(to: problem, host: "gateway.tail.ts.net") == problem)
    }
}
