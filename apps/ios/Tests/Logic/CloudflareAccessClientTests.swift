import Foundation
import Testing

struct CloudflareAccessClientTests {
    private actor Requests {
        var requests: [URLRequest] = []
        var responses: [(Data, HTTPURLResponse)]

        init(_ responses: [(Data, HTTPURLResponse)]) {
            self.responses = responses
        }

        func send(_ request: URLRequest, maximumBytes: Int) throws -> (Data, HTTPURLResponse) {
            self.requests.append(request)
            let response = try #require(self.responses.first)
            self.responses.removeFirst()
            return response
        }
    }

    private func response(_ url: URL, _ status: Int, headers: [String: String] = [:]) throws -> HTTPURLResponse {
        try #require(HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers))
    }

    @Test func `credentials stay on the exact HTTPS or WSS authority`() throws {
        let session = try CloudflareAccessTestTokens().session()
        for value in [
            "https://gateway.example.test:8443/api?file=one", "wss://gateway.example.test:8443/socket",
        ] {
            let url = try #require(URL(string: value))
            #expect(session.authorizationHeader(for: url) != nil)
        }
        for value in [
            "https://gateway.example.test/", "https://gateway.example.test:443/",
            "https://other.example.test:8443/", "http://gateway.example.test:8443/",
            "https://user@gateway.example.test:8443/", "https://gateway.example.test:8443/#fragment",
        ] {
            let url = try #require(URL(string: value))
            #expect(session.authorizationHeader(for: url) == nil)
        }
        #expect(session.authorizationHeader(for: session.origin.url, now: session.expiresAt) == nil)
        #expect(!String(describing: session).contains("test-subject"))
        #expect(!String(reflecting: session).contains("test-key"))
    }

    @Test func `normal preauthenticated or WARP access needs no browser discovery`() async throws {
        let application = try CloudflareAccessTestTokens.application()
        let requests = try Requests([(Data(), self.response(application.origin.url, 200, headers: [
            "Server": "cloudflare", "Cf-Access-Metadata": "metadata-is-not-a-login-challenge",
        ]))])
        let client = CloudflareAccessClient(request: { request, limit in
            try await requests.send(request, maximumBytes: limit)
        })
        #expect(try await client.discover(gatewayURL: application.origin.url) == nil)
        #expect(await requests.requests.count == 1)
    }

