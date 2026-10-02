import CryptoKit
import Foundation
import OpenClawChatUI
import Testing
@testable import OpenClaw
@testable import OpenClawKit

@Suite(.serialized, .testWaitLimit)
@MainActor
struct GatewayConnectionMediaAuthorityTests {
    private nonisolated static let artifactID = "artifact_managed_image_authority"
    private nonisolated static let ticket = "/api/chat/media/outgoing/image?mediaTicket=synthetic"

    @Test(arguments: ["allow", "deny", "cancel"])
    func `header-only HTTPS enforces pins and releases retired factories`(_ scenario: String) async throws {
        let tls = try await DashboardTLSFixture()
        let fingerprint = try #require(Self.tlsParams(tls).expectedFingerprint)
        let received = AsyncTestSignal()
        var requests: [String] = []
        let server = try await DashboardHTTPFixture.start(tlsIdentity: tls.identity, rawResponseHandler: { request in
            requests.append(request)
            received.notify()
            // Cancellation must interrupt a live request; the allow case must return
            // with nine body bytes still outstanding, before the fixture's 5s cleanup.
            // Declare the media type so URLSession delivers these headers before the full body.
            let reply = scenario == "cancel" ? "" :
                "HTTP/1.1 200 OK\r\nX-Proof: header-only\r\nContent-Type: text/html; charset=utf-8\r\n" +
                "Content-Length: 10\r\n\r\nx"
            return .init(data: Data(reply.utf8), keepConnectionOpen: true)
        })
        defer { server.stop() }
        weak var retired: GatewayTLSPinningSession?
        defer { retired?.finishTasksAndInvalidate() }

        func requestRound() async throws {
            let wrongPin = (fingerprint.first == "0" ? "1" : "0") + String(fingerprint.dropFirst())
            let policy = GatewayTLSPinningSession(
                params: .init(
                    required: true,
                    expectedFingerprint: scenario == "deny" ? wrongPin : fingerprint,
                    allowTOFU: false,
                    storeKey: nil),
                allowsRedirects: false,
                allowsStoredCredentials: false)
            retired = policy
            var request = URLRequest(url: server.url("/header-only"))
            request.setValue("synthetic-header-proof", forHTTPHeaderField: "Cf-Access-Token")
            let pending = Task { [request] in try await policy.response(for: request) }
            let result: Result<URLResponse, Error>
            do {
                if scenario == "cancel" {
                    try await AsyncTimeout.withTimeout(seconds: 3, onTimeout: {
                        URLError(
                            .timedOut,
                            userInfo: [NSLocalizedDescriptionKey: "header-only request receipt timeout"])
                    }) { @MainActor in
                        try await received.wait("authenticated header-only request") { !requests.isEmpty }
                    }
                    pending.cancel()
                }
                result = try await AsyncTimeout.withTimeout(seconds: 3, onTimeout: {
                    URLError(.timedOut, userInfo: [NSLocalizedDescriptionKey: "header-only response result timeout"])
                }) {
                    await pending.result
                }
            } catch {
                pending.cancel()
                server.stop()
                _ = await pending.result
                throw error
            }
            if scenario == "allow" {
                let response = try #require(try result.get() as? HTTPURLResponse)
                #expect(response.statusCode == 200)
                #expect(response.value(forHTTPHeaderField: "X-Proof") == "header-only")
            } else {
                switch result {
                case .success: Issue.record("Rejected header-only request completed successfully")
                case let .failure(error):
                    if scenario == "cancel" {
                        #expect(error is CancellationError || (error as? URLError)?.code == .cancelled)
                    } else {
                        let failure = try #require(policy.consumeLastTLSFailure())
                        #expect(failure.kind == .pinMismatch)
                        #expect(failure.observedFingerprint == fingerprint)
                    }
                }
            }
            if scenario == "deny" {
                #expect(requests.isEmpty)
            } else {
                #expect(policy.effectiveTLSFingerprintSHA256 == fingerprint)
                #expect(requests.count == 1)
                #expect(requests.first?.hasPrefix("GET /header-only ") == true)
                #expect(requests.first?.lowercased().contains("cf-access-token: synthetic-header-proof") == true)
            }
        }

        let started = ContinuousClock.now
        try await requestRound()
        // Drop the entire request/task scope before checking the public wrapper's
        // lifetime; explicit invalidation would conceal the delegate retain cycle.
        try await AsyncTimeout.withTimeout(seconds: 3, onTimeout: {
            URLError(.timedOut, userInfo: [NSLocalizedDescriptionKey: "header-only release or socket timeout"])
        }) { @MainActor in
            try await TestWait.state("header-only TLS factory release") { retired == nil }
            try await server.waitUntilIdle("header-only HTTPS socket cleanup")
        }
        #expect(retired == nil)
        #expect(started.duration(to: .now) < .seconds(3))
    }

