import ConcurrencyExtras
import CryptoKit
import Foundation
import Testing
@testable import OpenClawDiscovery

struct TailscaleServeGatewayDiscoveryTests {
    @Test func `discovers serve gateway from tailnet peers`() async {
        let statusJson = """
        {
          "Self": {
            "DNSName": "local-mac.tailnet-example.ts.net.",
            "HostName": "local-mac",
            "Online": true
          },
          "Peer": {
            "peer-1": {
              "DNSName": "gateway-host.tailnet-example.ts.net.",
              "HostName": "gateway-host",
              "Online": true
            },
            "peer-2": {
              "DNSName": "offline.tailnet-example.ts.net.",
              "HostName": "offline-box",
              "Online": false
            },
            "peer-3": {
              "DNSName": "local-mac.tailnet-example.ts.net.",
              "HostName": "local-mac",
              "Online": true
            }
          }
        }
        """

        let context = TailscaleServeGatewayDiscovery.DiscoveryContext(
            tailscaleStatus: { statusJson },
            probeHost: { host, _ in
                host == "gateway-host.tailnet-example.ts.net"
            })

        let beacons = await TailscaleServeGatewayDiscovery.discover(timeoutSeconds: 2.0, context: context)
        #expect(beacons.count == 1)
        #expect(beacons.first?.displayName == "gateway-host")
        #expect(beacons.first?.tailnetDns == "gateway-host.tailnet-example.ts.net")
        #expect(beacons.first?.host == "gateway-host.tailnet-example.ts.net")
        #expect(beacons.first?.port == 443)
    }

    @Test func `returns empty when status unavailable`() async {
        let context = TailscaleServeGatewayDiscovery.DiscoveryContext(
            tailscaleStatus: { nil },
            probeHost: { _, _ in true })

        let beacons = await TailscaleServeGatewayDiscovery.discover(timeoutSeconds: 2.0, context: context)
        #expect(beacons.isEmpty)
    }

    @Test func `resolves bare executable from PATH`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let executable = tempDir.appendingPathComponent("tailscale")
        try "#!/bin/sh\necho ok\n".write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)

        let env: [String: String] = ["PATH": tempDir.path]
        let resolved = TailscaleServeGatewayDiscovery.resolveExecutablePath("tailscale", env: env)
        #expect(resolved == executable.path)
    }

    @Test func `rejects missing executable candidate`() {
        #expect(TailscaleServeGatewayDiscovery.resolveExecutablePath("", env: [:]) == nil)
        #expect(TailscaleServeGatewayDiscovery
            .resolveExecutablePath("definitely-not-here", env: ["PATH": "/tmp"]) == nil)
    }

    @Test func `adds TERM for GUI-launched tailscale subprocesses`() {
        let env = TailscaleServeGatewayDiscovery.commandEnvironment(base: [
            "HOME": "/Users/tester",
            "PATH": "/usr/bin:/bin",
        ])

        #expect(env["TERM"] == "dumb")
        #expect(env["HOME"] == "/Users/tester")
        #expect(env["PATH"] == "/usr/bin:/bin")
    }

    @Test func `preserves existing TERM when building tailscale subprocess environment`() {
        let env = TailscaleServeGatewayDiscovery.commandEnvironment(base: [
            "TERM": "xterm-256color",
            "HOME": "/Users/tester",
        ])

        #expect(env["TERM"] == "xterm-256color")
        #expect(env["HOME"] == "/Users/tester")
    }
}