    @Test func `generic Cloudflare errors and foreign challenges do not launch Access auth`() throws {
        let origin = try CloudflareAccessTestTokens.application().origin
        let foreign = "Cloudflare-Access resource_metadata=\"https://other.example.test/.well-known/cloudflare-access-protected-resource/\""
        let alternatePort = "Cloudflare-Access resource_metadata=\"https://gateway.example.test/.well-known/cloudflare-access-protected-resource/\""
        for headers in [["Server": "cloudflare"], ["WWW-Authenticate": foreign], ["WWW-Authenticate": alternatePort]] {
            #expect(try !CloudflareAccessClient.isChallenge(
                self.response(origin.url, 403, headers: headers),
                origin: origin))
        }
        let valid = "Cloudflare-Access resource_metadata=\"\(origin.url.absoluteString)/.well-known/cloudflare-access-protected-resource/\""
        #expect(try CloudflareAccessClient.isChallenge(
            self.response(origin.url, 302, headers: ["WWW-Authenticate": valid]), origin: origin))
        #expect(try !CloudflareAccessClient.isChallenge(
            self.response(origin.url, 200, headers: ["WWW-Authenticate": valid]), origin: origin))
    }

    @Test(arguments: [
        "/other/mcp", "/.well-known/cloudflare-access-protected-resource-spoof/mcp",
        "/.well-known/cloudflare-access-protected-resource/mcp?redirect=other",
        "/.well-known/cloudflare-access-protected-resource/mcp#fragment",
    ])
    func `rejects metadata namespace lookalikes and URL decorations`(path: String) throws {
        let origin = try CloudflareAccessTestTokens.application().origin
        let header = "Bearer resource_metadata=\"\(origin.url.absoluteString)\(path)\""
        #expect(try !CloudflareAccessClient.isChallenge(
            self.response(origin.url, 401, headers: ["WWW-Authenticate": header]), origin: origin))
    }

    @Test(arguments: ["https", "wss"], ["", "/", "/mcp", "/gateway/socket", "/gateway%20space/%2Fsocket"])
    func `admits resource-specific challenges only after verified same-host metadata`(
        scheme: String,
        path: String) async throws
    {
        let tokens = try CloudflareAccessTestTokens()
        let application = try CloudflareAccessTestTokens.application()
        let metadata = try tokens.token([
            "type": "match", "hostname": "gateway.example.test", "auth_domain": "example.cloudflareaccess.com",
            "aud": application.audience, "iat": Date().timeIntervalSince1970,
        ])
        let gatewayURL = try #require(URL(string: "\(scheme)://gateway.example.test:8443\(path)"))
        let expectedURL = try #require(URL(string: application.origin.url.absoluteString + (path.isEmpty ? "/" : path)))
        let challenge = "Cloudflare-Access resource_metadata=\"\(application.origin.url.absoluteString)/.well-known/cloudflare-access-protected-resource\(path)\""
        let requests = try Requests([
            (Data(), self.response(expectedURL, 302, headers: ["WWW-Authenticate": challenge])),
            (Data(), self.response(expectedURL, 200, headers: ["Cf-Access-Metadata": metadata])),
            (tokens.jwks, self.response(application.issuer.appendingPathComponent("cdn-cgi/access/certs"), 200)),
        ])
        let client = CloudflareAccessClient(request: { request, limit in
            try await requests.send(request, maximumBytes: limit)
        })
        #expect(try await client.discover(gatewayURL: gatewayURL) == application)
        let sent = await requests.requests
        #expect(sent.map(\.httpMethod) == ["GET", "HEAD", "GET"])
        #expect(sent.prefix(2).allSatisfy { $0.url == expectedURL })
        #expect(sent.prefix(2).allSatisfy { $0.url?.absoluteString == expectedURL.absoluteString })
        #expect(sent[1].value(forHTTPHeaderField: "Cf-Access-Metadata-Request") == "true")
        #expect(sent.allSatisfy { $0.value(forHTTPHeaderField: "Cookie") == nil })
    }

    @Test func `app grant requires signature audience expiry and matching identity`() async throws {
        let tokens = try CloudflareAccessTestTokens()
        let application = try CloudflareAccessTestTokens.application()
        let session = try tokens.session()
        let token = try #require(session.authorizationHeader(for: application.origin.url))
        let requests = try Requests([
            (tokens.jwks, self.response(application.issuer.appendingPathComponent("cdn-cgi/access/certs"), 200)),
            (
                Data(#"{"user_uuid":"test-subject"}"#.utf8),
                self.response(application.origin.url.appendingPathComponent("cdn-cgi/access/get-identity"), 200)),
        ])
        let client = CloudflareAccessClient(request: { request, limit in
            try await requests.send(request, maximumBytes: limit)
        })
        let verified = try await client.verifiedSession(token: token, application: application)
        #expect(verified.subject == "test-subject")
        let sent = await requests.requests
        #expect(sent[0].value(forHTTPHeaderField: "Cookie") == nil)
        #expect(sent[1].value(forHTTPHeaderField: "Cookie") == "CF_Authorization=\(token)")
        #expect(sent[1].value(forHTTPHeaderField: "Cf-Access-Token") == nil)
        #expect(sent.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == nil })
        var altered = token.split(separator: ".").map(String.init)
        altered[2] = String(altered[2].reversed())
        #expect(throws: CloudflareAccessError.self) {
            try CloudflareAccessJWT.verify(altered.joined(separator: "."), jwks: tokens.jwks)
        }
        for change: [String: Any] in [
            ["aud": ["another-app"]], ["iss": "https://other.cloudflareaccess.com"],
            ["type": "org"], ["exp": 1], ["nbf": Date().addingTimeInterval(3600).timeIntervalSince1970], ["sub": ""],
        ] {
            var claims: [String: Any] = [
                "iss": application.issuer.absoluteString, "aud": [application.audience],
                "type": "app", "sub": "test-subject", "exp": Date().addingTimeInterval(3600).timeIntervalSince1970,
            ]
            claims.merge(change) { _, new in new }
            let invalid = try tokens.token(claims)
            #expect(throws: CloudflareAccessError.self) {
                try CloudflareAccessJWT.appClaims(invalid, application: application)
            }
        }
    }

    @Test func `rejects another identity even with a valid app signature`() async throws {
        let tokens = try CloudflareAccessTestTokens()
        let application = try CloudflareAccessTestTokens.application()
        let session = try tokens.session()
        let token = try #require(session.authorizationHeader(for: application.origin.url))
        let requests = try Requests([
            (tokens.jwks, self.response(application.issuer.appendingPathComponent("cdn-cgi/access/certs"), 200)),
            (
                Data(#"{"user_uuid":"different-subject"}"#.utf8),
                self.response(application.origin.url.appendingPathComponent("cdn-cgi/access/get-identity"), 200)),
        ])
        let client = CloudflareAccessClient(request: { request, limit in
            try await requests.send(request, maximumBytes: limit)
        })
        await #expect(throws: CloudflareAccessError.self) {
            try await client.verifiedSession(token: token, application: application)
        }
    }

    @Test func `rejects wrong-host stale and non-RS256 metadata`() throws {
        let tokens = try CloudflareAccessTestTokens()
        let application = try CloudflareAccessTestTokens.application()
        let claims: [String: Any] = [
            "type": "match", "hostname": "gateway.example.test", "auth_domain": "example.cloudflareaccess.com",
            "aud": application.audience, "iat": Date().timeIntervalSince1970,
        ]
        let wrongAlgorithm = try tokens.token(claims, algorithm: "HS256")
        #expect(throws: CloudflareAccessError.self) { try CloudflareAccessJWT.verify(wrongAlgorithm, jwks: tokens.jwks)
        }
        for change: [String: Any] in [
            ["hostname": "other.example.test"], ["type": "other"], ["aud": ""], ["iat": 1],
            ["iat": Date().addingTimeInterval(3600).timeIntervalSince1970],
        ] {
            var changed = claims
            changed.merge(change) { _, new in new }
            let token = try tokens.token(changed)
            try CloudflareAccessJWT.verify(token, jwks: tokens.jwks)
            let metadata = try CloudflareAccessJWT.decode(CloudflareAccessJWT.Metadata.self, token: token)
            #expect(throws: CloudflareAccessError.self) {
                try CloudflareAccessJWT.application(metadata: metadata, origin: application.origin)
            }
        }
    }

    @Test(arguments: [
        "example.test",
        "cloudflareaccess.com",
        ".cloudflareaccess.com",
        "https://example.cloudflareaccess.com",
        "example.cloudflareaccess.com:443",
        "example.cloudflareaccess.com/path",
        "x.example.cloudflareaccess.com",
    ])
    func `rejects unconstrained metadata issuers`(domain: String) {
        #expect(throws: CloudflareAccessError.self) { try CloudflareAccessJWT.issuer(authDomain: domain) }
    }
}
