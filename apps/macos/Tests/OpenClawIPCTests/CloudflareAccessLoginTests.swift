import Foundation
import Testing
@testable import OpenClaw

struct CloudflareAccessLoginTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func `discovery supports configured hosts and dashboard mounts`() throws {
        let gateway = try #require(URL(string: "https://gateway.example.net:8443/dashboard/"))
        let application = try CloudflareAccessLogin.application(
            gatewayURL: gateway, metadata: self.metadata(), now: self.now)
        #expect(application.gatewayURL == gateway)
        let claims = try CloudflareAccessLogin.claims(
            token: self.token(), application: application, now: self.now)
        #expect(claims.sub == "user-42")
        #expect(claims.exp == self.now.timeIntervalSince1970 + 3600)
    }

    @Test(arguments: [
        ("absent", nil, "gateway.example.net"),
        ("null", nil, "gateway.example.net"),
        ("empty", "", "gateway.example.net"),
        ("different", "app.example.net", "app.example.net"),
        ("wildcard", "*.example.net", "-.example.net"),
        ("path", "gateway.example.net/dashboard/*", "gateway.example.net-dashboard--"),
        ("case", "*.Example.NET/Dashboard/*", "-.Example.NET-Dashboard--"),
    ] as [(String, String?, String)])
    func `companion discovery follows the helper application hostname`(
        _ shape: String, _ hostname: String?, _ basename: String) throws
    {
        var metadata = self.metadataClaims
        metadata["aud"] = "Application-123"
        metadata["app_hostname"] = hostname
        if shape == "null" { metadata["app_hostname"] = NSNull() }
        let gateway = try #require(URL(string: "https://gateway.example.net/"))
        let application = try CloudflareAccessLogin.application(
            gatewayURL: gateway, metadata: self.jwt(metadata), now: self.now)
        #expect(application.handoffFilename == "\(basename)-Application-123-token.url")
        #expect(application.gatewayURL == gateway)

        metadata["hostname"] = "other.example.net"
        #expect(throws: CloudflareAccessLogin.LoginError.self) {
            try CloudflareAccessLogin.application(gatewayURL: gateway, metadata: self.jwt(metadata), now: self.now)
        }
    }

    @Test(arguments: ["hostname", "application-hostname", "issuer", "audience", "stale", "future", "algorithm"])
    func `rejects malformed or mismatched advertised discovery`(_ mutation: String) throws {
        var claims = self.metadataClaims
        var algorithm = "RS256"
        switch mutation {
        case "hostname": claims["hostname"] = "other.example.net"
        case "application-hostname": claims["app_hostname"] = 42
        case "issuer": claims["auth_domain"] = "tenant.cloudflareaccess.com.attacker.example"
        case "audience": claims["aud"] = ""
        case "stale": claims["iat"] = self.now.timeIntervalSince1970 - 86401
        case "future": claims["iat"] = self.now.timeIntervalSince1970 + 301
        default: algorithm = "none"
        }
        let metadata = try self.jwt(claims, algorithm: algorithm)
        let gateway = try #require(URL(string: "https://gateway.example.net/"))
        #expect(throws: CloudflareAccessLogin.LoginError.self) {
            try CloudflareAccessLogin.application(gatewayURL: gateway, metadata: metadata, now: self.now)
        }
    }

    @Test(arguments: [
        "http://gateway.example.net/", "https://user@gateway.example.net/",
        "https://gateway.example.net/?token=secret", "https://gateway.example.net/#token=secret",
    ])
    func `does not launch credential-bearing or insecure gateway URLs`(_ value: String) throws {
        let gateway = try #require(URL(string: value))
        let metadata = try self.metadata()
        #expect(throws: CloudflareAccessLogin.LoginError.self) {
            try CloudflareAccessLogin.application(gatewayURL: gateway, metadata: metadata, now: self.now)
        }
    }

    @Test func `discovery rejects URL password credentials`() throws {
        var address = try #require(URLComponents(string: "https://gateway.example.net/"))
        address.user = "fixture-user"
        address.password = "fixture-password"
        let gateway = try #require(address.url)
        let metadata = try self.metadata()
        #expect(throws: CloudflareAccessLogin.LoginError.self) {
            try CloudflareAccessLogin.application(gatewayURL: gateway, metadata: metadata, now: self.now)
        }
    }

    @Test(arguments: ["issuer", "audience", "organization", "expired", "not-yet-valid", "subject", "size"])
    func `rejects helper results outside the discovered application session`(_ mutation: String) throws {
        var claims = self.tokenClaims
        switch mutation {
        case "issuer": claims["iss"] = "https://other.cloudflareaccess.com"
        case "audience": claims["aud"] = ["other-application"]
        case "organization": claims["type"] = "org"
        case "expired": claims["exp"] = self.now.timeIntervalSince1970
        case "not-yet-valid": claims["nbf"] = self.now.timeIntervalSince1970 + 1
        case "subject": claims["sub"] = ""
        default: claims["extra"] = String(repeating: "x", count: 32768)
        }
        let application = try self.application()
        let token = try self.jwt(claims)
        #expect(throws: CloudflareAccessLogin.LoginError.self) {
            try CloudflareAccessLogin.claims(token: token, application: application, now: self.now)
        }
    }

    @Test func `accepts the upstream string audience representation`() throws {
        var claims = self.tokenClaims
        claims["aud"] = "application-123"
        let result = try CloudflareAccessLogin.claims(
            token: self.jwt(claims), application: self.application(), now: self.now)
        #expect(result.aud.values == ["application-123"])
    }

    @Test(arguments: [
        "valid",
        "host",
        "port",
        "scheme",
        "credentials",
        "path",
        "fragment",
        "audience",
        "redirect",
        "duplicate",
        "oversized",
        "partial",
    ])
    func `private helper handoff remains bound to its application`(_ mutation: String) throws {
        var parts = try #require(URLComponents(string: "https://gateway.example.net/cdn-cgi/access/cli"))
        let transferKey = Data(repeating: 7, count: 32).base64EncodedString()
        var redirect = try #require(URLComponents(string: "https://gateway.example.net/dashboard/"))
        redirect.queryItems = [
            URLQueryItem(name: "token", value: transferKey),
            URLQueryItem(name: "aud", value: "application-123"),
        ]
        parts.queryItems = [
            URLQueryItem(name: "token", value: mutation == "partial" ? String(transferKey.dropLast()) : transferKey),
            URLQueryItem(name: "aud", value: mutation == "audience" ? "other" : "application-123"),
            URLQueryItem(name: "edge_token_transfer", value: "true"),
            URLQueryItem(name: "send_org_token", value: "true"),
            URLQueryItem(name: "close_interstitial", value: "true"),
            URLQueryItem(
                name: "redirect_url",
                value: mutation == "redirect"
                    ? "https://other.example/" : redirect.string),
        ]
        switch mutation {
        case "host": parts.host = "other.example"
        case "port": parts.port = 8443
        case "scheme": parts.scheme = "http"
        case "credentials": parts.user = "unexpected"
        case "path": parts.path = "/other"
        case "fragment": parts.fragment = "unexpected"
        case "duplicate": parts.queryItems?.append(URLQueryItem(name: "aud", value: "application-123"))
        case "oversized": parts.queryItems?.append(URLQueryItem(
                name: "extra",
                value: String(repeating: "x", count: 16385)))
        default: break
        }
        let data = try Data(#require(parts.string).utf8)
        #expect(try (CloudflareAccessLogin.handoffURL(data: data, application: self.application()) != nil)
            == (mutation == "valid"))
    }

    @MainActor
    @Test(arguments: [
        ("https://tenant.cloudflareaccess.com/cdn-cgi/access/login/embed.example.net", true),
        ("https://tenant.cloudflareaccess.com/cdn-cgi/access/login/embed.example.net?redirect_url=%2F", true),
        ("https://other.cloudflareaccess.com/cdn-cgi/access/login/embed.example.net", false),
        ("https://tenant.cloudflareaccess.com/other/embed.example.net", false),
        ("https://tenant.cloudflareaccess.com/cdn-cgi/access/login/gateway.example.net", false),
        ("https://tenant.cloudflareaccess.com/cdn-cgi/access/login/-embed.example.net", false),
        ("https://tenant.cloudflareaccess.com/cdn-cgi/access/login/embed..example.net", false),
        ("https://tenant.cloudflareaccess.com/cdn-cgi/access/login/embed.example.net/extra", false),
        ("https://tenant.cloudflareaccess.com/cdn-cgi/access/login/embed%2Eexample.net", false),
        ("https://tenant.cloudflareaccess.com/cdn-cgi/access/login/127.0.0.1", false),
        ("https://user@tenant.cloudflareaccess.com/cdn-cgi/access/login/embed.example.net", false),
        ("https://tenant.cloudflareaccess.com:8443/cdn-cgi/access/login/embed.example.net", false),
        ("http://tenant.cloudflareaccess.com/cdn-cgi/access/login/embed.example.net", false),
        ("https://tenant.cloudflareaccess.com/cdn-cgi/access/login/embed.example.net#fragment", false),
    ])
    func `embedded login detection requires the current issuer and a DNS application`(
        _ value: String, _ accepted: Bool) throws
    {
        let gateway = try self.session(host: "gateway.example.net")
        let detected = try CloudflareAccessEmbedLogin.applicationURL(
            loginURL: #require(URL(string: value)), gateway: gateway, now: self.now)
        #expect((detected != nil) == accepted)
        if accepted { #expect(detected?.absoluteString == "https://embed.example.net/") }
        #expect(try CloudflareAccessEmbedLogin.applicationURL(
            loginURL: #require(URL(string: value)),
            gateway: gateway,
            now: self.now.addingTimeInterval(3601)) == nil)
    }

    @MainActor
    @Test(arguments: [
        ("app.example.com", "gateway.example.com", true),
        ("example.com", "gateway.example.com", true),
        ("app.example.com", "example.com", true),
        ("app.other.com", "gateway.example.com", false),
        ("app.example.org", "gateway.example.com", false),
        ("a.example.co", "b.example.io", false),
        ("app.com", "gateway.com", false),
        ("embed.apps.example.com", "gateway.example.com", true),
        ("Embed.Apps.Example.COM", "Gateway.Example.COM", true),
        ("app.first.co.uk", "gateway.second.co.uk", true),
        ("a.co.uk", "b.co.uk", true),
    ])
    func `embedded sign in uses a host suffix sanity check before measuring cookie delivery`(
        _ embedHost: String, _ gatewayHost: String, _ accepted: Bool) async throws
    {
        let gateway = try self.session(host: gatewayHost)
        let embed = try self.session(host: embedHost)
        let app = try self.embedApplication(host: embedHost)
        let loginURL = try #require(URL(
            string: "https://tenant.cloudflareaccess.com/cdn-cgi/access/login/\(embedHost)"))
        #expect(CloudflareAccessEmbedLogin.applicationURL(
            loginURL: loginURL, gateway: gateway, now: self.now) == (accepted ? embed.origin : nil))
        var discoveries = 0
        var helpers = 0
        let owner = CloudflareAccessEmbedLogin(
            discover: { _ in
                discoveries += 1
                return app
            },
            signIn: { _, _ in
                helpers += 1
                return embed
            },
            now: { self.now })
        #expect(try await owner.signIn(
            appURL: embed.origin, gateway: gateway, isCurrent: { true }) == (accepted ? embed : nil))
        #expect(discoveries == (accepted ? 1 : 0))
        #expect(helpers == (accepted ? 1 : 0))
    }

    @MainActor
    @Test func `concurrent embedded requests share one helper and every outcome delays retry`() async throws {
        let gateway = try self.session(host: "gateway.example.net")
        let embed = try self.session(host: "embed.example.net")
        let app = try self.embedApplication()
        var clock = self.now
        var runs = 0
        var pending: CheckedContinuation<Void, Never>?
        var started: CheckedContinuation<Void, Never>?
        let owner = CloudflareAccessEmbedLogin(
            discover: { _ in app },
            signIn: { _, _ in
                runs += 1
                if runs == 1 {
                    await withCheckedContinuation { continuation in
                        pending = continuation
                        started?.resume()
                    }
                    throw CloudflareAccessLogin.LoginError.timedOut
                }
                return embed
            },
            now: { clock })
        let first = Task { try await owner.signIn(appURL: embed.origin, gateway: gateway, isCurrent: { true }) }
        await withCheckedContinuation { continuation in started = continuation }
        let second = Task { @MainActor in
            // Resume the suspended helper on this actor, then join its flight before it resumes.
            pending?.resume()
            return try await owner.signIn(appURL: embed.origin, gateway: gateway, isCurrent: { true })
        }
        for task in [first, second] {
            await #expect(throws: CloudflareAccessLogin.LoginError.self) { try await task.value }
        }
        #expect(runs == 1)
        #expect(try await owner.signIn(appURL: embed.origin, gateway: gateway, isCurrent: { true }) == nil)
        #expect(runs == 1)
        clock.addTimeInterval(120)
        #expect(try await owner.signIn(appURL: embed.origin, gateway: gateway, isCurrent: { true }) == embed)
        #expect(runs == 2)
        #expect(try await owner.signIn(appURL: embed.origin, gateway: gateway, isCurrent: { true }) == nil)
        clock.addTimeInterval(119)
        #expect(try await owner.signIn(appURL: embed.origin, gateway: gateway, isCurrent: { true }) == nil)
        #expect(runs == 2)
        clock.addTimeInterval(1)
        #expect(try await owner.signIn(appURL: embed.origin, gateway: gateway, isCurrent: { true }) == embed)
        #expect(runs == 3)
    }

    @MainActor
    @Test func `a previous account failure does not delay the new account`() async throws {
        let firstGateway = try self.session(host: "gateway.example.net")
        let nextGateway = try self.session(host: "gateway.example.net", subject: "next-user")
        let nextEmbed = try self.session(host: "embed.example.net", subject: "next-user")
        let app = try self.embedApplication()
        var runs = 0
        let owner = CloudflareAccessEmbedLogin(
            discover: { _ in app },
            signIn: { _, _ in
                runs += 1
                if runs == 1 { throw CloudflareAccessLogin.LoginError.loginFailed }
                return nextEmbed
            },
            now: { self.now })
        await #expect(throws: CloudflareAccessLogin.LoginError.self) {
            try await owner.signIn(appURL: nextEmbed.origin, gateway: firstGateway, isCurrent: { true })
        }
        #expect(try await owner.signIn(
            appURL: nextEmbed.origin, gateway: firstGateway, isCurrent: { true }) == nil)
        #expect(try await owner.signIn(
            appURL: nextEmbed.origin, gateway: nextGateway, isCurrent: { true }) == nextEmbed)
        #expect(runs == 2)
    }

    @MainActor
    @Test(arguments: ["issuer", "subject", "cancelled", "superseded"])
    func `embedded results cannot cross an account or cancelled authority`(_ mutation: String) async throws {
        let gateway = try self.session(host: "gateway.example.net")
        let embed = try self.session(
            host: "embed.example.net",
            subject: mutation == "subject" ? "other-user" : "user-42",
            issuer: mutation == "issuer" ? "https://other.cloudflareaccess.com" : "https://tenant.cloudflareaccess.com")
        let app = try self.embedApplication()
        var current = true
        var runs = 0
        let owner = CloudflareAccessEmbedLogin(
            discover: { _ in app },
            signIn: { _, _ in
                runs += 1
                if mutation == "cancelled" { throw CancellationError() }
                if mutation == "superseded" { current = false }
                return embed
            },
            now: { self.now })
        await #expect(throws: (any Error).self) {
            try await owner.signIn(appURL: embed.origin, gateway: gateway, isCurrent: { current })
        }
        current = true
        #expect(try await owner.signIn(appURL: embed.origin, gateway: gateway, isCurrent: { current }) == nil)
        #expect(runs == 1)
    }

    @MainActor
    @Test func `another discovered issuer never opens browser sign in`() async throws {
        let gateway = try self.session(host: "gateway.example.net")
        let app = try self.embedApplication(issuerHost: "other.cloudflareaccess.com")
        var runs = 0
        let owner = CloudflareAccessEmbedLogin(
            discover: { _ in app },
            signIn: { _, _ in
                runs += 1
                throw CloudflareAccessLogin.LoginError.loginFailed
            },
            now: { self.now })
        #expect(try await owner.signIn(
            appURL: #require(URL(string: "https://embed.example.net/")), gateway: gateway, isCurrent: { true }) == nil)
        #expect(runs == 0)
    }

    @MainActor
    @Test func `a new account signs in while the previous account helper is still running`() async throws {
        let gatewayA = try self.session(host: "gateway.example.net")
        let gatewayB = try self.session(host: "gateway.example.net", subject: "user-b")
        let embedA = try self.session(host: "embed.example.net")
        let embedB = try self.session(host: "embed.example.net", subject: "user-b")
        let app = try self.embedApplication()
        var currentA = true
        var runs = 0
        var pendingA: CheckedContinuation<Void, Never>?
        var startedA: CheckedContinuation<Void, Never>?
        let owner = CloudflareAccessEmbedLogin(
            discover: { _ in app },
            signIn: { _, _ in
                runs += 1
                if runs == 1 {
                    await withCheckedContinuation { continuation in
                        pendingA = continuation
                        startedA?.resume()
                    }
                    return embedA
                }
                return embedB
            },
            now: { self.now })
        let first = Task {
            try await owner.signIn(appURL: embedA.origin, gateway: gatewayA, isCurrent: { currentA })
        }
        await withCheckedContinuation { continuation in startedA = continuation }
        currentA = false
        let second: Result<GatewayBrowserSession?, Error>
        do {
            second = try await .success(owner.signIn(
                appURL: embedB.origin, gateway: gatewayB, isCurrent: { true }))
        } catch {
            second = .failure(error)
        }
        #expect(runs == 2)
        pendingA?.resume()
        await #expect(throws: CancellationError.self) { try await first.value }
        #expect(try second.get() == embedB)
    }

    @MainActor
    @Test func `reintercept after cookie installation logs once and blocks until expiry or relaunch`() async throws {
        let gateway = try self.session(host: "gateway.example.net", lifetime: 172_800)
        let embed = try self.session(host: "embed.example.net", lifetime: 172_800)
        let app = try self.embedApplication()
        var clock = self.now
        var runs = 0
        var blockedHosts: [String] = []
        let owner = CloudflareAccessEmbedLogin(
            discover: { _ in app },
            signIn: { _, _ in
                runs += 1
                return embed
            },
            now: { clock },
            logCookieBlocked: { blockedHosts.append($0) })
        #expect(try await owner.signIn(appURL: embed.origin, gateway: gateway, isCurrent: { true }) == embed)
        owner.recordCookieInstallation(appURL: embed.origin, gateway: gateway)
        clock.addTimeInterval(60)
        #expect(try await owner.signIn(appURL: embed.origin, gateway: gateway, isCurrent: { true }) == nil)
        #expect(try await owner.signIn(appURL: embed.origin, gateway: gateway, isCurrent: { true }) == nil)
        #expect(runs == 1)
        #expect(blockedHosts == ["embed.example.net"])

        // Persisted cookies are not installation receipts in a new process.
        let relaunched = CloudflareAccessEmbedLogin(
            discover: { _ in app },
            signIn: { _, _ in
                runs += 1
                return embed
            },
            now: { clock },
            logCookieBlocked: { blockedHosts.append($0) })
        #expect(try await relaunched.signIn(appURL: embed.origin, gateway: gateway, isCurrent: { true }) == embed)
        #expect(runs == 2)
        clock.addTimeInterval(86399)
        #expect(try await owner.signIn(appURL: embed.origin, gateway: gateway, isCurrent: { true }) == nil)
        clock.addTimeInterval(1)
        #expect(try await owner.signIn(appURL: embed.origin, gateway: gateway, isCurrent: { true }) == embed)
        #expect(runs == 3)
        #expect(blockedHosts == ["embed.example.net"])
    }

    @MainActor
    @Test(arguments: ["account-change", "sign-out"])
    func `account lifecycle clears cookie suppression without replaying stale receipts`(_ change: String) async throws {
        let oldGateway = try self.session(host: "gateway.example.net")
        let subject = change == "account-change" ? "next-user" : "user-42"
        let nextGateway = try self.session(host: "gateway.example.net", subject: subject)
        var embed = try self.session(host: "embed.example.net")
        let app = try self.embedApplication()
        var clock = self.now
        var runs = 0
        var blockedHosts: [String] = []
        let owner = CloudflareAccessEmbedLogin(
            discover: { _ in app },
            signIn: { _, _ in
                runs += 1
                return embed
            },
            now: { clock },
            logCookieBlocked: { blockedHosts.append($0) })
        #expect(try await owner.signIn(appURL: embed.origin, gateway: oldGateway, isCurrent: { true }) == embed)
        owner.recordCookieInstallation(appURL: embed.origin, gateway: oldGateway)
        #expect(try await owner.signIn(appURL: embed.origin, gateway: oldGateway, isCurrent: { true }) == nil)
        #expect(blockedHosts.count == 1)
        clock.addTimeInterval(120)
        owner.setPrincipal(change == "account-change" ? nextGateway.browserDataPrincipal : nil)
        owner.recordCookieInstallation(appURL: embed.origin, gateway: oldGateway)
        embed = try self.session(host: "embed.example.net", subject: subject)
        #expect(try await owner.signIn(appURL: embed.origin, gateway: nextGateway, isCurrent: { true }) == embed)
        #expect(runs == 2)
        #expect(blockedHosts == ["embed.example.net"])
    }

    @MainActor
    @Test func `login after the installation measurement window does not suppress the app`() async throws {
        let gateway = try self.session(host: "gateway.example.net")
        let embed = try self.session(host: "embed.example.net")
        let app = try self.embedApplication()
        var clock = self.now
        var runs = 0
        var blockedHosts: [String] = []
        let owner = CloudflareAccessEmbedLogin(
            discover: { _ in app },
            signIn: { _, _ in
                runs += 1
                return embed
            },
            now: { clock },
            logCookieBlocked: { blockedHosts.append($0) })
        #expect(try await owner.signIn(appURL: embed.origin, gateway: gateway, isCurrent: { true }) == embed)
        owner.recordCookieInstallation(appURL: embed.origin, gateway: gateway)
        clock.addTimeInterval(301)
        #expect(try await owner.signIn(appURL: embed.origin, gateway: gateway, isCurrent: { true }) == embed)
        clock.addTimeInterval(120)
        #expect(try await owner.signIn(appURL: embed.origin, gateway: gateway, isCurrent: { true }) == embed)
        #expect(runs == 3)
        #expect(blockedHosts.isEmpty)
    }

    private func embedApplication(
        host: String = "embed.example.net", issuerHost: String = "tenant.cloudflareaccess.com") throws
        -> CloudflareAccessLogin.Application
    {
        var metadata = self.metadataClaims
        metadata["hostname"] = host
        metadata["auth_domain"] = issuerHost
        return try CloudflareAccessLogin.application(
            gatewayURL: #require(URL(string: "https://\(host)/")),
            metadata: self.jwt(metadata),
            now: self.now)
    }

    private func session(
        host: String,
        subject: String = "user-42",
        issuer: String = "https://tenant.cloudflareaccess.com",
        lifetime: TimeInterval = 3600) throws -> GatewayBrowserSession
    {
        var claims = self.tokenClaims
        claims["sub"] = subject
        claims["iss"] = issuer
        claims["exp"] = self.now.addingTimeInterval(lifetime).timeIntervalSince1970
        return try GatewayBrowserSession(
            origin: #require(URL(string: "https://\(host)/")),
            issuer: #require(URL(string: issuer)),
            audience: "application-123",
            subject: subject,
            token: self.jwt(claims),
            expiresAt: self.now.addingTimeInterval(lifetime))
    }

    private var metadataClaims: [String: Any] {
        [
            "type": "match",
            "hostname": "gateway.example.net",
            "auth_domain": "tenant.cloudflareaccess.com",
            "aud": "application-123",
            "iat": self.now.timeIntervalSince1970,
        ]
    }

    private var tokenClaims: [String: Any] {
        [
            "iss": "https://tenant.cloudflareaccess.com",
            "aud": ["application-123"],
            "type": "app",
            "sub": "user-42",
            "exp": self.now.timeIntervalSince1970 + 3600,
        ]
    }

    private func application() throws -> CloudflareAccessLogin.Application {
        try CloudflareAccessLogin.application(
            gatewayURL: #require(URL(string: "https://gateway.example.net/")),
            metadata: self.metadata(),
            now: self.now)
    }

    private func metadata() throws -> String {
        try self.jwt(self.metadataClaims)
    }

    private func token() throws -> String {
        try self.jwt(self.tokenClaims)
    }

    /// These tests cover claim binding, not signature validation: the pinned helper owns RS256
    /// verification and browser transfer before production invokes the result boundary.
    private func jwt(_ claims: [String: Any], algorithm: String = "RS256") throws -> String {
        let encode: (Data) -> String = {
            $0.base64EncodedString().replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        }
        return try [
            encode(JSONSerialization.data(withJSONObject: ["alg": algorithm])),
            encode(JSONSerialization.data(withJSONObject: claims)),
            encode(Data("signature-fixture".utf8)),
        ].joined(separator: ".")
    }
}