    @Test(arguments: [false, true])
    func `cancellation before transport creation cannot dispatch or invalidate its session`(
        afterAdmission: Bool) async throws
    {
        let tls = try await DashboardTLSFixture()
        var requests: [String] = []
        let server = try await DashboardHTTPFixture.start(tlsIdentity: tls.identity, requestHandler: { request in
            requests.append(request)
            return Self.imageResponse
        })
        defer { server.stop() }
        let transport = GatewayTLSPinningSession(params: Self.tlsParams(tls))
        defer { transport.finishTasksAndInvalidate() }
        let gate = GatewayConnectionSuspensionGate()
        let request = URLRequest(url: server.url("/cancelled"))
        let pending = Task {
            if !afterAdmission { await gate.suspend() }
            return try await transport.data(for: request, maximumBytes: 5) {
                if afterAdmission { withUnsafeCurrentTask { $0?.cancel() } }
                return true
            }
        }
        if !afterAdmission {
            await gate.waitUntilStarted()
            pending.cancel()
            await gate.open()
        }
        do {
            _ = try await pending.value
            Issue.record("Cancelled media request completed")
        } catch {
            #expect(error is CancellationError || (error as? URLError)?.code == .cancelled)
        }
        let (bytes, _) = try await transport.data(
            for: URLRequest(url: server.url("/control")),
            maximumBytes: 5)
        #expect(bytes == Data("image".utf8))
        #expect(requests.count == 1)
        #expect(requests.first?.hasPrefix("GET /control ") == true)
    }

