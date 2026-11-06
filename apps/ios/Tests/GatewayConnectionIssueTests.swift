import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@Suite(.serialized) struct GatewayConnectionIssueTests {
    @Test func `detects token missing`() {
        let issue = GatewayConnectionIssue.detect(from: "unauthorized: gateway token missing")
        #expect(issue == .tokenMissing)
        #expect(issue.needsAuthCredentials)
    }

    @Test func `detects password missing`() {
        let issue = GatewayConnectionIssue.detect(
            from: "unauthorized: gateway password missing (provide gateway auth password)")
        #expect(issue == .passwordMissing)
        #expect(issue.needsAuthCredentials)
    }

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

    @Test func `detects unauthorized`() {
        let issue = GatewayConnectionIssue.detect(from: "Gateway error: unauthorized role")
        #expect(issue == .unauthorized)
        #expect(issue.needsAuthCredentials)
    }

    @Test func `detects pairing with request id`() {
        let issue = GatewayConnectionIssue.detect(from: "pairing required (requestId: abc123)")
        #expect(issue == .pairingRequired(requestId: "abc123"))
        #expect(issue.needsPairing)
        #expect(issue.requestId == "abc123")
    }

    @Test func `detects network error`() {
        let issue = GatewayConnectionIssue.detect(from: "Gateway error: Connection refused")
        #expect(issue == .network)
    }

    @Test func `returns none for benign status`() {
        let issue = GatewayConnectionIssue.detect(from: "Connected")
        #expect(issue == .none)
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
