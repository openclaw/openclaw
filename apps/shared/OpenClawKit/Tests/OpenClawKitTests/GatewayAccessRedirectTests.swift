import Foundation
import Testing
@testable import OpenClawKit

struct GatewayAccessRedirectTests {
    @Test(arguments: [
        (302, "https://team.cloudflareaccess.com/", true),
        (307, "/cdn-cgi/access/login/gateway.example.com", true),
        (302, "https://notcloudflareaccess.com/", false),
        (302, "/login", false),
        (200, "https://team.cloudflareaccess.com/", false),
    ])
    func `only Access-shaped redirect responses require browser sign-in`(
        status: Int, location: String, expected: Bool) throws
    {
        let url = try #require(URL(string: "https://gateway.example.com/"))
        let response = try #require(HTTPURLResponse(
            url: url, statusCode: status, httpVersion: nil, headerFields: ["Location": location]))
        #expect((GatewayExternalAuthorizationError(response: response) != nil) == expected)
    }

    @Test(arguments: [true, false]) @MainActor
    func `non-Access same-origin WebSocket redirect preserves caller policy`(allowsRedirects: Bool) async throws {
        let server = try GatewayHTTPFixture(replyForRequest: { request in
            if request.hasPrefix("GET /legacy ") {
                return "HTTP/1.1 301 Moved Permanently\r\nLocation: /ws\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
            }
            return "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n"
        })
        defer { server.stop() }
        let sourceURL = try await server.readyURL().deletingLastPathComponent().appendingPathComponent("legacy")
        let url = try #require(URL(string: sourceURL.absoluteString.replacingOccurrences(of: "http:", with: "ws:")))
        let session = GatewayTLSPinningSession(
            params: .init(required: false, expectedFingerprint: nil, allowTOFU: false, storeKey: nil),
            allowsRedirects: allowsRedirects, allowsStoredCredentials: false)
        defer { session.finishTasksAndInvalidate() }
        let socket = session.makeWebSocketTask(url: url)
        defer { socket.cancel(with: .goingAway, reason: nil) }
        socket.resume()
        do {
            _ = try await AsyncTimeout.withTimeout(seconds: 3, onTimeout: { URLError(.timedOut) }) {
                try await socket.receive()
            }
            Issue.record("Fixture unexpectedly upgraded")
        } catch {
            #expect((error as? URLError)?.code == .badServerResponse)
        }
        // The terminal 400 proves /ws was reached without needing a Gateway handshake.
        #expect((socket.response as? HTTPURLResponse)?.statusCode == (allowsRedirects ? 400 : 301))
        #expect(socket.response?.url?.path == (allowsRedirects ? "/ws" : "/legacy"))
        #expect(server.requests.count == (allowsRedirects ? 2 : 1))
        #expect(server.requests.first?.hasPrefix("GET /legacy ") == true)
        if allowsRedirects {
            #expect(server.requests.last?.hasPrefix("GET /ws ") == true)
        }
        #expect(session.consumeLastTLSFailure() == nil)
    }

    @Test @MainActor func `WebSocket Access redirect is not followed and requires browser sign-in`() async throws {
        let destination = try GatewayHTTPFixture(reply: "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
        defer { destination.stop() }
        let destinationURL = try await destination.readyURL()
            .deletingLastPathComponent()
            .appendingPathComponent("cdn-cgi/access/login/gateway.example.com")
        let source = try GatewayHTTPFixture(
            reply: "HTTP/1.1 302 Found\r\nLocation: \(destinationURL)\r\nContent-Length: 0\r\n\r\n")
        defer { source.stop() }
        let sourceURL = try await source.readyURL()
        let url = try #require(URL(string: sourceURL.absoluteString.replacingOccurrences(of: "http:", with: "ws:")))
        let session = GatewayTLSPinningSession(params: .init(
            required: false, expectedFingerprint: nil, allowTOFU: false, storeKey: nil))
        defer { session.finishTasksAndInvalidate() }
        let channel = GatewayChannelActor(
            url: url, token: nil, session: WebSocketSessionBox(session: session),
            connectOptions: .init(
                role: "operator", scopes: [], caps: [], commands: [], permissions: [:],
                clientId: "openclaw-macos", clientMode: "ui", clientDisplayName: "Redirect test",
                includeDeviceIdentity: false, allowStoredDeviceAuth: false))
        var observedError: Error?
        do {
            try await channel.connect()
            Issue.record("Redirected upgrade unexpectedly connected")
        } catch {
            observedError = error
        }
        await channel.shutdown()
        #expect(source.requests.count == 1)
        #expect(destination.requests.isEmpty)
        let error = try #require(observedError)
        let problem = try #require(GatewayConnectionProblemMapper.map(error: error))
        #expect(problem.kind == .externalAuthorizationRequired)
        #expect(problem.pauseReconnect)
        #expect(session.consumeLastTLSFailure() == nil)
    }
}