    @Test(arguments: ["current", "redirect", "expired", "wrong-origin"])
    func `browser authority controls the actual media HTTP request`(_ scenario: String) async throws {
        let tls = try await DashboardTLSFixture()
        var otherRequests = 0
        let other = try await DashboardHTTPFixture.start(tlsIdentity: tls.identity, requestHandler: { _ in
            otherRequests += 1
            return Self.imageResponse
        })
        defer { other.stop() }
        var requests: [String] = []
        let cookieName = "media-\(UUID().uuidString)"
        let server = try await DashboardHTTPFixture.start(tlsIdentity: tls.identity, requestHandler: { request in
            requests.append(request)
            return scenario == "redirect"
                ? "HTTP/1.1 302 Found\r\nLocation: \(other.url(Self.ticket))\r\nContent-Length: 0\r\n\r\n"
                : Self.imageResponse.replacingOccurrences(
                    of: "Connection: close",
                    with: "Set-Cookie: \(cookieName)-response=other-account; Secure; Path=/\r\nConnection: close")
        })
        defer { server.stop() }
        let ambient = try #require(HTTPCookie(properties: [
            .name: cookieName, .value: "ambient-account", .originURL: server.url(), .path: "/",
            .secure: "TRUE",
        ]))
        HTTPCookieStorage.shared.setCookie(ambient)
        #expect(HTTPCookieStorage.shared.cookies(for: server.url())?
            .contains { $0.name == cookieName } == true)
        defer {
            for cookie in HTTPCookieStorage.shared.cookies ?? [] where cookie.name.hasPrefix(cookieName) {
                HTTPCookieStorage.shared.deleteCookie(cookie)
            }
        }
        let browser = try gatewayBrowserSessionFixture(
            origin: (scenario == "wrong-origin" ? other.url() : server.url()).absoluteString,
            expiresAt: scenario == "expired" ? Date(timeIntervalSince1970: 1) : .fixtureSessionExpiry)
        let source = GatewayConnectionEndpointSource(endpoint: Self.endpoint(server, tls: tls, browser: browser))
        let connection = Self.connection(source)
        let outcome: Result<Void, Error>
        do {
            if scenario == "expired" || scenario == "wrong-origin" {
                await #expect(throws: scenario == "expired"
                    ? GatewayBrowserSessionError.expired : GatewayBrowserSessionError.wrongOrigin)
                {
                    _ = try await connection.acquireServerLease()
                }
                #expect(requests.isEmpty)
            } else {
                let lease = try await connection.acquireServerLease()
                let media = try await Self.load(connection, lease: lease)
                #expect(requests.count == 1)
                #expect(requests.first?.lowercased().contains("cf-access-token: synthetic-browser-session") == true)
                if scenario == "redirect" {
                    #expect(media == nil)
                } else {
                    guard case let .data(image) = media else {
                        Issue.record("Expected authenticated image bytes")
                        throw CancellationError()
                    }
                    #expect(image.data == Data("image".utf8))
                    _ = try await Self.load(connection, lease: lease)
                    #expect(requests.count == 2)
                }
            }
            #expect(otherRequests == 0)
            #expect(requests.allSatisfy { !$0.contains(cookieName) })
            #expect(HTTPCookieStorage.shared.cookies?.contains { $0.name == "\(cookieName)-response" } != true)
            outcome = .success(())
        } catch {
            outcome = .failure(error)
        }
        await connection.shutdown()
        try outcome.get()
    }

    @Test(arguments: ["manual-upgrade", "browser-replacement", "expiry"])
    func `retiring authority cancels media waiting for HTTP headers`(_ retirement: String) async throws {
        let tls = try await DashboardTLSFixture()
        let gate = GatewayConnectionSuspensionGate()
        let progress = AsyncTestSignal()
        var requestStarted = false
        var mediaFinished = false
        var requests: [String] = []
        let server = try await DashboardHTTPFixture.start(
            beforeResponse: {
                requestStarted = true
                progress.notify()
                await gate.suspend()
            },
            tlsIdentity: tls.identity,
            requestHandler: { request in
                requests.append(request)
                return Self.imageResponse
            })
        defer { server.stop() }
        let browser = try gatewayBrowserSessionFixture(
            origin: server.url().absoluteString,
            expiresAt: retirement == "expiry" ? Date().addingTimeInterval(3) : .fixtureSessionExpiry)
        let source = GatewayConnectionEndpointSource(endpoint: Self.endpoint(
            server, tls: tls, browser: retirement == "manual-upgrade" ? nil : browser))
        let connection = Self.connection(source)
        let media = Task { () -> Result<Void, Error> in
            defer {
                mediaFinished = true
                progress.notify()
            }
            do {
                let lease = try await connection.acquireServerLease()
                _ = try await Self.load(connection, lease: lease)
                return .success(())
            } catch {
                return .failure(error)
            }
        }
        let outcome: Result<Void, Error>
        do {
            try await progress.wait("media request headers or expiry rejection") {
                requestStarted || mediaFinished
            }
            if retirement != "expiry" {
                try #require(requestStarted)
                let successor = try gatewayBrowserSessionFixture(
                    origin: server.url().absoluteString, token: "successor-browser-session")
                source.setEndpoint(Self.endpoint(server, tls: tls, browser: successor))
                _ = try await connection.request(method: "health", params: nil)
            }
            // Expiry can reject admission before the starved HTTP task reaches the server.
            // Once it reaches the server, headers stay withheld until authority cancels it.
            let result = try await TestWait.value(of: media, "media authority cancellation")
            let cancelled: Bool
            if case let .failure(error) = result {
                cancelled = error is CancellationError || (error as? URLError)?.code == .cancelled
                if retirement == "expiry", !requestStarted {
                    await gate.open()
                    try await server.waitUntilIdle("expired media transport closure")
                    #expect(browser.expiresAt <= Date())
                    #expect(!requestStarted)
                    #expect(requests.isEmpty)
                    #expect(cancelled || (error as? GatewayBrowserSessionError) == .expired ||
                        error is OpenClawChatTransportSendError)
                } else {
                    #expect(cancelled)
                }
            } else {
                cancelled = false
                #expect(cancelled)
            }
            await gate.open()
            if retirement != "expiry" {
                let current = try await connection.acquireServerLease()
                guard case .data = try await Self.load(connection, lease: current) else {
                    Issue.record("Replacement authority could not load media")
                    throw CancellationError()
                }
                #expect(requests.last?.lowercased().contains("cf-access-token: successor-browser-session") == true)
            }
            outcome = .success(())
        } catch {
            outcome = .failure(error)
        }
        media.cancel()
        await gate.open()
        await connection.shutdown()
        _ = await media.result
        try outcome.get()
    }

    private static func endpoint(
        _ server: DashboardHTTPFixture,
        tls: DashboardTLSFixture,
        browser: GatewayBrowserSession?) -> GatewayConnection.EndpointSnapshot
    {
        .init(
            config: (server.websocketURL(), browser == nil ? "synthetic-owner" : nil, nil),
            tls: GatewayTLSRoute(
                params: self.tlsParams(tls),
                allowsTrustedPinReplacement: false),
            routeAuthority: nil,
            browserSession: browser)
    }

    private static func connection(_ source: GatewayConnectionEndpointSource) -> GatewayConnection {
        let session = GatewayTestWebSocketSession {
            GatewayTestWebSocketTask(sendHook: { socket, message, index in
                guard index > 0, let id = GatewayWebSocketTestSupport.requestID(from: message) else { return }
                if GatewayWebSocketTestSupport.requestMethod(from: message) == "artifacts.download" {
                    let response: [String: Any] = [
                        "type": "res", "id": id, "ok": true,
                        "payload": [
                            "artifact": [
                                "id": Self.artifactID, "type": "image", "title": "Synthetic image",
                                "mimeType": "image/png", "sizeBytes": 5, "download": [:],
                            ],
                            "url": Self.ticket,
                        ],
                    ]
                    try socket.emitReceiveSuccess(.data(JSONSerialization.data(withJSONObject: response)))
                } else {
                    socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
                }
            })
        }
        return GatewayConnection(
            testEndpointProvider: { source.snapshot() },
            sessionBox: WebSocketSessionBox(session: session))
    }

    private static func tlsParams(_ tls: DashboardTLSFixture) -> GatewayTLSParams {
        GatewayTLSParams(
            required: true,
            expectedFingerprint: SHA256.hash(data: tls.certificate).map { String(format: "%02x", $0) }.joined(),
            allowTOFU: false,
            storeKey: nil)
    }

    private static func load(
        _ connection: GatewayConnection,
        lease: GatewayConnection.ServerLease) async throws -> OpenClawChatLoadedMedia?
    {
        try await connection.loadMediaArtifact(
            sessionKey: "agent:main:media",
            agentID: "main",
            artifactId: self.artifactID,
            kind: .image,
            playback: nil,
            ifCurrentServerLease: lease)
    }

    private static var imageResponse: String {
        "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 5\r\nConnection: close\r\n\r\nimage"
    }
}