@Suite(.serialized)
@MainActor
struct GatewayDiscoveryProbeTests {
    @Test func `challenge discovery never sends or retains credentials across peer probes`() async throws {
        let cookieName = "discovery-\(UUID().uuidString)"
        let clientData = LockIsolated(Data())
        var requests: [String] = []
        let server = try await DashboardHTTPFixture.start(
            rawResponseHandler: { request in
                requests.append(request)
                return Self.challengeResponse(request, cookieName: cookieName)
            },
            onPostResponseData: { data in clientData.withValue { $0.append(data) } })
        defer { server.stop() }
        let ambient = try #require(HTTPCookie(properties: [
            .name: "\(cookieName)-ambient", .value: "synthetic-ambient", .originURL: server.url(), .path: "/",
        ]))
        HTTPCookieStorage.shared.setCookie(ambient)
        defer { HTTPCookieStorage.shared.deleteCookie(ambient) }

        for _ in 0..<2 {
            #expect(await GatewayDiscoveryProbe.shared.hasGatewayChallenge(url: server.websocketURL(), timeout: 2))
            try await Self.waitForDisconnect(server)
        }

        #expect(requests.count == 2)
        #expect(requests.allSatisfy { request in
            let headers = request.lowercased()
            return !headers.contains("cookie:") && !headers.contains("authorization:")
        })
        #expect(try Self.clientFrameOpcodes(clientData.value).allSatisfy { $0 == 0x8 })
        #expect(HTTPCookieStorage.shared.cookies?.contains { $0.name == cookieName } != true)
    }

    @Test(arguments: ["basic", "proxy", "redirect", "other-event"])
    func `candidate responses cannot cause authentication or redirected probes`(_ response: String) async throws {
        var redirectedRequests = 0
        let destination = try await DashboardHTTPFixture.start(requestHandler: { _ in
            redirectedRequests += 1
            return nil
        })
        defer { destination.stop() }
        let realm = "discovery-\(UUID().uuidString)"
        let clientData = LockIsolated(Data())
        var requests: [String] = []
        let server = try await DashboardHTTPFixture.start(
            rawResponseHandler: { request in
                requests.append(request)
                if response == "other-event" {
                    return Self.challengeResponse(request, event: "unrelated.event")
                }
                if response == "basic", request.lowercased().contains("authorization:") {
                    return .init(data: Data("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".utf8))
                }
                let headers = switch response {
                case "basic":
                    "HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"\(realm)\"\r\n"
                case "proxy":
                    "HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"\(realm)\"\r\n"
                default:
                    "HTTP/1.1 302 Found\r\nLocation: \(destination.websocketURL())\r\n"
                }
                return .init(data: Data("\(headers)Content-Length: 0\r\nConnection: close\r\n\r\n".utf8))
            },
            onPostResponseData: { data in clientData.withValue { $0.append(data) } })
        defer { server.stop() }

        let protectionSpace = URLProtectionSpace(
            host: "127.0.0.1", port: Int(server.port), protocol: "http", realm: realm,
            authenticationMethod: NSURLAuthenticationMethodHTTPBasic)
        let credential = URLCredential(user: "synthetic-user", password: "synthetic-password", persistence: .forSession)
        URLCredentialStorage.shared.setDefaultCredential(credential, for: protectionSpace)
        defer { URLCredentialStorage.shared.remove(credential, for: protectionSpace) }

        if response == "basic" {
            let control = URLSession(configuration: .default)
            defer { control.finishTasksAndInvalidate() }
            let (_, reply) = try await control.data(from: server.url())
            try #require((reply as? HTTPURLResponse)?.statusCode == 200)
            try #require(requests.contains { $0.lowercased().contains("authorization:") })
            requests.removeAll()
        }

        #expect(await !GatewayDiscoveryProbe.shared.hasGatewayChallenge(url: server.websocketURL(), timeout: 2))
        try await Self.waitForDisconnect(server)
        #expect(requests.count == 1)
        #expect(requests.allSatisfy { !$0.lowercased().contains("authorization:") })
        #expect(redirectedRequests == 0)
        #expect(try Self.clientFrameOpcodes(clientData.value).allSatisfy { $0 == 0x8 })
    }

    @Test func `discovery keeps system certificate verification without creating trust`() async throws {
        let tls = try DashboardTLSFixture()
        var requests = 0
        let server = try await DashboardHTTPFixture.start(tlsIdentity: tls.identity, requestHandler: { _ in
            requests += 1
            return nil
        })
        defer { server.stop() }

        #expect(await !GatewayDiscoveryProbe.shared.hasGatewayChallenge(url: server.websocketURL(), timeout: 2))
        try await Self.waitForDisconnect(server)
        #expect(requests == 0)
    }

    @Test func `discovery refuses URL credentials before opening a socket`() async throws {
        var requests = 0
        let server = try await DashboardHTTPFixture.start(requestHandler: { _ in
            requests += 1
            return nil
        })
        defer { server.stop() }
        var url = try #require(URLComponents(url: server.websocketURL(), resolvingAgainstBaseURL: false))
        url.user = "synthetic-user"
        url.password = "synthetic-password"

        let candidate = try #require(url.url)
        #expect(await !GatewayDiscoveryProbe.shared.hasGatewayChallenge(url: candidate, timeout: 2))
        #expect(requests == 0)
        #expect(server.activeConnectionCount == 0)
    }

    private static func challengeResponse(
        _ request: String,
        cookieName: String? = nil,
        event: String = "connect.challenge") -> DashboardHTTPFixture.RawResponse?
    {
        guard let key = request.components(separatedBy: "\r\n")
            .first(where: { $0.lowercased().hasPrefix("sec-websocket-key:") })?
            .split(separator: ":", maxSplits: 1).last?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        else { return nil }
        let accept = Data(Insecure.SHA1.hash(data: Data(
            "\(key)258EAFA5-E914-47DA-95CA-C5AB0DC85B11".utf8))).base64EncodedString()
        let cookie = cookieName.map { "Set-Cookie: \($0)=synthetic-peer-cookie; Path=/\r\n" } ?? ""
        let headers = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            "Sec-WebSocket-Accept: \(accept)\r\n\(cookie)\r\n"
        let challenge = Data(#"{"type":"event","event":"\#(event)","payload":{"nonce":"synthetic"}}"#.utf8)
        precondition(challenge.count < 126)
        let frame = Data([0x81, UInt8(challenge.count)]) + challenge
        return .init(data: Data(headers.utf8) + frame, keepConnectionOpen: true)
    }

    private static func clientFrameOpcodes(_ data: Data) throws -> [UInt8] {
        let bytes = [UInt8](data)
        var index = 0
        var opcodes: [UInt8] = []
        while index < bytes.count {
            try #require(index + 2 <= bytes.count, "Incomplete client WebSocket frame")
            let length = Int(bytes[index + 1] & 0x7F)
            try #require(length < 126, "Discovery sent an unexpected large client frame")
            let maskBytes = bytes[index + 1] & 0x80 == 0 ? 0 : 4
            let end = index + 2 + maskBytes + length
            try #require(end <= bytes.count, "Incomplete client WebSocket payload")
            opcodes.append(bytes[index] & 0x0F)
            index = end
        }
        return opcodes
    }

    private static func waitForDisconnect(_ server: DashboardHTTPFixture) async throws {
        let deadline = ContinuousClock.now + .seconds(3)
        while server.activeConnectionCount > 0, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        try #require(server.activeConnectionCount == 0, "Discovery left its candidate socket open")
    }
}
