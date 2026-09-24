import CryptoKit
import Foundation
import Network
import Observation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import os
import SafariServices
import Security
import Testing
@testable import OpenClaw

@MainActor
final class IngressTestBrowser: CloudflareAccessBrowserPresenting {
    var presented: [UUID] = []
    var dismissed: [UUID] = []
    var cancel: (() -> Void)?
    var dismissalGate: AsyncStream<Void>?
    var onDismiss: (() -> Void)?

    func open(_: URL, intentID: UUID, onCancel: @escaping () -> Void) async throws {
        self.presented.append(intentID)
        self.cancel = onCancel
    }

    func dismiss(intentID: UUID) async {
        self.dismissed.append(intentID)
        self.onDismiss?()
        self.cancel = nil
        if let dismissalGate {
            for await _ in dismissalGate {
                break
            }
        }
    }
}

@MainActor
final class IngressTestGate {
    private var continuation: CheckedContinuation<Void, Never>?
    private let start = AsyncStream<Void>.makeStream()
    private var released = false
    private(set) var started = false
    private(set) var settled = false
    var cancellationObserved = false

    func wait() async {
        await withCheckedContinuation { continuation in
            if self.released { continuation.resume() }
            else { self.continuation = continuation }
            self.started = true
            self.start.continuation.finish()
        }
        self.settled = true
    }

    func waitUntilStarted() async {
        for await _ in self.start.stream {}
    }

    func release() {
        self.released = true
        self.continuation?.resume()
        self.continuation = nil
    }
}

@MainActor
private final class IngressTestDeadline {
    let beforeSend = IngressTestGate()
    var expires = false
    private(set) var limits: [TimeInterval] = []

    func run(
        seconds: TimeInterval,
        operation: @escaping @Sendable () async throws -> (Data, HTTPURLResponse)) async throws
        -> (Data, HTTPURLResponse)
    {
        self.limits.append(seconds)
        if self.expires {
            await self.beforeSend.waitUntilStarted()
            throw CloudflareAccessError.connectionFailed
        }
        return try await AsyncTimeout.withTimeout(
            seconds: 0, onTimeout: { CloudflareAccessError.connectionFailed }, operation: operation)
    }
}

@MainActor
private final class IngressOriginStorage {
    var values: [CloudflareAccessOrigin: String] = [:]
    var deletionSucceeds = true
    var deleted: [CloudflareAccessOrigin] = []

    var persistence: CloudflareAccessSessionStore.Persistence {
        .init(
            load: { self.values[$0] },
            save: { self.values[$0] = $1
                return true
            },
            delete: {
                self.deleted.append($0)
                guard self.deletionSucceeds else { return false }
                self.values.removeValue(forKey: $0)
                return true
            })
    }

    func save(_ session: CloudflareAccessSession) throws {
        self.values[session.origin] = try #require(String(data: JSONEncoder().encode(session), encoding: .utf8))
    }
}

@MainActor
final class IngressTestHarness {
    let browser = IngressTestBrowser()
    let tokens: CloudflareAccessTestTokens
    let application: CloudflareAccessApplication
    var now = Date()
    var nextSession: CloudflareAccessSession
    var persisted: String?
    var requests: [URLRequest] = []
    var requestRoutes: [GatewayIngressController.Route] = []
    var profileRows: [GatewaySettingsStore.GatewayRegistryEntry] = []
    var nextProfilesRead: (() -> Void)?
    var savedOrigins: [CloudflareAccessOrigin?] = []
    var probeStableID: String?
    var probeGate: AsyncStream<Void>?
    var probeRequiresManagedGrant = false
    var probeStarted = false
    var probeDidStart: (() -> Void)?
    var pendingProbes = 0
    var probeFailure: URLError?
    var preauthenticated = false
    var loginRedirect = false
    var preauthenticatedStableIDs = Set<String>()
    var applicationsByStableID: [String: CloudflareAccessApplication] = [:]
    var beforeManagedProbe: ((URLRequest) async throws -> Void)?
    var revoked = false
    var retirements = 0
    var release = AsyncStream<Void>.makeStream()
    let stableID = "manual|gateway.example.test|8443"

    init() throws {
        self.tokens = try CloudflareAccessTestTokens()
        self.application = try CloudflareAccessTestTokens.application()
        self.nextSession = try self.tokens.session()
        self.profileRows = [.init(
            stableID: self.stableID,
            kind: .manual,
            name: "Gateway",
            host: "gateway.example.test",
            port: 8443,
            useTLS: true,
            lastConnectedAtMs: nil)]
    }

    var route: GatewayIngressController.Route {
        .init(url: self.application.origin.url, stableID: self.stableID, tls: nil)
    }

    func config(
        _ authorization: GatewayIngressAuthorization?,
        stableID: String? = nil,
        tls: GatewayTLSParams? = nil) throws -> GatewayConnectConfig
    {
        var components = try #require(URLComponents(url: route.url, resolvingAgainstBaseURL: false))
        components.scheme = "wss"
        let url = try #require(components.url)
        return GatewayConnectConfig(
            url: url,
            stableID: stableID ?? self.stableID,
            tls: tls,
            token: "gateway-token",
            bootstrapToken: nil,
            password: "gateway-password",
            nodeOptions: GatewayConnectOptions(
                role: "node",
                scopes: [],
                caps: [],
                commands: [],
                permissions: [:],
                clientId: "openclaw-ios",
                clientMode: "node",
                clientDisplayName: "Phone"),
            ingressAuthorization: authorization)
    }

    func controller(
        useSavedProfiles: Bool = false,
        persistence: CloudflareAccessSessionStore.Persistence? = nil,
        authenticate: CloudflareAccessSessionStore.Authenticate? = nil,
        requestFactory: (@Sendable (GatewayIngressController.Route) -> CloudflareAccessClient.Request)? = nil,
        requestDeadline: @escaping GatewayIngressController.RequestDeadline = { _, operation in try await operation() },
        retirement: ((CloudflareAccessOrigin) async -> Void)? = nil) -> GatewayIngressController
    {
        GatewayIngressController(
            persistence: persistence ?? .init(
                load: { _ in self.persisted },
                save: { _, value in
                    self.persisted = value
                    return true
                },
                delete: { _ in self.persisted = nil
                    return true
                }),
            browser: self.browser,
            authenticate: authenticate ?? { application, browser in
                try await browser(application.origin.url.appendingPathComponent("cdn-cgi/access/cli"))
                for await _ in self.release.stream {
                    break
                }
                try Task.checkCancellation()
                return self.nextSession
            },
            requestFactory: requestFactory ?? { route in
                { request, _ in
                    await self.record(route)
                    return try await self.respond(to: request, stableID: route.stableID)
                }
            },
            requestDeadline: requestDeadline,
            customHeaders: { _ in ["X-Existing-Ingress": "preserved"] },
            profiles: {
                let didRead = self.nextProfilesRead
                self.nextProfilesRead = nil
                didRead?()
                return useSavedProfiles ? GatewaySettingsStore.loadGatewayRegistry().entries : self.profileRows
            },
            saveProfileOrigin: { stableID, origin in
                self.savedOrigins.append(origin)
                if useSavedProfiles {
                    return GatewaySettingsStore.saveGatewayAccessOrigin(
                        stableID: stableID,
                        origin: origin)
                }
                guard let index = self.profileRows.firstIndex(where: { GatewayStableIdentifier.matches(
                    $0.stableID,
                    stableID) })
                else { return false }
                self.profileRows[index].accessOrigin = origin
                return true
            },
            now: { self.now },
            retireTransports: { origin in
                self.retirements += 1
                await retirement?(origin)
            })
    }

    func session(for application: CloudflareAccessApplication, subject: String) throws -> CloudflareAccessSession {
        let expires = self.nextSession.expiresAt
        let token = try self.tokens.token([
            "iss": application.issuer.absoluteString, "aud": [application.audience],
            "type": "app", "sub": subject, "exp": expires.timeIntervalSince1970,
        ])
        return CloudflareAccessSession(application: application, subject: subject, token: token, expiresAt: expires)
    }

    func record(_ route: GatewayIngressController.Route) {
        self.requestRoutes.append(route)
    }

    func respond(to request: URLRequest, stableID: String) async throws -> (Data, HTTPURLResponse) {
        if request.value(forHTTPHeaderField: "Cf-Access-Token") != nil {
            try await self.beforeManagedProbe?(request)
        }
        self.requests.append(request)
        if let probeFailure {
            throw probeFailure
        }
        let url = try #require(request.url)
        let application = self.applicationsByStableID[stableID] ?? self.application
        if let gate = probeGate, request.httpMethod != "HEAD", url.host == application.origin.url.host,
           !probeRequiresManagedGrant || request.value(forHTTPHeaderField: "Cf-Access-Token") != nil,
           probeStableID == nil || GatewayStableIdentifier.matches(probeStableID, stableID)
        {
            self.probeStarted = true
            self.pendingProbes += 1
            self.probeDidStart?()
            defer { self.pendingProbes -= 1 }
            for await _ in gate {
                break
            }
        }
        var fields: [String: String] = [:]
        var status = 200
        var data = Data()
        if url.host == application.issuer.host {
            data = self.tokens.jwks
        } else if request.httpMethod == "HEAD" {
            fields["Cf-Access-Metadata"] = try self.tokens.token([
                "type": "match", "hostname": application.origin.url.host!,
                "auth_domain": application.issuer.host!, "aud": application.audience,
                "iat": Date().timeIntervalSince1970,
            ])
        } else if !self.preauthenticated, !self.preauthenticatedStableIDs.contains(stableID),
                  self.revoked || request.value(forHTTPHeaderField: "Cf-Access-Token") == nil
        {
            status = 302
            if self.loginRedirect {
                fields["Location"] = "https://login.example.test/cdn-cgi/access/login?opaque=ignored"
            } else {
                fields["WWW-Authenticate"] =
                    "Cloudflare-Access resource_metadata=\"\(application.origin.url.absoluteString)" +
                    "/.well-known/cloudflare-access-protected-resource/\""
            }
        }
        return try (
            data,
            #require(HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: fields)))
    }
}

@MainActor
private final class IngressNativeTraffic {
    let gate = IngressTestGate()
    var holdNext = false
    var replaceFirst = false
    var firstToken = ""
    var metadata = ""
    var requests: [String] = []

    static func header(_ name: String, in request: String) -> String? {
        request.components(separatedBy: "\r\n").first {
            $0.lowercased().hasPrefix(name.lowercased() + ":")
        }?.split(separator: ":", maxSplits: 1).last?.trimmingCharacters(in: .whitespaces)
    }

    func respond(_ request: String) -> DashboardHTTPFixture.RawResponse {
        self.requests.append(request)
        let token = Self.header("Cf-Access-Token", in: request)
        let metadata = request.hasPrefix("HEAD ")
        // Only the sibling path challenges G1. The held original request would
        // still return 200 after replacement, so a late-success bug cannot hide behind a 302.
        let challenge = !metadata && (token == nil ||
            (self.replaceFirst && request.hasPrefix("GET /replacement ") && token == self.firstToken))
        let fields = metadata ? "Cf-Access-Metadata: \(self.metadata)\r\n" :
            challenge ? "Location: /cdn-cgi/access/login/fixture\r\n" : ""
        let body = metadata || challenge ? "" : "native gateway body"
        return .init(data: Data(("HTTP/1.1 \(challenge ? "302 Found" : "200 OK")\r\n" + fields +
                "Content-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n" + body).utf8))
    }
}

@MainActor
private struct IngressNativeFixture {
    let harness: IngressTestHarness
    let traffic: IngressNativeTraffic
    let server: DashboardHTTPFixture
    let identity: sec_identity_t
    let application: CloudflareAccessApplication
    let route: GatewayIngressController.Route
    let next: CloudflareAccessSession

    init() async throws {
        let resource = try #require(Bundle(for: IngressTestBrowser.self)
            .url(forResource: "GatewayIngressIdentity", withExtension: "p12"))
        var items: CFArray?
        try #require(try SecPKCS12Import(Data(contentsOf: resource) as CFData, [
            kSecImportExportPassphrase as String: "fixture",
            kSecImportToMemoryOnly as String: true,
        ] as CFDictionary, &items) == errSecSuccess)
        let imported = try #require((items as? [[String: Any]])?.first?[kSecImportItemIdentity as String])
        // Security guarantees a SecIdentity at this key; the import never touches Keychain.
        let identity = imported as! SecIdentity
        self.identity = try #require(sec_identity_create(identity))
        var certificate: SecCertificate?
        try #require(SecIdentityCopyCertificate(identity, &certificate) == errSecSuccess)
        let bytes = try SecCertificateCopyData(#require(certificate)) as Data
        let pin = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        let harness = try IngressTestHarness()
        self.harness = harness
        let traffic = IngressNativeTraffic()
        self.traffic = traffic
        let server = try await DashboardHTTPFixture.start(beforeResponse: {
            if traffic.holdNext { traffic.holdNext = false
                await traffic.gate.wait()
            }
        }, tlsIdentity: self.identity, rawResponseHandler: { traffic.respond($0) })
        self.server = server
        do {
            self.application = try CloudflareAccessApplication(
                origin: CloudflareAccessOrigin(server.url()), issuer: harness.application.issuer,
                audience: harness.application.audience)
            self.route = .init(url: server.url(), stableID: "native-main", tls: .init(
                required: true, expectedFingerprint: pin, allowTOFU: false, storeKey: nil))
            let first = try harness.session(for: self.application, subject: "native-first")
            self.next = try harness.session(for: self.application, subject: "native-next")
            harness.nextSession = self.next
            harness.persisted = try String(data: JSONEncoder().encode(first), encoding: .utf8)
            traffic.firstToken = try #require(first.authorizationHeader(for: server.url(), now: harness.now))
            traffic.metadata = try harness.tokens.token([
                "type": "match", "hostname": "127.0.0.1", "auth_domain": self.application.issuer.host!,
                "aud": self.application.audience, "iat": harness.now.timeIntervalSince1970,
            ])
            harness.profileRows = ["native-main", "native-peer"].map { .init(
                stableID: $0, kind: .manual, name: "Native fixture", host: "127.0.0.1",
                port: Int(server.port), useTLS: true, lastConnectedAtMs: nil) }
        } catch { server.stop()
            throw error
        }
    }

    func controller() -> GatewayIngressController {
        let origin = self.application.origin
        let keys = self.application.issuer.appendingPathComponent("cdn-cgi/access/certs")
        let jwks = self.harness.tokens.jwks
        return self.harness.controller(requestFactory: { route in
            let native = GatewayIngressController.request(for: route)
            return { request, maximumBytes in
                if let url = request.url, origin.contains(url) { return try await native(request, maximumBytes) }
                guard request.url == keys, request.httpMethod == "GET", (request.allHTTPHeaderFields ?? [:]).isEmpty
                else { throw CloudflareAccessError.invalidApplication }
                return try (jwks, #require(HTTPURLResponse(
                    url: keys, statusCode: 200, httpVersion: nil, headerFields: nil)))
            }
        }, requestDeadline: GatewayIngressController.withRequestDeadline)
    }

    func close(_ ingress: GatewayIngressController) async {
        self.traffic.gate.release()
        self.harness.release.continuation.finish()
        // Test cancellation must not skip the controller's explicit retirement.
        let cleanup = Task {
            for profile in self.harness.profileRows {
                try? await ingress.forget(stableID: profile.stableID)
            }
            self.server.stop()
        }
        await cleanup.value
    }
}

@MainActor
func waitForIngress(_ condition: () -> Bool) async throws {
    let deadline = ContinuousClock.now + .seconds(3)
    while !condition() {
        guard ContinuousClock.now < deadline else { throw URLError(.timedOut) }
        await Task.yield()
    }
}

@Suite(.serialized)
struct GatewayIngressControllerTests {
    @Test @MainActor
    func `registry isolation suspends waiters until snapshots are restored`() async {
        let defaults = UserDefaults.standard
        let key = "gateway.last.host"
        await GatewayPersistenceTestGate.shared.acquire()
        let previous = defaults.object(forKey: key)
        defaults.set("restored.example.com", forKey: key)
        GatewayPersistenceTestGate.shared.release()

        let holder = await GatewayRegistryTestIsolation()
        defaults.set("held.example.com", forKey: key)
        let attempting = IngressTestGate()
        var entered = false
        let contender = Task { @MainActor in
            attempting.release()
            let isolation = await GatewayRegistryTestIsolation()
            defer { isolation.restore() }
            entered = true
            #expect(defaults.object(forKey: key) == nil)
        }

        // The contender queues its acquisition before this actor can resume the suspended holder.
        await attempting.wait()
        #expect(!entered)
        #expect(defaults.string(forKey: key) == "held.example.com")
        holder.restore()
        await contender.value

        await GatewayPersistenceTestGate.shared.acquire()
        defer {
            defaults.removeObject(forKey: key)
            if let previous { defaults.set(previous, forKey: key) }
            GatewayPersistenceTestGate.shared.release()
        }
        #expect(entered)
        // The contender must snapshot the holder's restored value, never its temporary mutation.
        #expect(defaults.string(forKey: key) == "restored.example.com")
    }

    @Test @MainActor
    func `real managed authorization guards the native pinned HTTPS adapter`() async throws {
        let fixture = try await IngressNativeFixture()
        let ingress = fixture.controller()
        var foreignRequests: [String] = []
        var foreign: DashboardHTTPFixture?
        do {
            let other = try await DashboardHTTPFixture.start(tlsIdentity: fixture.identity, rawResponseHandler: {
                foreignRequests.append($0)
                return .init(data: Data("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".utf8))
            })
            foreign = other
            let old = try #require(try await ingress.prepare(
                route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()))
            let native = GatewayIngressController.request(for: fixture.route)
            var request = URLRequest(url: fixture.server.url("/media"), timeoutInterval: 5)
            request.allHTTPHeaderFields = try await old.headers(#require(request.url))
            let (data, response) = try await old.load(request) { try await native($0, 1024) }
            #expect((response as? HTTPURLResponse)?.statusCode == 200)
            #expect(data == Data("native gateway body".utf8))
            let sent = try #require(fixture.traffic.requests.last)
            #expect(IngressNativeTraffic.header("Cf-Access-Token", in: sent) == fixture.traffic.firstToken)
            #expect(IngressNativeTraffic.header("X-Existing-Ingress", in: sent) == "preserved")
            #expect(IngressNativeTraffic.header("Cookie", in: sent) == nil)
            #expect(IngressNativeTraffic.header("Authorization", in: sent) == nil)
            let before = fixture.traffic.requests.count
            let foreignNative = GatewayIngressController.request(for: .init(
                url: other.url(), stableID: "native-foreign", tls: fixture.route.tls))
            var wrong = request
            wrong.url = other.url()
            #expect(old.isCurrent())
            await #expect(throws: GatewayExternalAuthorizationError.self) {
                try await old.load(wrong) { try await foreignNative($0, 1024) }
            }
            #expect(foreignRequests.isEmpty)
            try await ingress.forget(stableID: fixture.route.stableID)
            #expect(!old.isCurrent())
            #expect(fixture.harness.persisted == nil)
            await #expect(throws: GatewayExternalAuthorizationError.self) {
                try await old.load(request) { try await native($0, 1024) }
            }
            #expect(fixture.traffic.requests.count == before)
            // The rejected authority is healthy with the same explicit pin, without any grant.
            let (_, healthy) = try await foreignNative(URLRequest(url: other.url(), timeoutInterval: 5), 1024)
            #expect(healthy.statusCode == 200)
            #expect(foreignRequests.count == 1)
            for field in ["Cf-Access-Token", "Cookie", "Authorization"] {
                #expect(IngressNativeTraffic.header(field, in: foreignRequests[0]) == nil)
            }
        } catch {
            await fixture.close(ingress)
            foreign?.stop()
            throw error
        }
        await fixture.close(ingress)
        foreign?.stop()
    }

    @Test(arguments: ["revoke", "replace"]) @MainActor
    func `native discovery cancellation cannot admit a retired grant`(transition: String) async throws {
        let fixture = try await IngressNativeFixture()
        let ingress = fixture.controller()
        var pending: Task<[String: String], Error>?
        var changing: Task<GatewayIngressAuthorization?, Error>?
        func drain() async {
            fixture.traffic.gate.release()
            fixture.harness.release.continuation.finish()
            pending?.cancel()
            changing?.cancel()
            _ = await pending?.result
            _ = await changing?.result
            await fixture.close(ingress)
        }
        do {
            let old = try #require(try await ingress.prepare(
                route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()))
            fixture.traffic.holdNext = true
            let held = Task { try await old.headers(fixture.route.url) }
            pending = held
            try await waitForIngress { fixture.traffic.gate.started }
            fixture.traffic.replaceFirst = true
            fixture.harness.release.continuation.finish()
            var changed = false
            let replacement = GatewayIngressController.Route(
                url: fixture.server.url("/replacement"), stableID: "native-peer", tls: fixture.route.tls)
            let change = Task {
                defer { changed = true }
                if transition == "revoke" {
                    await ingress.signOut(stableID: fixture.route.stableID)
                    return nil as GatewayIngressAuthorization?
                }
                return try await ingress.prepare(
                    route: replacement, userInitiated: true, admissionCheckpoint: ingress.admissionCheckpoint())
            }
            changing = change
            try await waitForIngress { changed }
            let admitted = try await change.value
            #expect(!old.isCurrent())
            #expect(fixture.harness.retirements > 0)
            // Native cancellation settles without this server release. Injected raw-task
            // tests separately prove strict retirement custody; peer closure is not that fact.
            fixture.traffic.gate.release()
            switch await held.result {
            case .success: Issue.record("Retired discovery returned authorization headers")
            case let .failure(error):
                #expect(error is CancellationError || (error as? URLError)?.code == .cancelled)
            }
            if transition == "revoke" {
                #expect(admitted == nil)
                #expect(fixture.harness.persisted == nil)
            } else {
                #expect(try #require(admitted).isCurrent())
                let stored = try #require(fixture.harness.persisted?.data(using: .utf8))
                let session = try JSONDecoder().decode(CloudflareAccessSession.self, from: stored)
                #expect(session.subject == fixture.next.subject)
                #expect(session.origin == fixture.application.origin)
                #expect(session.issuer == fixture.application.issuer)
                #expect(session.audience == fixture.application.audience)
            }
            let current = try #require(try await ingress.prepare(
                route: fixture.route, userInitiated: true, admissionCheckpoint: ingress.admissionCheckpoint()))
            let headers = try await current.headers(fixture.route.url)
            let expected = fixture.next.authorizationHeader(for: fixture.route.url, now: fixture.harness.now)
            #expect(headers["Cf-Access-Token"] == expected)
            #expect(expected != fixture.traffic.firstToken)
            #expect(try IngressNativeTraffic
                .header("Cf-Access-Token", in: #require(fixture.traffic.requests.last)) == expected)
            #expect(fixture.harness.browser.presented.count == 1)
        } catch {
            await drain()
            throw error
        }
        await drain()
    }

    @Test(arguments: ["prepare", "headers"], ["sign-out", "profile", "origin", "expiry"]) @MainActor
    func `retirement owns cached discovery until cancellation settles`(
        callsite: String,
        retirement: String) async throws
    {
        let fixture = try IngressTestHarness()
        fixture.persisted = try #require(String(data: JSONEncoder().encode(fixture.nextSession), encoding: .utf8))
        let events = AsyncStream<String>.makeStream()
        let ingress = fixture.controller(retirement: { _ in events.continuation.yield("retired") })
        let authorization = try #require(try await ingress.prepare(
            route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()))
        let beforeSend = IngressTestGate()
        fixture.beforeManagedProbe = { _ in
            try await withTaskCancellationHandler {
                await beforeSend.wait()
                try Task.checkCancellation()
            } onCancel: { events.continuation.yield("canceled") }
        }
        let sentBefore = fixture.requests.filter { $0.value(forHTTPHeaderField: "Cf-Access-Token") != nil }.count
        let pending = Task {
            if callsite == "headers" {
                _ = try await authorization.headers(fixture.route.url)
            } else {
                _ = try await ingress.prepare(
                    route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint())
            }
        }
        defer { beforeSend.release()
            pending.cancel()
            events.continuation.finish()
        }
        await beforeSend.waitUntilStarted()
        var acknowledged = false
        let cleanup = Task {
            switch retirement {
            case "sign-out": await ingress.signOut(stableID: fixture.stableID)
            case "profile": try await ingress.forget(stableID: fixture.stableID)
            case "origin": try await ingress.forget(origin: fixture.application.origin)
            default:
                fixture.now = fixture.nextSession.expiresAt.addingTimeInterval(1)
                ingress.foregrounded()
            }
            if retirement != "expiry" { acknowledged = true }
        }
        defer { cleanup.cancel() }
        var iterator = events.stream.makeAsyncIterator()
        #expect(await iterator.next() == "canceled")
        #expect(!acknowledged)
        #expect(fixture.retirements == 0)
        #expect(fixture.persisted != nil)
        #expect(!beforeSend.settled)
        beforeSend.release()
        try await cleanup.value
        await #expect(throws: CancellationError.self) { try await pending.value }
        fixture.beforeManagedProbe = nil
        // A new admission joins any expiry retirement before it can inspect a grant.
        await #expect(throws: GatewayExternalAuthorizationError.self) {
            try await ingress.prepare(
                route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint())
        }
        #expect(fixture.persisted == nil)
        #expect(fixture.retirements == 1)
        #expect(fixture.requests.filter { $0.value(forHTTPHeaderField: "Cf-Access-Token") != nil }.count == sentBefore)
        #expect(fixture.browser.presented.isEmpty)
        #expect(!authorization.isCurrent())
    }

    @Test @MainActor
    func `ordinary admission rejects a canceled discovery that returns success`() async throws {
        let fixture = try IngressTestHarness()
        fixture.persisted = try #require(String(data: JSONEncoder().encode(fixture.nextSession), encoding: .utf8))
        let ingress = fixture.controller()
        let original = try #require(try await ingress.prepare(
            route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()))
        let beforeSend = IngressTestGate()
        let canceled = AsyncStream<Void>.makeStream()
        var rawResumedCanceled = false
        fixture.beforeManagedProbe = { _ in
            await withTaskCancellationHandler {
                // Deliberately return normally after cancellation, like uncooperative raw work.
                await beforeSend.wait()
                rawResumedCanceled = Task.isCancelled
            } onCancel: { canceled.continuation.finish() }
        }
        let sentBefore = fixture.requests.filter { $0.value(forHTTPHeaderField: "Cf-Access-Token") != nil }.count
        var returnedManaged = false
        let pending = Task {
            let result = try await ingress.prepare(
                route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint())
            returnedManaged = result != nil
            return result
        }
        defer {
            beforeSend.release()
            pending.cancel()
        }
        await beforeSend.waitUntilStarted()
        fixture.beforeManagedProbe = nil
        fixture.preauthenticated = true
        var ordinaryFinished = false
        let ordinary = Task {
            defer { ordinaryFinished = true }
            return try await ingress.prepare(
                route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint())
        }
        defer { ordinary.cancel() }
        for await _ in canceled.stream {}
        #expect(!ordinaryFinished)
        #expect(!beforeSend.settled)
        #expect(!original.isCurrent())
        beforeSend.release()
        await #expect(throws: CancellationError.self) { try await pending.value }
        do {
            #expect(try await ordinary.value == nil)
        } catch {
            Issue.record("Ordinary admission must survive the canceled probe: \(error)")
        }
        #expect(rawResumedCanceled)
        #expect(!returnedManaged)
        #expect(!original.isCurrent())
        #expect(fixture.requests.filter { $0.value(forHTTPHeaderField: "Cf-Access-Token") != nil }
            .count == sentBefore + 1)
        #expect(fixture.persisted != nil)
        #expect(fixture.retirements == 0)
        #expect(fixture.browser.presented.isEmpty)
    }

    @Test(arguments: ["forget", "replace", "ordinary"]) @MainActor
    func `profile discovery retirement preserves sibling and replacement grants`(transition: String) async throws {
        let fixture = try IngressTestHarness()
        var sibling = try #require(fixture.profileRows.first)
        sibling.stableID = "discovery-sibling"
        fixture.profileRows.append(sibling)
        fixture.persisted = try #require(String(data: JSONEncoder().encode(fixture.nextSession), encoding: .utf8))
        let ingress = fixture.controller()
        let original = try #require(try await ingress.prepare(
            route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()))
        let siblingRoute = GatewayIngressController.Route(url: fixture.route.url, stableID: sibling.stableID, tls: nil)
        let siblingAuthorization = try #require(try await ingress.prepare(
            route: siblingRoute, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()))
        let beforeSend = IngressTestGate()
        let canceled = AsyncStream<Void>.makeStream()
        fixture.beforeManagedProbe = { _ in
            try await withTaskCancellationHandler {
                await beforeSend.wait()
                try Task.checkCancellation()
            } onCancel: { canceled.continuation.finish() }
        }
        let pending = Task { try await ingress.prepare(
            route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()) }
        defer { beforeSend.release()
            pending.cancel()
        }
        await beforeSend.waitUntilStarted()
        fixture.beforeManagedProbe = nil
        let nextRoute = GatewayIngressController.Route(
            url: fixture.route.url.appendingPathComponent("replacement"), stableID: fixture.stableID, tls: nil)
        var finished = false
        let cleanup = Task<GatewayIngressAuthorization?, Error> {
            defer { finished = true }
            switch transition {
            case "forget":
                try await ingress.forget(stableID: fixture.stableID)
                return nil
            case "ordinary":
                fixture.preauthenticatedStableIDs.insert(fixture.stableID)
                return try await ingress.prepare(
                    route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint())
            default:
                return try await ingress.prepare(
                    route: nextRoute, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint())
            }
        }
        defer { cleanup.cancel() }
        for await _ in canceled.stream {}
        #expect(!finished)
        #expect(!original.isCurrent())
        #expect(siblingAuthorization.isCurrent())
        #expect(fixture.retirements == 0)
        #expect(fixture.persisted != nil)
        var replacement: Task<GatewayIngressAuthorization?, Error>?
        if transition == "forget" {
            let started = AsyncStream<Void>.makeStream()
            replacement = Task {
                started.continuation.finish()
                return try await ingress.prepare(
                    route: nextRoute, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint())
            }
            for await _ in started.stream {}
        }
        defer { replacement?.cancel() }
        beforeSend.release()
        let result = try await cleanup.value
        await #expect(throws: CancellationError.self) { try await pending.value }
        if let replacement {
            let current = try #require(try await replacement.value)
            #expect(current.isCurrent())
            #expect(fixture.profileRows.first?.accessOrigin == fixture.application.origin)
        } else if transition == "replace" {
            #expect(result?.isCurrent() == true)
        } else {
            #expect(result == nil)
        }
        #expect(siblingAuthorization.isCurrent())
        #expect(fixture.persisted != nil)
        #expect(fixture.retirements == 0)
        #expect(fixture.browser.presented.isEmpty)
    }

    @Test(arguments: ["probe", "drain", "caller"]) @MainActor
    func `ordinary discovery completion respects current admission and caller`(stage: String) async throws {
        let fixture = try IngressTestHarness()
        fixture.persisted = try #require(String(data: JSONEncoder().encode(fixture.nextSession), encoding: .utf8))
        let ingress = fixture.controller()
        let beforeSend = IngressTestGate()
        let canceled = AsyncStream<Void>.makeStream()
        let ordinaryStarted = AsyncStream<Void>.makeStream()
        let ordinaryGate = AsyncStream<Void>.makeStream()
        var old: Task<GatewayIngressAuthorization?, Error>?
        var pendingOrdinary: Task<GatewayIngressAuthorization?, Error>?
        var departure: Task<Void, Error>?
        @MainActor func cleanUp() async {
            fixture.nextProfilesRead = nil
            beforeSend.release()
            ordinaryGate.continuation.finish()
            old?.cancel()
            pendingOrdinary?.cancel()
            departure?.cancel()
            _ = await old?.result
            _ = await pendingOrdinary?.result
            _ = await departure?.result
        }
        do {
            if stage != "probe" {
                _ = try #require(try await ingress.prepare(
                    route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()))
                fixture.beforeManagedProbe = { _ in
                    try await withTaskCancellationHandler {
                        await beforeSend.wait()
                        try Task.checkCancellation()
                    } onCancel: { canceled.continuation.finish() }
                }
                old = Task { try await ingress.prepare(
                    route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()) }
                await beforeSend.waitUntilStarted()
                fixture.beforeManagedProbe = nil
                fixture.preauthenticated = true
            } else {
                fixture.probeGate = ordinaryGate.stream
                fixture.probeDidStart = { ordinaryStarted.continuation.finish() }
            }
            var returnedOrdinary = false
            let ordinary = Task {
                let result = try await ingress.prepare(
                    route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint())
                returnedOrdinary = true
                return result
            }
            pendingOrdinary = ordinary
            if stage == "probe" {
                for await _ in ordinaryStarted.stream {}
                fixture.probeGate = nil
                fixture.probeDidStart = nil
            } else {
                for await _ in canceled.stream {}
            }
            fixture.preauthenticated = false
            var current: GatewayIngressAuthorization?
            if stage == "drain" {
                var sibling = try #require(fixture.profileRows.first)
                sibling.stableID = "ordinary-drain-sibling"
                sibling.accessOrigin = fixture.application.origin
                fixture.profileRows.append(sibling)
                let removed = AsyncStream<Void>.makeStream()
                // Forget removes the ordinary registration before its first profile read.
                // Arm only after cancellation proves ordinary admission owns the old request drain.
                fixture.nextProfilesRead = { removed.continuation.finish() }
                departure = Task { try await ingress.forget(stableID: fixture.stableID) }
                for await _ in removed.stream {}
                #expect(!ordinary.isCancelled)
            } else if stage == "caller" {
                ordinary.cancel()
            } else {
                current = try #require(try await ingress.prepare(
                    route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()))
                #expect(current?.isCurrent() == true)
            }
            if stage == "probe" {
                fixture.preauthenticated = true
                ordinaryGate.continuation.yield()
            } else {
                #expect(!beforeSend.settled)
                beforeSend.release()
            }
            await #expect(throws: CancellationError.self) { try await ordinary.value }
            if let old { await #expect(throws: CancellationError.self) { try await old.value } }
            if let departure {
                try await departure.value
                #expect(!ordinary.isCancelled)
                current = try #require(try await ingress.prepare(
                    route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()))
            }
            #expect(!returnedOrdinary)
            if stage != "caller" { #expect(current?.isCurrent() == true) }
            #expect(fixture.persisted != nil)
            #expect(fixture.retirements == 0)
            #expect(fixture.browser.presented.isEmpty)
        } catch {
            await cleanUp()
            throw error
        }
        await cleanUp()
    }

    @Test(arguments: ["timeout", "caller"]) @MainActor
    func `discovery deadline returns while retirement retains cancellation custody`(cause: String) async throws {
        let fixture = try IngressTestHarness()
        fixture.persisted = try #require(String(data: JSONEncoder().encode(fixture.nextSession), encoding: .utf8))
        let deadline = IngressTestDeadline()
        let ingress = fixture.controller(requestDeadline: { seconds, operation in
            try await deadline.run(seconds: seconds, operation: operation)
        })
        let authorization = try #require(try await ingress.prepare(
            route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()))
        let canceled = AsyncStream<Void>.makeStream()
        fixture.beforeManagedProbe = { _ in
            try await withTaskCancellationHandler {
                await deadline.beforeSend.wait()
                try Task.checkCancellation()
            } onCancel: { canceled.continuation.finish() }
        }
        let sentBefore = fixture.requests.filter { $0.value(forHTTPHeaderField: "Cf-Access-Token") != nil }.count
        deadline.expires = cause == "timeout"
        let pending = Task { try await authorization.headers(fixture.route.url) }
        defer { deadline.beforeSend.release()
            pending.cancel()
        }
        if cause == "caller" {
            await deadline.beforeSend.waitUntilStarted()
            pending.cancel()
        }
        do {
            _ = try await pending.value
            Issue.record("The controlled request deadline must return its failure")
        } catch CloudflareAccessError.connectionFailed {
            #expect(cause == "timeout")
        } catch is CancellationError {
            #expect(cause == "caller")
        } catch {
            Issue.record("Unexpected request deadline failure: \(error)")
        }
        for await _ in canceled.stream {}
        #expect(deadline.limits.last == 15)
        #expect(!deadline.beforeSend.settled)
        #expect(fixture.persisted != nil)
        let changed = AsyncStream<Void>.makeStream()
        withObservationTracking { _ = ingress.attention } onChange: { changed.continuation.finish() }
        var acknowledged = false
        let signingOut = Task {
            await ingress.signOut(stableID: fixture.stableID)
            acknowledged = true
        }
        defer { signingOut.cancel() }
        for await _ in changed.stream {}
        #expect(ingress.attention?.canSignIn == false)
        #expect(!acknowledged)
        #expect(fixture.retirements == 0)
        deadline.beforeSend.release()
        await signingOut.value
        #expect(acknowledged)
        #expect(fixture.retirements == 1)
        #expect(fixture.persisted == nil)
        #expect(fixture.requests.filter { $0.value(forHTTPHeaderField: "Cf-Access-Token") != nil }.count == sentBefore)
        #expect(fixture.browser.presented.isEmpty)
    }

    @Test(arguments: ["prepare", "headers", "response"]) @MainActor
    func `headerless login redirects preserve admission and make rejected grants actionable`(
        rejection: String) async throws
    {
        let fixture = try IngressTestHarness()
        fixture.loginRedirect = true
        fixture.preauthenticated = true
        let ingress = fixture.controller()
        #expect(try await ingress.prepare(
            route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()) == nil)
        #expect(fixture.requests.count == 1)
        #expect(fixture.browser.presented.isEmpty)
        #expect(ingress.attention == nil)

        fixture.preauthenticated = false
        await #expect(throws: GatewayExternalAuthorizationError.self) {
            try await ingress.prepare(
                route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint())
        }
        let action = try #require(ingress.attention)
        #expect(action.stableID == fixture.stableID)
        #expect(action.canSignIn)
        #expect(fixture.browser.presented.isEmpty)
        fixture.release.continuation.finish()
        try await ingress.signIn(for: action, admissionCheckpoint: ingress.admissionCheckpoint())
        let current = try #require(try await ingress.prepare(
            route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()))
        #expect(current.isCurrent())
        #expect(fixture.persisted != nil)
        #expect(fixture.browser.presented.count == 1)
        #expect(ingress.attention == nil)
        #expect(try await current.headers(fixture.route.url)["Cf-Access-Token"] ==
            fixture.nextSession.authorizationHeader(for: fixture.route.url, now: fixture.now))
        #expect(fixture.requests.allSatisfy {
            $0.url?.host == fixture.application.origin.url.host || $0.url?.host == fixture.application.issuer.host
        })
        for request in fixture.requests
            where request.httpMethod == "HEAD" || request.url?.host == fixture.application.issuer.host
        {
            #expect(request.value(forHTTPHeaderField: "Cf-Access-Token") == nil)
            #expect(request.value(forHTTPHeaderField: "Cookie") == nil)
        }

        fixture.revoked = true
        await #expect(throws: GatewayExternalAuthorizationError.self) {
            switch rejection {
            case "prepare":
                _ = try await ingress.prepare(
                    route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint())
            case "headers":
                _ = try await current.headers(fixture.route.url)
            default:
                let response = try #require(HTTPURLResponse(
                    url: fixture.route.url, statusCode: 302, httpVersion: nil,
                    headerFields: ["Location": "https://login.example.test/cdn-cgi/access/login?opaque=ignored"]))
                try await current.checkResponse(response)
            }
        }
        #expect(!current.isCurrent())
        #expect(ingress.attention?.stableID == fixture.stableID)
        #expect(ingress.attention?.canSignIn == true)
        #expect(fixture.browser.presented.count == 1)
        try await ingress.forget(origin: fixture.application.origin)
        #expect(fixture.persisted == nil)
    }

    @Test @MainActor
    func `real Keychain ingress persistence survives restart and forget preserves Gateway credentials`() async throws {
        let isolation = await GatewayRegistryTestIsolation()
        defer { isolation.restore() }
        let instanceID = "access-keychain-\(UUID().uuidString)"
        let state = try TemporaryOpenClawState(instanceID: instanceID)
        defer { state.restore() }
        let fixture = try IngressTestHarness()
        let persistence = CloudflareAccessSessionStore.Persistence.keychain
        let previous = persistence.load(fixture.application.origin)
        let headers = GatewaySettingsStore.loadGatewayCustomHeaders(gatewayStableID: fixture.stableID)
        defer {
            _ = persistence.delete(fixture.application.origin)
            if let previous {
                _ = persistence.save(fixture.application.origin, previous)
            }
            _ = GatewaySettingsStore.saveGatewayCustomHeaders(headers, gatewayStableID: fixture.stableID)
        }
        #expect(GatewaySettingsStore.saveGatewayCredentials(
            token: "gateway-token",
            bootstrapToken: nil,
            password: "gateway-password",
            gatewayStableID: fixture.stableID,
            suppressStoredDeviceAuth: false,
            instanceId: instanceID))
        #expect(GatewaySettingsStore.saveGatewayCustomHeaders(
            ["X-Existing-Ingress": "preserved"],
            gatewayStableID: fixture.stableID))
        let store = CloudflareAccessSessionStore(
            persistence: persistence,
            authenticate: { _, _ in fixture.nextSession },
            retireTransports: { _ in })
        _ = try await store.signIn(application: fixture.application, openBrowser: { _ in }).value
        let restarted = CloudflareAccessSessionStore(persistence: persistence, retireTransports: { _ in })
        #expect(restarted.snapshot(for: fixture.application.origin)?.session.subject == fixture.nextSession.subject)
        try await restarted.forget(fixture.application.origin).task.value
        #expect(persistence.load(fixture.application.origin) == nil)
        let credentials = GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: fixture.stableID)
        #expect(credentials.token == "gateway-token")
        #expect(credentials.password == "gateway-password")
        #expect(GatewaySettingsStore
            .loadGatewayCustomHeaders(gatewayStableID: fixture.stableID) == ["X-Existing-Ingress": "preserved"])
    }

    @Test(arguments: ["manual", "discovered"]) @MainActor
    func `saved admission can be forgotten after cold relaunch before preparation`(kind: String) async throws {
        let isolation = await GatewayRegistryTestIsolation()
        defer { isolation.restore() }
        let fixture = try IngressTestHarness()
        let persistence = CloudflareAccessSessionStore.Persistence.keychain
        let previous = persistence.load(fixture.application.origin)
        _ = persistence.delete(fixture.application.origin)
        defer {
            _ = persistence.delete(fixture.application.origin)
            if let previous {
                _ = persistence.save(fixture.application.origin, previous)
            }
        }
        let stableID = kind == "manual" ? fixture.stableID : "discovered-access-test"
        let entry = GatewaySettingsStore.GatewayRegistryEntry(
            stableID: stableID,
            kind: kind == "manual" ? .manual : .discovered,
            name: "Gateway",
            host: "gateway.example.test",
            port: 8443,
            useTLS: true,
            lastConnectedAtMs: nil)
        #expect(GatewaySettingsStore.upsertGatewayRegistryEntry(entry))
        let route = GatewayIngressController.Route(url: fixture.route.url, stableID: stableID, tls: nil)
        fixture.release.continuation.finish()
        let producer = fixture.controller(useSavedProfiles: true, persistence: persistence)
        _ = try await producer.prepare(
            route: route,
            userInitiated: true,
            admissionCheckpoint: producer.admissionCheckpoint())
        #expect(persistence.load(fixture.application.origin) != nil)
        #expect(GatewaySettingsStore.loadGatewayRegistry().entries.first?.accessOrigin == fixture.application.origin)
        // Normal profile/Bonjour updates must retain the association, even though
        // discovered rows intentionally do not persist the resolved hostname.
        #expect(GatewaySettingsStore.upsertGatewayRegistryEntry(entry))
        let saved = try #require(GatewaySettingsStore.loadGatewayRegistry().entries.first)
        #expect(saved.accessOrigin == fixture.application.origin)
        if kind == "discovered" {
            #expect(saved.host == nil)
        }
        let relaunched = fixture.controller(useSavedProfiles: true, persistence: persistence)
        try await relaunched.forget(stableID: stableID)
        #expect(persistence.load(fixture.application.origin) == nil)
        #expect(!relaunched.hasSession(stableID: stableID))
    }

    @Test @MainActor
    func `same origin profiles retain their admission target across a suspended probe`() async throws {
        let fixture = try IngressTestHarness()
        var sibling = try #require(fixture.profileRows.first)
        sibling.stableID = "discovered-sibling"
        fixture.profileRows.append(sibling)
        let ingress = fixture.controller()
        let gate = AsyncStream<Void>.makeStream()
        fixture.probeGate = gate.stream
        fixture.probeStableID = fixture.stableID
        let pending = Task { try await ingress.prepare(
            route: fixture.route,
            userInitiated: false,
            admissionCheckpoint: ingress.admissionCheckpoint()) }
        defer { gate.continuation.finish()
            pending.cancel()
        }
        try await waitForIngress { fixture.probeStarted }
        let siblingRoute = GatewayIngressController.Route(
            url: fixture.route.url.appendingPathComponent("other"), stableID: sibling.stableID, tls: nil)
        do { _ = try await ingress.prepare(
            route: siblingRoute,
            userInitiated: false,
            admissionCheckpoint: ingress.admissionCheckpoint()) } catch {}
        #expect(ingress.attention?.stableID == sibling.stableID)
        gate.continuation.finish()
        _ = await pending.result
        let attention = try #require(ingress.attention)
        #expect(attention.stableID == fixture.stableID)
        fixture.probeGate = nil
        fixture.release.continuation.finish()
        try await ingress.signIn(for: attention, admissionCheckpoint: ingress.admissionCheckpoint())
        let first = try await ingress.prepare(
            route: fixture.route,
            userInitiated: false,
            admissionCheckpoint: ingress.admissionCheckpoint())
        let second = try await ingress.prepare(
            route: siblingRoute,
            userInitiated: false,
            admissionCheckpoint: ingress.admissionCheckpoint())
        #expect(first?.isCurrent() == true)
        #expect(second?.isCurrent() == true)
        #expect(ingress.hasSession(stableID: fixture.stableID))
        #expect(ingress.hasSession(stableID: sibling.stableID))
        #expect(fixture.profileRows.allSatisfy { $0.accessOrigin == fixture.application.origin })
        #expect(fixture.browser.presented.count == 1)
        await ingress.signOut(stableID: fixture.stableID)
        #expect(first?.isCurrent() == false)
        #expect(second?.isCurrent() == false)
        #expect(!ingress.hasSession(stableID: fixture.stableID))
        #expect(!ingress.hasSession(stableID: sibling.stableID))
    }

    @Test(arguments: [false, true], [false, true]) @MainActor
    func `different signed applications on one host replace the browser attempt`(
        differentIssuer: Bool, sameProfile: Bool) async throws
    {
        let fixture = try IngressTestHarness()
        var sibling = fixture.profileRows[0]
        sibling.stableID = sameProfile ? fixture.stableID : "other-path"
        if !sameProfile { fixture.profileRows.append(sibling) }
        let application = try CloudflareAccessApplication(
            origin: fixture.application.origin,
            issuer: differentIssuer ? #require(URL(string: "https://other.cloudflareaccess.com")) :
                fixture.application.issuer,
            audience: differentIssuer ? fixture.application.audience : "other-audience")
        let firstRoute = GatewayIngressController.Route(
            url: fixture.route.url.appendingPathComponent("first/socket"), stableID: fixture.stableID, tls: nil)
        let secondRoute = GatewayIngressController.Route(
            url: sameProfile ? firstRoute.url : fixture.route.url.appendingPathComponent("second/socket"),
            stableID: sibling.stableID, tls: nil)
        let firstGate = IngressTestGate()
        let secondGate = IngressTestGate()
        let replacement = try fixture.session(for: application, subject: "replacement")
        var authenticated: [CloudflareAccessApplication] = []
        var firstWasCanceled = false
        let ingress = fixture.controller(authenticate: { requested, browser in
            authenticated.append(requested)
            try await browser(requested.origin.url.appendingPathComponent("cdn-cgi/access/cli"))
            if requested == fixture.application {
                // Deliberately return late despite cancellation: Store and intent ownership
                // must prevent the superseded grant from persisting or settling the new UI.
                await firstGate.wait()
                firstWasCanceled = Task.isCancelled
                return fixture.nextSession
            }
            await secondGate.wait()
            return replacement
        })
        let first = Task { try await ingress.prepare(
            route: firstRoute, userInitiated: true, admissionCheckpoint: ingress.admissionCheckpoint()) }
        defer { firstGate.release()
            first.cancel()
        }
        await firstGate.waitUntilStarted()
        let firstID = try #require(fixture.browser.presented.first)
        let staleCancel = fixture.browser.cancel
        let firstAttentionID = ingress.attention?.id
        fixture.applicationsByStableID[sibling.stableID] = application
        let second = Task { try await ingress.prepare(
            route: secondRoute, userInitiated: true, admissionCheckpoint: ingress.admissionCheckpoint()) }
        defer { secondGate.release()
            second.cancel()
        }
        await secondGate.waitUntilStarted()
        #expect(authenticated == [fixture.application, application])
        #expect(fixture.browser.presented.count == 2)
        #expect(fixture.browser.presented.last != firstID)
        let currentAttention = try #require(ingress.attention)
        #expect(currentAttention.id != firstAttentionID)
        #expect(currentAttention.message == "Sign in to Cloudflare Access to connect this gateway.")
        staleCancel?()
        #expect(ingress.signingIn)
        #expect(ingress.attention?.id == currentAttention.id)
        #expect(currentAttention.stableID == secondRoute.stableID)
        secondGate.release()
        let authorization = try #require(try await second.value)
        let bytes = try #require(fixture.persisted)
        let persisted = try JSONDecoder().decode(CloudflareAccessSession.self, from: Data(bytes.utf8))
        #expect(persisted.issuer == application.issuer)
        #expect(persisted.audience == application.audience)
        #expect(persisted.subject == "replacement")
        firstGate.release()
        await #expect(throws: CancellationError.self) { try await first.value }
        #expect(firstWasCanceled)
        #expect(fixture.persisted == bytes)
        #expect(authorization.isCurrent())
        #expect(!ingress.signingIn)
        #expect(ingress.attention == nil)
        #expect(fixture.requests.filter { $0.httpMethod == "HEAD" }.map(\.url) == [firstRoute.url, secondRoute.url])
        try await ingress.forget(origin: application.origin)
    }

    @Test @MainActor
    func `a different path application can accept a cached grant through its actual policy probe`() async throws {
        let fixture = try IngressTestHarness()
        fixture.persisted = try String(data: JSONEncoder().encode(fixture.nextSession), encoding: .utf8)
        fixture.applicationsByStableID[fixture.stableID] = CloudflareAccessApplication(
            origin: fixture.application.origin, issuer: fixture.application.issuer, audience: "linked-audience")
        let route = GatewayIngressController.Route(
            url: fixture.route.url.appendingPathComponent("linked/socket"), stableID: fixture.stableID, tls: nil)
        let ingress = fixture.controller()
        let authorization = try #require(try await ingress.prepare(
            route: route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()))
        #expect(authorization.isCurrent())
        #expect(fixture.requests.first?.url == route.url)
        #expect(fixture.requests.first?.value(forHTTPHeaderField: "Cf-Access-Token") == nil)
        #expect(fixture.requests.filter { $0.httpMethod == "HEAD" }.map(\.url) == [route.url])
        #expect(fixture.requests.last?.url == route.url)
        #expect(fixture.requests.last?.value(forHTTPHeaderField: "Cf-Access-Token") != nil)
        #expect(fixture.browser.presented.isEmpty)
        try await ingress.forget(origin: fixture.application.origin)
    }

    @Test(arguments: [false, true], [false, true]) @MainActor
    func `pending sign out rejects actions and publishes its actual terminal result`(
        deletionFails: Bool, cancelCaller: Bool) async throws
    {
        let fixture = try IngressTestHarness()
        let storage = IngressOriginStorage()
        try storage.save(fixture.nextSession)
        let retirement = IngressTestGate()
        let ingress = fixture.controller(persistence: storage.persistence, retirement: { _ in
            if fixture.retirements == 1 { await retirement.wait() }
        })
        _ = try await ingress.prepare(
            route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint())
        storage.deletionSucceeds = !deletionFails
        let pending = Task { await ingress.signOut(stableID: fixture.stableID) }
        defer { retirement.release()
            pending.cancel()
        }
        await retirement.waitUntilStarted()
        let attention = try #require(ingress.attention)
        #expect(attention.message == "Signing out of Cloudflare Access…")
        #expect(!attention.canSignIn)
        #expect(!ingress.hasSession(stableID: fixture.stableID))
        // The live capability is authoritative, even if a caller carries an actionable copy.
        let actionableCopy = GatewayIngressController.Attention(
            id: attention.id, origin: attention.origin, stableID: attention.stableID,
            message: attention.message, canSignIn: true)
        let requests = fixture.requests.count
        await #expect(throws: CancellationError.self) {
            try await ingress.signIn(for: actionableCopy, admissionCheckpoint: ingress.admissionCheckpoint())
        }
        #expect(fixture.requests.count == requests)
        #expect(fixture.browser.presented.isEmpty)
        if cancelCaller { pending.cancel() }
        retirement.release()
        await pending.value
        let terminal = try #require(ingress.attention)
        #expect(terminal.id == attention.id)
        #expect(terminal.canSignIn)
        #expect((storage.values[fixture.application.origin] != nil) == deletionFails)
        #expect(storage.deleted == [fixture.application.origin])
        if deletionFails {
            #expect(terminal.message == CloudflareAccessError.storageFailed.localizedDescription)
        } else {
            #expect(terminal.message.contains("is signed out"))
        }
        storage.deletionSucceeds = true
        fixture.release.continuation.finish()
        // A captured pending copy may act only after the live operation becomes actionable.
        try await ingress.signIn(for: attention, admissionCheckpoint: ingress.admissionCheckpoint())
        #expect(fixture.browser.presented.count == 1)
        #expect(ingress.hasSession(stableID: fixture.stableID))
        try await ingress.forget(origin: fixture.application.origin)
    }

    @Test(arguments: ["success", "failure", "cleared", "canceled"]) @MainActor
    func `retired sign out cannot replace or revive a newer gateway action`(outcome: String) async throws {
        let fixture = try IngressTestHarness()
        let storage = IngressOriginStorage()
        try storage.save(fixture.nextSession)
        let application = try CloudflareAccessApplication(
            origin: CloudflareAccessOrigin(#require(URL(string: "https://other.example.test"))),
            issuer: fixture.application.issuer, audience: "other-audience")
        var sibling = fixture.profileRows[0]
        sibling.stableID = "other-gateway"
        sibling.host = application.origin.url.host
        fixture.profileRows.append(sibling)
        fixture.applicationsByStableID[sibling.stableID] = application
        let route = GatewayIngressController.Route(url: application.origin.url, stableID: sibling.stableID, tls: nil)
        let retirement = IngressTestGate()
        let ingress = fixture.controller(persistence: storage.persistence, retirement: { origin in
            if origin == fixture.application.origin { await retirement.wait() }
        })
        _ = try await ingress.prepare(
            route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint())
        storage.deletionSucceeds = outcome != "failure"
        let pending = Task { await ingress.signOut(stableID: fixture.stableID) }
        defer { retirement.release()
            pending.cancel()
        }
        await retirement.waitUntilStarted()
        await #expect(throws: GatewayExternalAuthorizationError.self) {
            try await ingress.prepare(
                route: route,
                userInitiated: false,
                admissionCheckpoint: ingress.admissionCheckpoint())
        }
        let attention = try #require(ingress.attention)
        #expect(attention.stableID == sibling.stableID)
        #expect(attention.canSignIn)
        if outcome == "cleared" {
            fixture.preauthenticatedStableIDs.insert(sibling.stableID)
            try await ingress.signIn(for: attention, admissionCheckpoint: ingress.admissionCheckpoint())
            #expect(ingress.attention == nil)
        }
        if outcome == "canceled" { pending.cancel() }
        retirement.release()
        await pending.value
        #expect((storage.values[fixture.application.origin] != nil) == (outcome == "failure"))
        #expect(storage.deleted == [fixture.application.origin])
        if outcome == "cleared" {
            #expect(ingress.attention == nil)
        } else {
            let current = try #require(ingress.attention)
            #expect(current.id == attention.id)
            #expect(current.origin == attention.origin)
            #expect(current.stableID == attention.stableID)
            #expect(current.message == attention.message)
            #expect(current.canSignIn == attention.canSignIn)
            storage.deletionSucceeds = true
            fixture.nextSession = try fixture.session(for: application, subject: "other-subject")
            fixture.release.continuation.finish()
            try await ingress.signIn(for: attention, admissionCheckpoint: ingress.admissionCheckpoint())
            #expect(ingress.hasSession(stableID: sibling.stableID))
            try await ingress.forget(origin: application.origin)
        }
    }

    @Test @MainActor
    func `overlapping sign outs keep the newer pending action through the first completion`() async throws {
        let fixture = try IngressTestHarness()
        let firstGate = IngressTestGate()
        let secondGate = IngressTestGate()
        let ingress = fixture.controller(retirement: { _ in
            if fixture.retirements == 1 { await firstGate.wait() }
            if fixture.retirements == 2 { await secondGate.wait() }
        })
        fixture.profileRows[0].accessOrigin = fixture.application.origin
        let first = Task { await ingress.signOut(stableID: fixture.stableID) }
        defer { firstGate.release()
            first.cancel()
        }
        await firstGate.waitUntilStarted()
        let firstAttention = try #require(ingress.attention)
        let changed = AsyncStream<Void>.makeStream()
        withObservationTracking { _ = ingress.attention } onChange: { changed.continuation.finish() }
        let second = Task { await ingress.signOut(stableID: fixture.stableID) }
        defer { secondGate.release()
            second.cancel()
        }
        for await _ in changed.stream {}
        let secondAttention = try #require(ingress.attention)
        #expect(secondAttention.id != firstAttention.id)
        #expect(!secondAttention.canSignIn)
        firstGate.release()
        await secondGate.waitUntilStarted()
        await first.value
        #expect(ingress.attention?.id == secondAttention.id)
        #expect(ingress.attention?.canSignIn == false)
        secondGate.release()
        await second.value
        #expect(ingress.attention?.id == secondAttention.id)
        #expect(ingress.attention?.canSignIn == true)
        #expect(fixture.retirements == 2)
    }

    @Test(arguments: ["origin", "profile"]) @MainActor
    func `forget preserves a later matching sign out action`(scope: String) async throws {
        let fixture = try IngressTestHarness()
        fixture.profileRows[0].accessOrigin = fixture.application.origin
        let firstGate = IngressTestGate()
        let secondGate = IngressTestGate()
        let ingress = fixture.controller(retirement: { _ in
            if fixture.retirements == 1 { await firstGate.wait() }
            if fixture.retirements == 2 { await secondGate.wait() }
        })
        let forgetting = Task {
            if scope == "origin" {
                try await ingress.forget(origin: fixture.application.origin)
            } else {
                try await ingress.forget(stableID: fixture.stableID)
            }
        }
        defer { firstGate.release()
            forgetting.cancel()
        }
        await firstGate.waitUntilStarted()
        let changed = AsyncStream<Void>.makeStream()
        withObservationTracking { _ = ingress.attention } onChange: { changed.continuation.finish() }
        let signingOut = Task { await ingress.signOut(stableID: fixture.stableID) }
        defer { secondGate.release()
            signingOut.cancel()
        }
        for await _ in changed.stream {}
        let attention = try #require(ingress.attention)
        #expect(!attention.canSignIn)
        firstGate.release()
        await secondGate.waitUntilStarted()
        if scope == "origin" {
            try await forgetting.value
            #expect(ingress.attention?.id == attention.id)
            #expect(ingress.attention?.canSignIn == false)
        }
        secondGate.release()
        await signingOut.value
        try await forgetting.value
        #expect(ingress.attention?.id == attention.id)
        #expect(ingress.attention?.canSignIn == true)
        #expect(fixture.retirements == 2)
    }

    @Test(arguments: ["origin", "profile"]) @MainActor
    func `forget clears its unchanged captured attention`(scope: String) async throws {
        let fixture = try IngressTestHarness()
        let ingress = fixture.controller()
        await #expect(throws: GatewayExternalAuthorizationError.self) {
            try await ingress.prepare(
                route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint())
        }
        #expect(ingress.attention != nil)
        if scope == "origin" { try await ingress.forget(origin: fixture.application.origin) }
        else { try await ingress.forget(stableID: fixture.stableID) }
        #expect(ingress.attention == nil)
    }

    @Test(arguments: [false, true]) @MainActor
    func `committed grant remains discoverable when browser dismissal is canceled or superseded`(
        replace: Bool) async throws
    {
        let isolation = await GatewayRegistryTestIsolation()
        defer { isolation.restore() }
        let fixture = try IngressTestHarness()
        let persistence = CloudflareAccessSessionStore.Persistence.keychain
        let previous = persistence.load(fixture.application.origin)
        _ = persistence.delete(fixture.application.origin)
        defer {
            _ = persistence.delete(fixture.application.origin)
            if let previous {
                _ = persistence.save(fixture.application.origin, previous)
            }
        }
        let stableID = "discovered-dismissal-test"
        #expect(GatewaySettingsStore.upsertGatewayRegistryEntry(.init(
            stableID: stableID,
            kind: .discovered,
            name: "Gateway",
            host: nil,
            port: nil,
            useTLS: true,
            lastConnectedAtMs: nil)))
        let route = GatewayIngressController.Route(url: fixture.route.url, stableID: stableID, tls: nil)
        let gate = AsyncStream<Void>.makeStream()
        fixture.browser.dismissalGate = gate.stream
        fixture.release.continuation.finish()
        let producer = fixture.controller(useSavedProfiles: true, persistence: persistence)
        let pending = Task { try await producer.prepare(
            route: route,
            userInitiated: true,
            admissionCheckpoint: producer.admissionCheckpoint()) }
        defer { gate.continuation.finish()
            pending.cancel()
        }
        try await waitForIngress { fixture.browser.dismissed.count == 1 }
        #expect(persistence.load(fixture.application.origin) != nil)
        #expect(GatewaySettingsStore.loadGatewayRegistry().entries.first?.accessOrigin == fixture.application.origin)
        if replace {
            _ = try await producer.prepare(
                route: .init(url: route.url.appendingPathComponent("replacement"), stableID: stableID, tls: nil),
                userInitiated: false, admissionCheckpoint: producer.admissionCheckpoint())
        } else {
            pending.cancel()
        }
        gate.continuation.finish()
        await #expect(throws: CancellationError.self) { try await pending.value }
        let relaunched = fixture.controller(useSavedProfiles: true, persistence: persistence)
        try await relaunched.forget(stableID: stableID)
        #expect(persistence.load(fixture.application.origin) == nil)
        #expect(!relaunched.hasSession(stableID: stableID))
    }

    @Test @MainActor
    func `forgotten admission cannot publish a late target or origin association`() async throws {
        let fixture = try IngressTestHarness()
        let ingress = fixture.controller()
        let gate = AsyncStream<Void>.makeStream()
        fixture.probeGate = gate.stream
        let pending = Task { try await ingress.prepare(
            route: fixture.route,
            userInitiated: true,
            admissionCheckpoint: ingress.admissionCheckpoint()) }
        defer { gate.continuation.finish()
            pending.cancel()
        }
        try await waitForIngress { fixture.probeStarted }
        try await ingress.forget(stableID: fixture.stableID)
        fixture.profileRows.removeAll()
        gate.continuation.finish()
        if case .success = await pending.result {
            Issue.record("forgotten route was admitted")
        }
        #expect(ingress.attention == nil)
        #expect(fixture.persisted == nil)
        #expect(fixture.browser.presented.isEmpty)
    }

    @Test(arguments: [false, true]) @MainActor
    func `a changed profile releases only an unowned previous origin`(shared: Bool) async throws {
        let fixture = try IngressTestHarness()
        fixture.profileRows[0].accessOrigin = fixture.application.origin
        if shared {
            var sibling = fixture.profileRows[0]
            sibling.stableID = "discovered-sibling"
            fixture.profileRows.append(sibling)
        }
        fixture.persisted = try String(data: JSONEncoder().encode(fixture.nextSession), encoding: .utf8)
        fixture.preauthenticated = true
        let ingress = fixture.controller()
        let newURL = try #require(URL(string: "https://different.example.test"))
        _ = try await ingress.prepare(
            route: .init(url: newURL, stableID: fixture.stableID, tls: nil),
            userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint())
        #expect(fixture.profileRows[0].accessOrigin == nil)
        #expect((fixture.persisted != nil) == shared)
        #expect(fixture.retirements == (shared ? 0 : 1))
        #expect(fixture.browser.presented.isEmpty)
    }

    @Test(arguments: [false, true]) @MainActor
    func `saved origin owns session lookup and sign out while route replacement waits for media`(
        replacementHasGrant: Bool) async throws
    {
        let fixture = try IngressTestHarness()
        let storage = IngressOriginStorage()
        try storage.save(fixture.nextSession)
        fixture.profileRows[0].accessOrigin = fixture.application.origin
        let replacementOrigin = try CloudflareAccessOrigin(#require(URL(string: "https://replacement.example.test")))
        let replacementApplication = CloudflareAccessApplication(
            origin: replacementOrigin, issuer: fixture.application.issuer, audience: fixture.application.audience)
        if replacementHasGrant {
            try storage.save(CloudflareAccessSession(
                application: replacementApplication,
                subject: fixture.nextSession.subject,
                token: #require(fixture.nextSession.authorizationHeader(for: fixture.route.url)),
                expiresAt: fixture.nextSession.expiresAt))
        }
        let replacementBytes = storage.values[replacementOrigin]
        let ingress = fixture.controller(persistence: storage.persistence)
        let prepared = try await ingress.prepare(
            route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint())
        let authorization = try #require(prepared)
        let media = IngressTestGate()
        let response = try #require(HTTPURLResponse(
            url: fixture.route.url,
            statusCode: 200,
            httpVersion: nil,
            headerFields: nil))
        let download = Task {
            try await authorization.load(URLRequest(url: fixture.route.url)) { _ in
                await media.wait()
                return (Data([1]), response)
            }
        }
        defer { media.release()
            download.cancel()
        }
        try await waitForIngress { media.started }
        fixture.preauthenticated = true
        let replacement = Task {
            try await ingress.prepare(
                route: .init(url: replacementOrigin.url, stableID: fixture.stableID, tls: nil),
                userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint())
        }
        defer { replacement.cancel() }
        try await waitForIngress { !authorization.isCurrent() }
        // Registration already points to P; its media drain still precedes revocation of O.
        #expect(ingress.hasSession(stableID: fixture.stableID))
        let checkpoint = ingress.admissionCheckpoint()
        let signedOut = Task { await ingress.signOut(stableID: fixture.stableID) }
        defer { signedOut.cancel() }
        try await waitForIngress { ingress.admissionCheckpoint() > checkpoint }
        #expect(storage.values[fixture.application.origin] != nil)
        #expect(storage.values[replacementOrigin] == replacementBytes)
        #expect(storage.deleted.isEmpty)
        #expect(!ingress.hasSession(stableID: fixture.stableID))
        media.release()
        if case .success = await download.result { Issue.record("Retired media returned a result") }
        await signedOut.value
        #expect(try await replacement.value == nil)
        #expect(storage.values[fixture.application.origin] == nil)
        #expect(storage.values[replacementOrigin] == replacementBytes)
        #expect(storage.deleted == [fixture.application.origin, fixture.application.origin])
    }

    @Test(arguments: [false, true]) @MainActor
    func `failed old origin deletion remains owned for retry and cold sign out`(cold: Bool) async throws {
        let fixture = try IngressTestHarness()
        let storage = IngressOriginStorage()
        try storage.save(fixture.nextSession)
        fixture.profileRows[0].accessOrigin = fixture.application.origin
        let replacementOrigin = try CloudflareAccessOrigin(#require(URL(string: "https://replacement.example.test")))
        let replacementApplication = CloudflareAccessApplication(
            origin: replacementOrigin, issuer: fixture.application.issuer, audience: fixture.application.audience)
        try storage.save(CloudflareAccessSession(
            application: replacementApplication,
            subject: fixture.nextSession.subject,
            token: #require(fixture.nextSession.authorizationHeader(for: fixture.route.url)),
            expiresAt: fixture.nextSession.expiresAt))
        let before = storage.values
        storage.deletionSucceeds = false
        fixture.preauthenticated = true
        let ingress = fixture.controller(persistence: storage.persistence)
        await #expect(throws: CloudflareAccessError.self) {
            try await ingress.prepare(
                route: .init(url: replacementOrigin.url, stableID: fixture.stableID, tls: nil),
                userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint())
        }
        #expect(storage.values == before)
        #expect(fixture.profileRows[0].accessOrigin == fixture.application.origin)
        #expect(fixture.requests.isEmpty)
        #expect(!ingress.hasSession(stableID: fixture.stableID))
        await ingress.signOut(stableID: fixture.stableID)
        let attention = try #require(ingress.attention)
        #expect(attention.origin == fixture.application.origin)
        #expect(storage.values == before)
        #expect(storage.deleted == [fixture.application.origin, fixture.application.origin])
        storage.deletionSucceeds = true
        if cold {
            let restarted = fixture.controller(persistence: storage.persistence)
            #expect(restarted.hasSession(stableID: fixture.stableID))
            await restarted.signOut(stableID: fixture.stableID)
            #expect(restarted.attention?.origin == fixture.application.origin)
            #expect(!restarted.hasSession(stableID: fixture.stableID))
        } else {
            try await ingress.signIn(for: attention, admissionCheckpoint: ingress.admissionCheckpoint())
            #expect(fixture.profileRows[0].accessOrigin == nil)
            #expect(ingress.attention == nil)
        }
        #expect(storage.values[fixture.application.origin] == nil)
        #expect(storage.values[replacementOrigin] == before[replacementOrigin])
        #expect(storage.deleted.allSatisfy { $0 == fixture.application.origin })
        #expect(fixture.browser.presented.isEmpty)
    }

    @Test @MainActor
    func `WARP or existing ingress credentials keep ordinary admission without a browser`() async throws {
        let fixture = try IngressTestHarness()
        fixture.preauthenticated = true
        let ingress = fixture.controller()
        let authorization = try await ingress.prepare(
            route: fixture.route,
            userInitiated: true,
            admissionCheckpoint: ingress.admissionCheckpoint())
        #expect(authorization == nil)
        #expect(fixture.browser.presented.isEmpty)
        #expect(fixture.requests.count == 1)
        #expect(fixture.requests[0].value(forHTTPHeaderField: "X-Existing-Ingress") == "preserved")
    }

    @Test @MainActor
    func `cached origin grant never enrolls an independently admitted sibling`() async throws {
        let fixture = try IngressTestHarness()
        fixture.persisted = try String(data: JSONEncoder().encode(fixture.nextSession), encoding: .utf8)
        fixture.preauthenticated = true
        let ingress = fixture.controller()
        #expect(try await ingress.prepare(
            route: fixture.route,
            userInitiated: false,
            admissionCheckpoint: ingress.admissionCheckpoint()) == nil)
        #expect(fixture.requests.count == 1)
        #expect(fixture.requests.allSatisfy { $0.value(forHTTPHeaderField: "Cf-Access-Token") == nil })
        #expect(fixture.requests[0].value(forHTTPHeaderField: "X-Existing-Ingress") == "preserved")
        #expect(fixture.browser.presented.isEmpty)
    }

    @Test @MainActor
    func `an explicit challenge reuses a cached grant without presenting a browser`() async throws {
        let fixture = try IngressTestHarness()
        fixture.persisted = try String(data: JSONEncoder().encode(fixture.nextSession), encoding: .utf8)
        let ingress = fixture.controller()
        let admission = try await ingress.prepare(
            route: fixture.route,
            userInitiated: false,
            admissionCheckpoint: ingress.admissionCheckpoint())
        #expect(admission?.isCurrent() == true)
        #expect(fixture.requests.first?.value(forHTTPHeaderField: "Cf-Access-Token") == nil)
        #expect(fixture.requests.filter { $0.value(forHTTPHeaderField: "Cf-Access-Token") != nil }.count == 1)
        #expect(fixture.browser.presented.isEmpty)
    }

    @Test @MainActor
    func `sign out retires pending Access admission while ordinary sibling discovery completes`() async throws {
        let fixture = try IngressTestHarness()
        fixture.persisted = try String(data: JSONEncoder().encode(fixture.nextSession), encoding: .utf8)
        var sibling = try #require(fixture.profileRows.first)
        sibling.stableID = "ordinary-sibling"
        fixture.profileRows.append(sibling)
        fixture.preauthenticatedStableIDs.insert(sibling.stableID)
        let siblingRoute = GatewayIngressController.Route(
            url: fixture.route.url, stableID: sibling.stableID, tls: nil)
        let gate = AsyncStream<Void>.makeStream()
        fixture.probeGate = gate.stream
        let ingress = fixture.controller()
        let managed = Task { try await ingress.prepare(
            route: fixture.route,
            userInitiated: true,
            admissionCheckpoint: ingress.admissionCheckpoint()) }
        let ordinary = Task { try await ingress.prepare(
            route: siblingRoute,
            userInitiated: true,
            admissionCheckpoint: ingress.admissionCheckpoint()) }
        defer {
            gate.continuation.finish()
            managed.cancel()
            ordinary.cancel()
        }
        try await waitForIngress { fixture.pendingProbes == 2 }
        await ingress.signOut(stableID: fixture.stableID)
        gate.continuation.finish()
        await #expect(throws: CancellationError.self) { try await managed.value }
        #expect(try await ordinary.value == nil)
        #expect(fixture.browser.presented.isEmpty)
        #expect(fixture.persisted == nil)
        #expect(!ingress.hasSession(stableID: fixture.stableID))
    }

    @Test @MainActor
    func `silent challenge is actionable and never opens a browser`() async throws {
        let fixture = try IngressTestHarness()
        let ingress = fixture.controller()
        await #expect(throws: GatewayExternalAuthorizationError.self) {
            try await ingress.prepare(
                route: fixture.route,
                userInitiated: false,
                admissionCheckpoint: ingress.admissionCheckpoint())
        }
        #expect(ingress.attention?.stableID == fixture.stableID)
        #expect(fixture.browser.presented.isEmpty)
    }

    @Test @MainActor
    func `verified browser completion admits revision-bound headers for both roles`() async throws {
        let fixture = try IngressTestHarness()
        let ingress = fixture.controller()
        let admission = Task { try await ingress.prepare(
            route: fixture.route,
            userInitiated: true,
            admissionCheckpoint: ingress.admissionCheckpoint()) }
        try await waitForIngress { fixture.browser.presented.count == 1 }
        #expect(fixture.persisted == nil)
        fixture.release.continuation.yield()
        let admitted = try await admission.value
        let authorization = try #require(admitted)
        #expect(fixture.retirements == 1)
        #expect(fixture.browser.dismissed == fixture.browser.presented)
        async let node = authorization.headers(fixture.route.url)
        async let operatorHeaders = authorization.headers(fixture.route.url)
        let (first, second) = try await (node, operatorHeaders)
        #expect(first == second)
        #expect(first["Cf-Access-Token"] != nil)
        #expect(first["X-Existing-Ingress"] == "preserved")
        #expect(first["Authorization"] == nil)
        #expect(fixture.browser.presented.count == 1)
        for address in [
            "http://gateway.example.test:8443",
            "https://gateway.example.test",
            "https://other.example.test:8443",
        ] {
            let url = try #require(URL(string: address))
            await #expect(throws: CloudflareAccessError.invalidGateway) { try await authorization.headers(url) }
        }
        try await ingress.forget(origin: fixture.application.origin)
        #expect(!authorization.isCurrent())
        await #expect(throws: GatewayExternalAuthorizationError.self) {
            try await authorization.headers(fixture.route.url)
        }
    }

    @Test(arguments: [false, true]) @MainActor
    func `a grant retired during discovery cannot downgrade into ordinary admission`(forget: Bool) async throws {
        let fixture = try IngressTestHarness()
        fixture.persisted = try String(data: JSONEncoder().encode(fixture.nextSession), encoding: .utf8)
        let ingress = fixture.controller()
        let gate = AsyncStream<Void>.makeStream()
        fixture.probeGate = gate.stream
        fixture.probeRequiresManagedGrant = true
        let pending = Task { try await ingress.prepare(
            route: fixture.route,
            userInitiated: false,
            admissionCheckpoint: ingress.admissionCheckpoint()) }
        try await waitForIngress { fixture.probeStarted }
        #expect(fixture.requests.last?.value(forHTTPHeaderField: "Cf-Access-Token") != nil)
        if forget {
            try await ingress.forget(origin: fixture.application.origin)
        } else {
            fixture.now = fixture.nextSession.expiresAt
        }
        gate.continuation.yield()
        if forget {
            await #expect(throws: CancellationError.self) { try await pending.value }
        } else {
            await #expect(throws: GatewayExternalAuthorizationError.self) { try await pending.value }
        }
        #expect(fixture.browser.presented.isEmpty)
        try await waitForIngress { fixture.retirements == 1 }
        #expect(fixture.persisted == nil)
    }

    @Test @MainActor
    func `silent revoked admission retires the existing session before returning attention`() async throws {
        let fixture = try IngressTestHarness()
        fixture.persisted = try String(data: JSONEncoder().encode(fixture.nextSession), encoding: .utf8)
        let ingress = fixture.controller()
        let admitted = try await ingress.prepare(
            route: fixture.route,
            userInitiated: false,
            admissionCheckpoint: ingress.admissionCheckpoint())
        let old = try #require(admitted)
        fixture.revoked = true
        await #expect(throws: GatewayExternalAuthorizationError.self) {
            try await ingress.prepare(
                route: fixture.route,
                userInitiated: false,
                admissionCheckpoint: ingress.admissionCheckpoint())
        }
        #expect(fixture.retirements == 1)
        #expect(fixture.persisted == nil)
        #expect(!old.isCurrent())
        #expect(ingress.attention?.stableID == fixture.stableID)
        #expect(fixture.browser.presented.isEmpty)
    }

    @Test @MainActor
    func `cancel rejects late completion and permits one explicit retry`() async throws {
        let fixture = try IngressTestHarness()
        let ingress = fixture.controller()
        let admission = Task { try await ingress.prepare(
            route: fixture.route,
            userInitiated: true,
            admissionCheckpoint: ingress.admissionCheckpoint()) }
        try await waitForIngress { fixture.browser.presented.count == 1 }
        let staleCancel = fixture.browser.cancel
        ingress.cancelSignIn()
        fixture.release.continuation.yield()
        await #expect(throws: CancellationError.self) { try await admission.value }
        #expect(fixture.persisted == nil)
        fixture.release = AsyncStream<Void>.makeStream()
        let retry = Task { try await ingress.prepare(
            route: fixture.route,
            userInitiated: true,
            admissionCheckpoint: ingress.admissionCheckpoint()) }
        try await waitForIngress { fixture.browser.presented.count == 2 }
        staleCancel?()
        #expect(ingress.signingIn)
        fixture.release.continuation.yield()
        let admitted = try await retry.value
        let authorization = try #require(admitted)
        #expect(authorization.isCurrent())
        try await ingress.forget(origin: fixture.application.origin)
    }

    @Test @MainActor
    func `foreground expiry retires transports without automatic browser retry`() async throws {
        let fixture = try IngressTestHarness()
        fixture.persisted = try String(data: JSONEncoder().encode(fixture.nextSession), encoding: .utf8)
        let ingress = fixture.controller()
        let admitted = try await ingress.prepare(
            route: fixture.route,
            userInitiated: false,
            admissionCheckpoint: ingress.admissionCheckpoint())
        let authorization = try #require(admitted)
        fixture.now = fixture.nextSession.expiresAt
        ingress.foregrounded()
        #expect(!authorization.isCurrent())
        try await waitForIngress { fixture.retirements == 1 }
        #expect(fixture.browser.presented.isEmpty)
        #expect(ingress.attention != nil)
        await #expect(throws: GatewayExternalAuthorizationError.self) {
            try await authorization.headers(fixture.route.url)
        }
    }

    @Test @MainActor
    func `forget cancels and joins an in-flight media download before completing`() async throws {
        let fixture = try IngressTestHarness()
        fixture.persisted = try String(data: JSONEncoder().encode(fixture.nextSession), encoding: .utf8)
        let ingress = fixture.controller()
        let admitted = try await ingress.prepare(
            route: fixture.route,
            userInitiated: false,
            admissionCheckpoint: ingress.admissionCheckpoint())
        let authorization = try #require(admitted)
        let started = AsyncStream<Void>.makeStream()
        let request = URLRequest(url: fixture.route.url)
        let download = Task {
            try await authorization.load(request) { _ in
                started.continuation.yield()
                try await Task.sleep(for: .seconds(300))
                throw URLError(.timedOut)
            }
        }
        for await _ in started.stream {
            break
        }
        try await ingress.forget(origin: fixture.application.origin)
        await #expect(throws: CancellationError.self) { try await download.value }
        #expect(fixture.retirements == 1)
        #expect(fixture.persisted == nil)
    }

    @Test @MainActor
    func `revocation pauses both roles and old rejection cannot retire a renewed account`() async throws {
        let fixture = try IngressTestHarness()
        fixture.persisted = try String(data: JSONEncoder().encode(fixture.nextSession), encoding: .utf8)
        let ingress = fixture.controller()
        let admitted = try await ingress.prepare(
            route: fixture.route,
            userInitiated: false,
            admissionCheckpoint: ingress.admissionCheckpoint())
        let old = try #require(admitted)
        fixture.revoked = true
        await #expect(throws: GatewayExternalAuthorizationError.self) { try await old.headers(fixture.route.url) }
        #expect(fixture.browser.presented.isEmpty)
        fixture.nextSession = try fixture.tokens.session(subject: "replacement-subject")
        let renewal = Task { try await ingress.prepare(
            route: fixture.route,
            userInitiated: true,
            admissionCheckpoint: ingress.admissionCheckpoint()) }
        try await waitForIngress { fixture.browser.presented.count == 1 }
        fixture.revoked = false
        fixture.release.continuation.yield()
        let renewed = try await renewal.value
        let current = try #require(renewed)
        #expect(current.revision != old.revision)
        let challenge = try #require(HTTPURLResponse(
            url: fixture.route.url,
            statusCode: 302,
            httpVersion: nil,
            headerFields: [
                "WWW-Authenticate": "Cloudflare-Access resource_metadata=\"\(fixture.route.url.absoluteString)" +
                    "/.well-known/cloudflare-access-protected-resource/\"",
            ]))
        await #expect(throws: GatewayExternalAuthorizationError.self) { try await old.checkResponse(challenge) }
        #expect(current.isCurrent())
        try await ingress.forget(origin: fixture.application.origin)
    }

    @Test(arguments: [false, true]) @MainActor
    func `replacement browser waits for dismissal and rejects a canceled presentation`(
        cancelReplacement: Bool) async throws
    {
        let url = try #require(URL(string: "https://gateway.example.test/"))
        let gate = AsyncStream<Void>.makeStream()
        var presented: [SFSafariViewController] = []
        var dismissals = 0
        var cancellations = 0
        let presenter = CloudflareAccessBrowserPresenter(present: { presented.append($0) }, dismiss: { _ in
            dismissals += 1
            for await _ in gate.stream {
                break
            }
        })
        let firstID = UUID()
        try await presenter.open(url, intentID: firstID) { cancellations += 1 }
        let closing = Task { await presenter.dismiss(intentID: firstID) }
        try await waitForIngress { dismissals == 1 }
        let replacementID = UUID()
        var replacementStarted = false
        let replacement = Task {
            replacementStarted = true
            try await presenter.open(url, intentID: replacementID) { cancellations += 1 }
        }
        defer {
            gate.continuation.finish()
            replacement.cancel()
        }
        try await waitForIngress { replacementStarted }
        #expect(presented.count == 1)
        #expect(dismissals == 1)
        if cancelReplacement {
            replacement.cancel()
        }
        gate.continuation.finish()
        await closing.value
        if cancelReplacement {
            await #expect(throws: CancellationError.self) { try await replacement.value }
            #expect(presented.count == 1)
            return
        }
        try await replacement.value
        #expect(presented.count == 2)
        #expect(cancellations == 0)
        await presenter.dismiss(intentID: firstID)
        #expect(dismissals == 1)
        let current = try #require(presented.last)
        presenter.safariViewControllerDidFinish(current)
        await presenter.dismiss(intentID: replacementID)
        #expect(cancellations == 1)
        #expect(dismissals == 2)
    }

    @Test @MainActor
    func `forget retires only the selected profile capability and pending media`() async throws {
        let fixture = try IngressTestHarness()
        var sibling = try #require(fixture.profileRows.first)
        sibling.stableID = "discovered-sibling"
        fixture.profileRows.append(sibling)
        fixture.persisted = try String(data: JSONEncoder().encode(fixture.nextSession), encoding: .utf8)
        let ingress = fixture.controller()
        let first = try await ingress.prepare(
            route: fixture.route,
            userInitiated: false,
            admissionCheckpoint: ingress.admissionCheckpoint())
        let firstAuthorization = try #require(first)
        let siblingRoute = GatewayIngressController.Route(url: fixture.route.url, stableID: sibling.stableID, tls: nil)
        let second = try await ingress.prepare(
            route: siblingRoute,
            userInitiated: false,
            admissionCheckpoint: ingress.admissionCheckpoint())
        let siblingAuthorization = try #require(second)
        #expect(firstAuthorization.revision == siblingAuthorization.revision)
        let started = AsyncStream<Void>.makeStream()
        let request = URLRequest(url: fixture.route.url)
        let download = Task {
            try await firstAuthorization.load(request) { _ in
                started.continuation.yield()
                try await Task.sleep(for: .seconds(300))
                throw URLError(.timedOut)
            }
        }
        defer { download.cancel() }
        for await _ in started.stream {
            break
        }
        try await ingress.forget(stableID: fixture.stableID)
        await #expect(throws: CancellationError.self) { try await download.value }
        #expect(!firstAuthorization.isCurrent())
        #expect(siblingAuthorization.isCurrent())
        #expect(fixture.persisted != nil)
        #expect(fixture.retirements == 0)
        await #expect(throws: GatewayExternalAuthorizationError.self) {
            try await firstAuthorization.headers(fixture.route.url)
        }
        await #expect(throws: GatewayExternalAuthorizationError.self) {
            try await firstAuthorization.load(request) { _ in
                Issue.record("A forgotten profile started a new media request")
                throw URLError(.cancelled)
            }
        }
        let challenge = try #require(HTTPURLResponse(
            url: fixture.route.url,
            statusCode: 302,
            httpVersion: nil,
            headerFields: [
                "WWW-Authenticate": "Cloudflare-Access resource_metadata=\"\(fixture.route.url.absoluteString)" +
                    "/.well-known/cloudflare-access-protected-resource/\"",
            ]))
        await #expect(throws: GatewayExternalAuthorizationError.self) {
            try await firstAuthorization.checkResponse(challenge)
        }
        let headers = try await siblingAuthorization.headers(fixture.route.url)
        #expect(headers["Cf-Access-Token"] != nil)
        let ordinary = try #require(HTTPURLResponse(
            url: fixture.route.url,
            statusCode: 200,
            httpVersion: nil,
            headerFields: nil))
        let loaded = try await siblingAuthorization.load(request) { _ in (Data([1]), ordinary) }
        #expect(loaded.0 == Data([1]))
        await ingress.signOut(stableID: sibling.stableID)
        #expect(!siblingAuthorization.isCurrent())
        #expect(fixture.persisted == nil)
        #expect(fixture.retirements == 1)
        #expect(ingress.attention?.message.contains("this host") == true)
    }

    @Test @MainActor
    func `forgetting a sibling does not cancel the profile that owns browser sign-in`() async throws {
        let fixture = try IngressTestHarness()
        var sibling = try #require(fixture.profileRows.first)
        sibling.stableID = "discovered-sibling"
        sibling.accessOrigin = fixture.application.origin
        fixture.profileRows.append(sibling)
        let ingress = fixture.controller()
        let pending = Task { try await ingress.prepare(
            route: fixture.route,
            userInitiated: true,
            admissionCheckpoint: ingress.admissionCheckpoint()) }
        defer { fixture.release.continuation.finish()
            pending.cancel()
        }
        try await waitForIngress { fixture.browser.presented.count == 1 }
        try await ingress.forget(stableID: sibling.stableID)
        #expect(ingress.signingIn)
        #expect(fixture.browser.dismissed.isEmpty)
        fixture.release.continuation.finish()
        let admitted = try await pending.value
        #expect(admitted?.isCurrent() == true)
        let relaunched = fixture.controller()
        try await relaunched.forget(stableID: fixture.stableID)
        #expect(fixture.persisted == nil)
    }

    @Test(arguments: ["forget", "replacement"], ["before-browser", "queued-browser", "committed"]) @MainActor
    func `creator departure preserves a coalesced browser and its terminal waiters`(
        departure: String, stage: String) async throws
    {
        let fixture = try IngressTestHarness()
        var sibling = try #require(fixture.profileRows.first)
        sibling.stableID = "surviving-browser-profile"
        fixture.profileRows.append(sibling)
        let peerRoute = GatewayIngressController.Route(url: fixture.route.url, stableID: sibling.stableID, tls: nil)
        let opening = IngressTestGate()
        let authentication = IngressTestGate()
        let dismissal = AsyncStream<Void>.makeStream()
        let dismissing = AsyncStream<Void>.makeStream()
        let probe = AsyncStream<Void>.makeStream()
        let probeEntered = AsyncStream<Void>.makeStream()
        let canceled = OSAllocatedUnfairLock(initialState: false)
        var prompts = 0
        let ingress = fixture.controller(authenticate: { application, browser in
            prompts += 1
            return try await withTaskCancellationHandler {
                await opening.wait()
                try await browser(application.origin.url.appendingPathComponent("cdn-cgi/access/cli"))
                await authentication.wait()
                try Task.checkCancellation()
                return fixture.nextSession
            } onCancel: { canceled.withLock { $0 = true } }
        })
        if stage != "before-browser" {
            opening.release()
        }
        if stage == "committed" {
            fixture.browser.dismissalGate = dismissal.stream
            fixture.browser.onDismiss = { dismissing.continuation.finish() }
        }
        let first = Task { try await ingress.prepare(
            route: fixture.route, userInitiated: true, admissionCheckpoint: ingress.admissionCheckpoint()) }
        var peer: Task<GatewayIngressAuthorization?, Error>?
        var replacement: Task<GatewayIngressAuthorization?, Error>?
        defer {
            opening.release()
            authentication.release()
            dismissal.continuation.finish()
            probe.continuation.finish()
            first.cancel()
            peer?.cancel()
            replacement?.cancel()
        }
        await opening.waitUntilStarted()
        if stage != "before-browser" {
            await authentication.waitUntilStarted()
        }
        let joined = AsyncStream<Void>.makeStream()
        withObservationTracking { _ = ingress.attention } onChange: { joined.continuation.finish() }
        peer = Task { try await ingress.prepare(
            route: peerRoute, userInitiated: true, admissionCheckpoint: ingress.admissionCheckpoint()) }
        for await _ in joined.stream {}
        let attentionID = try #require(ingress.attention?.id)
        if stage == "committed" {
            authentication.release()
            for await _ in dismissing.stream {}
            #expect(fixture.persisted != nil)
        }
        if departure == "forget" {
            try await ingress.forget(stableID: fixture.stableID)
        } else {
            fixture.probeStableID = fixture.stableID
            fixture.probeGate = probe.stream
            fixture.probeDidStart = { probeEntered.continuation.finish() }
            let route = GatewayIngressController.Route(
                url: fixture.route.url.appendingPathComponent("replacement"), stableID: fixture.stableID, tls: nil)
            replacement = Task { try await ingress.prepare(
                route: route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()) }
            for await _ in probeEntered.stream {}
        }
        #expect(!canceled.withLock { $0 })
        #expect(ingress.signingIn)
        #expect(ingress.attention?.id == attentionID)
        #expect(ingress.attention?.stableID == sibling.stableID)
        #expect(fixture.browser.dismissed.count == (stage == "committed" ? 1 : 0))
        #expect(prompts == 1)
        opening.release()
        await authentication.waitUntilStarted()
        authentication.release()
        dismissal.continuation.finish()
        await #expect(throws: CancellationError.self) { try await first.value }
        let survivor = try #require(try await peer?.value)
        #expect(survivor.isCurrent())
        #expect(try await survivor.headers(peerRoute.url)["Cf-Access-Token"] == fixture.nextSession
            .authorizationHeader(for: peerRoute.url, now: fixture.now))
        #expect(fixture.profileRows[1].accessOrigin == fixture.application.origin)
        #expect(fixture.persisted != nil)
        #expect(fixture.retirements == 1)
        #expect(fixture.browser.presented.count == 1)
        #expect(fixture.browser.dismissed.count == 1)
        #expect(ingress.attention == nil)
        if let replacement {
            replacement.cancel()
            probe.continuation.finish()
            await #expect(throws: CancellationError.self) { try await replacement.value }
        }
        #expect(survivor.isCurrent())
    }

    @Test(arguments: [false, true]) @MainActor
    func `explicit profile departure cancels its sole browser attempt`(replace: Bool) async throws {
        let fixture = try IngressTestHarness()
        let authentication = IngressTestGate()
        let dismissed = AsyncStream<Void>.makeStream()
        let canceled = OSAllocatedUnfairLock(initialState: false)
        fixture.browser.onDismiss = { dismissed.continuation.finish() }
        let ingress = fixture.controller(authenticate: { application, browser in
            try await browser(application.origin.url.appendingPathComponent("cdn-cgi/access/cli"))
            return await withTaskCancellationHandler {
                await authentication.wait()
                return fixture.nextSession
            } onCancel: { canceled.withLock { $0 = true } }
        })
        let pending = Task { try await ingress.prepare(
            route: fixture.route, userInitiated: true, admissionCheckpoint: ingress.admissionCheckpoint()) }
        defer {
            authentication.release()
            pending.cancel()
        }
        await authentication.waitUntilStarted()
        if replace {
            fixture.preauthenticated = true
            let route = GatewayIngressController.Route(
                url: fixture.route.url.appendingPathComponent("ordinary"), stableID: fixture.stableID, tls: nil)
            #expect(try await ingress.prepare(
                route: route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()) == nil)
        } else {
            try await ingress.forget(stableID: fixture.stableID)
        }
        #expect(canceled.withLock { $0 })
        for await _ in dismissed.stream {}
        #expect(!ingress.signingIn)
        #expect(ingress.attention == nil)
        authentication.release()
        await #expect(throws: CancellationError.self) { try await pending.value }
        #expect(fixture.persisted == nil)
        #expect(fixture.browser.presented.count == 1)
        #expect(fixture.browser.dismissed.count == 1)
    }

    @Test @MainActor
    func `passive route replacement preserves a peer until a different application requests sign-in`() async throws {
        let fixture = try IngressTestHarness()
        var sibling = try #require(fixture.profileRows.first)
        sibling.stableID = "previous-application-peer"
        fixture.profileRows.append(sibling)
        let peerRoute = GatewayIngressController.Route(url: fixture.route.url, stableID: sibling.stableID, tls: nil)
        let other = CloudflareAccessApplication(
            origin: fixture.application.origin, issuer: fixture.application.issuer, audience: "replacement-audience")
        let replacementSession = try fixture.session(for: other, subject: "replacement-owner")
        let oldAuthentication = IngressTestGate()
        let newAuthentication = IngressTestGate()
        let probe = AsyncStream<Void>.makeStream()
        let probeEntered = AsyncStream<Void>.makeStream()
        let canceled = OSAllocatedUnfairLock(initialState: false)
        var applications: [CloudflareAccessApplication] = []
        let ingress = fixture.controller(authenticate: { application, browser in
            applications.append(application)
            try await browser(application.origin.url.appendingPathComponent("cdn-cgi/access/cli"))
            if application == fixture.application {
                return await withTaskCancellationHandler {
                    await oldAuthentication.wait()
                    return fixture.nextSession
                } onCancel: { canceled.withLock { $0 = true } }
            }
            await newAuthentication.wait()
            try Task.checkCancellation()
            return replacementSession
        })
        let first = Task { try await ingress.prepare(
            route: fixture.route, userInitiated: true, admissionCheckpoint: ingress.admissionCheckpoint()) }
        var peer: Task<GatewayIngressAuthorization?, Error>?
        var replacement: Task<GatewayIngressAuthorization?, Error>?
        defer {
            oldAuthentication.release()
            newAuthentication.release()
            probe.continuation.finish()
            first.cancel()
            peer?.cancel()
            replacement?.cancel()
        }
        await oldAuthentication.waitUntilStarted()
        let joined = AsyncStream<Void>.makeStream()
        withObservationTracking { _ = ingress.attention } onChange: { joined.continuation.finish() }
        peer = Task { try await ingress.prepare(
            route: peerRoute, userInitiated: true, admissionCheckpoint: ingress.admissionCheckpoint()) }
        for await _ in joined.stream {}
        fixture.applicationsByStableID[fixture.stableID] = other
        fixture.probeStableID = fixture.stableID
        fixture.probeGate = probe.stream
        fixture.probeDidStart = { probeEntered.continuation.finish() }
        let route = GatewayIngressController.Route(
            url: fixture.route.url.appendingPathComponent("other-application"), stableID: fixture.stableID, tls: nil)
        replacement = Task { try await ingress.prepare(
            route: route, userInitiated: true, admissionCheckpoint: ingress.admissionCheckpoint()) }
        for await _ in probeEntered.stream {}
        #expect(!canceled.withLock { $0 })
        #expect(applications == [fixture.application])
        #expect(fixture.browser.dismissed.isEmpty)
        #expect(ingress.attention?.stableID == sibling.stableID)
        probe.continuation.finish()
        await newAuthentication.waitUntilStarted()
        #expect(canceled.withLock { $0 })
        #expect(applications == [fixture.application, other])
        #expect(ingress.attention?.stableID == fixture.stableID)
        oldAuthentication.release()
        await #expect(throws: CancellationError.self) { try await first.value }
        await #expect(throws: CancellationError.self) { try await peer?.value }
        newAuthentication.release()
        let current = try #require(try await replacement?.value)
        #expect(current.isCurrent())
        #expect(try JSONDecoder().decode(CloudflareAccessSession.self, from: Data(#require(fixture.persisted).utf8))
            .subject == "replacement-owner")
        #expect(ingress.attention == nil)
        #expect(fixture.browser.presented.count == 2)
    }

    @Test(arguments: [false, true]) @MainActor
    func `an older ordinary probe cannot replace a newly classified managed browser`(
        alreadyOrdinary: Bool) async throws
    {
        let fixture = try IngressTestHarness()
        let authentication = IngressTestGate()
        let ingress = fixture.controller(authenticate: { application, browser in
            try await browser(application.origin.url.appendingPathComponent("cdn-cgi/access/cli"))
            await authentication.wait()
            try Task.checkCancellation()
            return fixture.nextSession
        })
        fixture.preauthenticated = true
        if alreadyOrdinary {
            #expect(try await ingress.prepare(
                route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()) == nil)
        }
        let ordinaryProbe = AsyncStream<Void>.makeStream()
        let entered = AsyncStream<Void>.makeStream()
        fixture.probeGate = ordinaryProbe.stream
        fixture.probeDidStart = { entered.continuation.finish() }
        let old = Task { try await ingress.prepare(
            route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()) }
        var managed: Task<GatewayIngressAuthorization?, Error>?
        defer {
            ordinaryProbe.continuation.finish()
            authentication.release()
            old.cancel()
            managed?.cancel()
        }
        for await _ in entered.stream {}
        fixture.probeGate = nil
        fixture.preauthenticated = false
        managed = Task { try await ingress.prepare(
            route: fixture.route, userInitiated: true, admissionCheckpoint: ingress.admissionCheckpoint()) }
        await authentication.waitUntilStarted()
        let action = try #require(ingress.attention)
        #expect(fixture.browser.presented.count == 1)
        fixture.preauthenticated = true
        ordinaryProbe.continuation.finish()
        await #expect(throws: CancellationError.self) { try await old.value }
        #expect(ingress.attention?.id == action.id)
        #expect(ingress.signingIn)
        #expect(fixture.browser.dismissed.isEmpty)
        authentication.release()
        let current = try #require(try await managed?.value)
        #expect(current.isCurrent())
        #expect(fixture.persisted != nil)
        #expect(fixture.retirements == 1)
        #expect(ingress.attention == nil)
    }

    @Test(arguments: [false, true], [false, true]) @MainActor
    func `ordinary admission retires its browser participant while preserving a peer`(
        delayed: Bool, hasPeer: Bool) async throws
    {
        let fixture = try IngressTestHarness()
        var sibling = try #require(fixture.profileRows.first)
        sibling.stableID = "ordinary-browser-peer"
        fixture.profileRows.append(sibling)
        let siblingRoute = GatewayIngressController.Route(
            url: fixture.route.url, stableID: sibling.stableID, tls: nil)
        let opening = IngressTestGate()
        let authentication = IngressTestGate()
        var prompts = 0
        var authenticationCanceled = false
        let ingress = fixture.controller(authenticate: { application, browser in
            prompts += 1
            await opening.wait()
            authenticationCanceled = Task.isCancelled
            try await browser(application.origin.url.appendingPathComponent("cdn-cgi/access/cli"))
            await authentication.wait()
            authenticationCanceled = Task.isCancelled
            try Task.checkCancellation()
            return fixture.nextSession
        })
        if !delayed { opening.release() }
        let first = Task { try await ingress.prepare(
            route: fixture.route, userInitiated: true, admissionCheckpoint: ingress.admissionCheckpoint()) }
        var peer: Task<GatewayIngressAuthorization?, Error>?
        defer {
            opening.release()
            authentication.release()
            first.cancel()
            peer?.cancel()
        }
        await opening.waitUntilStarted()
        if !delayed { await authentication.waitUntilStarted() }
        #expect(fixture.browser.presented.count == (delayed ? 0 : 1))
        if hasPeer {
            let joined = AsyncStream<Void>.makeStream()
            withObservationTracking { _ = ingress.attention } onChange: { joined.continuation.finish() }
            peer = Task { try await ingress.prepare(
                route: siblingRoute, userInitiated: true, admissionCheckpoint: ingress.admissionCheckpoint()) }
            // The prompt and participant attach share one MainActor segment before completion is awaited.
            for await _ in joined.stream {}
            #expect(ingress.attention?.stableID == sibling.stableID)
        }
        fixture.preauthenticatedStableIDs.insert(fixture.stableID)
        #expect(try await ingress.prepare(
            route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()) == nil)
        #expect(try await ingress.prepare(
            route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()) == nil)
        #expect(!authenticationCanceled)
        #expect(fixture.retirements == 0)
        #expect(ingress.attention?.stableID == (hasPeer ? sibling.stableID : nil))
        opening.release()
        if hasPeer || !delayed { await authentication.waitUntilStarted() }
        if hasPeer {
            #expect(fixture.browser.presented.count == 1)
            #expect(fixture.browser.dismissed.isEmpty)
        }
        authentication.release()
        await #expect(throws: CancellationError.self) { try await first.value }
        if let peer {
            let authorization = try #require(try await peer.value)
            #expect(authorization.isCurrent())
            #expect(try await authorization.headers(siblingRoute.url)["Cf-Access-Token"] == fixture.nextSession
                .authorizationHeader(
                    for: siblingRoute.url,
                    now: fixture.now))
            #expect(fixture.persisted != nil)
        }
        #expect(prompts == 1)
        #expect(!authenticationCanceled)
        #expect(fixture.browser.presented.count == (delayed && !hasPeer ? 0 : 1))
        #expect(ingress.attention == nil)
        #expect(!ingress.signingIn)
        #expect(try await ingress.prepare(
            route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()) == nil)
    }

    @Test @MainActor
    func `ordinary registration cannot revive a completed browser waiter after managed readmission`() async throws {
        let fixture = try IngressTestHarness()
        var sibling = try #require(fixture.profileRows.first)
        sibling.stableID = "completed-browser-peer"
        fixture.profileRows.append(sibling)
        let siblingRoute = GatewayIngressController.Route(
            url: fixture.route.url, stableID: sibling.stableID, tls: nil)
        let authentication = IngressTestGate()
        let dismissal = AsyncStream<Void>.makeStream()
        let dismissing = AsyncStream<Void>.makeStream()
        fixture.browser.dismissalGate = dismissal.stream
        fixture.browser.onDismiss = { dismissing.continuation.finish() }
        let ingress = fixture.controller(authenticate: { application, browser in
            try await browser(application.origin.url.appendingPathComponent("cdn-cgi/access/cli"))
            await authentication.wait()
            return fixture.nextSession
        })
        let first = Task { try await ingress.prepare(
            route: fixture.route, userInitiated: true, admissionCheckpoint: ingress.admissionCheckpoint()) }
        var peer: Task<GatewayIngressAuthorization?, Error>?
        defer {
            authentication.release()
            dismissal.continuation.finish()
            first.cancel()
            peer?.cancel()
        }
        await authentication.waitUntilStarted()
        let joined = AsyncStream<Void>.makeStream()
        withObservationTracking { _ = ingress.attention } onChange: { joined.continuation.finish() }
        peer = Task { try await ingress.prepare(
            route: siblingRoute, userInitiated: true, admissionCheckpoint: ingress.admissionCheckpoint()) }
        for await _ in joined.stream {}
        authentication.release()
        for await _ in dismissing.stream {}
        #expect(fixture.persisted != nil)
        #expect(ingress.signingIn)
        fixture.preauthenticatedStableIDs.insert(fixture.stableID)
        #expect(try await ingress.prepare(
            route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()) == nil)
        fixture.preauthenticatedStableIDs.remove(fixture.stableID)
        let current = try #require(try await ingress.prepare(
            route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()))
        #expect(current.isCurrent())
        dismissal.continuation.finish()
        await #expect(throws: CancellationError.self) { try await first.value }
        let surviving = try #require(try await peer?.value)
        #expect(surviving.isCurrent())
        #expect(current.isCurrent())
        #expect(fixture.browser.presented.count == 1)
        #expect(fixture.browser.dismissed.count == 1)
        #expect(ingress.attention == nil)
        #expect(fixture.retirements == 1)
    }

    @Test @MainActor
    func `queued browser grants cannot readmit after synchronous rejection`() async throws {
        let fixture = try IngressTestHarness()
        let authentication = IngressTestGate()
        let retirement = IngressTestGate()
        let dismissal = AsyncStream<Void>.makeStream()
        fixture.browser.dismissalGate = dismissal.stream
        var holdRetirement = false
        let ingress = fixture.controller(authenticate: { application, browser in
            try await browser(application.origin.url.appendingPathComponent("cdn-cgi/access/cli"))
            await authentication.wait()
            try Task.checkCancellation()
            return fixture.nextSession
        }, retirement: { _ in
            if holdRetirement { await retirement.wait() }
        })
        var firstCompleted = false
        var peerCompleted = false
        let first = Task {
            defer { firstCompleted = true }
            return try await ingress.prepare(
                route: fixture.route, userInitiated: true, admissionCheckpoint: ingress.admissionCheckpoint())
        }
        var peer: Task<GatewayIngressAuthorization?, Error>?
        func drain() async {
            authentication.release()
            dismissal.continuation.finish()
            retirement.release()
            first.cancel()
            peer?.cancel()
            _ = await first.result
            _ = await peer?.result
            let cleanup = Task { try? await ingress.forget(origin: fixture.application.origin) }
            await cleanup.value
        }
        do {
            try await waitForIngress { authentication.started }
            let firstAttention = try #require(ingress.attention)
            peer = Task {
                defer { peerCompleted = true }
                return try await ingress.prepare(
                    route: fixture.route, userInitiated: true, admissionCheckpoint: ingress.admissionCheckpoint())
            }
            // Prompt replacement and participant attachment share one MainActor turn.
            try await waitForIngress { ingress.attention?.id != firstAttention.id }
            #expect(fixture.persisted == nil)
            authentication.release()
            try await waitForIngress { fixture.browser.dismissed.count == 1 }
            #expect(fixture.persisted != nil)
            #expect(!firstCompleted && !peerCompleted)
            #expect(fixture.retirements == 1)

            // The cached probe admits G1 without a second browser. Both original
            // callers still hold G1 behind the shared dismissal barrier.
            let current = try #require(try await ingress.prepare(
                route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()))
            #expect(current.isCurrent())
            #expect(fixture.browser.presented.count == 1)
            let challenge = try #require(HTTPURLResponse(
                url: fixture.route.url, statusCode: 302, httpVersion: nil,
                headerFields: ["Location": "/cdn-cgi/access/login/fixture"]))
            holdRetirement = true
            await #expect(throws: GatewayExternalAuthorizationError.self) { try await current.checkResponse(challenge) }
            let rejection = try #require(ingress.attention)
            #expect(rejection.canSignIn)
            #expect(rejection.stableID == fixture.stableID)
            #expect(!current.isCurrent())
            #expect(!ingress.hasSession(stableID: fixture.stableID))
            try await waitForIngress { retirement.started }
            #expect(!retirement.settled)
            #expect(fixture.persisted != nil)

            dismissal.continuation.finish()
            try await waitForIngress { firstCompleted && peerCompleted }
            await #expect(throws: GatewayExternalAuthorizationError.self) { try await first.value }
            await #expect(throws: GatewayExternalAuthorizationError.self) { try await peer?.value }
            #expect(!current.isCurrent())
            #expect(!ingress.hasSession(stableID: fixture.stableID))
            #expect(ingress.attention?.id == rejection.id)
            let requestCount = fixture.requests.count
            await #expect(throws: GatewayExternalAuthorizationError.self) {
                try await current.headers(fixture.route.url)
            }
            #expect(fixture.requests.count == requestCount)
            #expect(!retirement.settled)
            #expect(fixture.retirements == 2)
            retirement.release()
            try await waitForIngress { fixture.persisted == nil }
            #expect(ingress.attention?.id == rejection.id)
            #expect(fixture.browser.presented.count == 1)
        } catch {
            await drain()
            throw error
        }
        await drain()
    }

    @Test(arguments: [false, true]) @MainActor
    func `canceling a browser caller preserves another caller on the same registration`(cancelFirst: Bool) async throws {
        let fixture = try IngressTestHarness()
        let authentication = IngressTestGate()
        let ingress = fixture.controller(authenticate: { application, browser in
            try await browser(application.origin.url.appendingPathComponent("cdn-cgi/access/cli"))
            await authentication.wait()
            try Task.checkCancellation()
            return fixture.nextSession
        })
        let first = Task { try await ingress.prepare(
            route: fixture.route, userInitiated: true, admissionCheckpoint: ingress.admissionCheckpoint()) }
        await authentication.waitUntilStarted()
        let joined = AsyncStream<Void>.makeStream()
        withObservationTracking { _ = ingress.attention } onChange: { joined.continuation.finish() }
        let second = Task { try await ingress.prepare(
            route: fixture.route, userInitiated: true, admissionCheckpoint: ingress.admissionCheckpoint()) }
        defer {
            authentication.release()
            first.cancel()
            second.cancel()
        }
        for await _ in joined.stream {}
        let canceled = cancelFirst ? first : second
        let survivor = cancelFirst ? second : first
        canceled.cancel()
        authentication.release()
        await #expect(throws: CancellationError.self) { try await canceled.value }
        let authorization = try #require(try await survivor.value)
        #expect(authorization.isCurrent())
        #expect(fixture.browser.presented.count == 1)
        #expect(fixture.browser.dismissed.count == 1)
        #expect(fixture.persisted != nil)
        #expect(ingress.attention == nil)
    }

    @Test(arguments: [false, true], [false, true]) @MainActor
    func `forget retains withdrawn authentication custody while preserving a live coalesced peer`(
        hasLivePeer: Bool, ordinary: Bool) async throws
    {
        let fixture = try IngressTestHarness()
        fixture.profileRows[0].accessOrigin = fixture.application.origin
        var sibling = try #require(fixture.profileRows.first)
        sibling.stableID = "withdrawn-owner-peer"
        fixture.profileRows.append(sibling)
        let siblingRoute = GatewayIngressController.Route(
            url: fixture.route.url, stableID: sibling.stableID, tls: nil)
        let authentication = IngressTestGate()
        let canceled = OSAllocatedUnfairLock(initialState: false)
        var prompts = 0
        let ingress = fixture.controller(authenticate: { application, browser in
            prompts += 1
            try await browser(application.origin.url.appendingPathComponent("cdn-cgi/access/cli"))
            return await withTaskCancellationHandler {
                await authentication.wait()
                return fixture.nextSession
            } onCancel: { canceled.withLock { $0 = true } }
        })
        var caller: Task<GatewayIngressAuthorization?, Error>?
        var peer: Task<GatewayIngressAuthorization?, Error>?
        func drainCallers() async {
            authentication.release()
            ingress.cancelSignIn()
            caller?.cancel()
            peer?.cancel()
            _ = try? await caller?.value
            _ = try? await peer?.value
        }
        do {
            if hasLivePeer {
                peer = Task { try await ingress.prepare(
                    route: siblingRoute, userInitiated: true, admissionCheckpoint: ingress.admissionCheckpoint()) }
                try await waitForIngress { authentication.started }
            }
            caller = Task { try await ingress.prepare(
                route: fixture.route, userInitiated: true, admissionCheckpoint: ingress.admissionCheckpoint()) }
            try await waitForIngress { authentication.started && ingress.attention?.stableID == fixture.stableID }
            #expect(prompts == 1)
            #expect(fixture.browser.presented.count == 1)
            caller?.cancel()
            if hasLivePeer {
                // Retargeting the caller's prompt proves withdrawal completed before explicit departure.
                try await waitForIngress { ingress.attention?.stableID == sibling.stableID }
            } else {
                try await waitForIngress { !fixture.browser.dismissed.isEmpty }
                #expect(ingress.attention == nil)
            }
            #expect(!canceled.withLock { $0 })
            #expect(fixture.persisted == nil)
            if ordinary {
                fixture.preauthenticatedStableIDs.insert(fixture.stableID)
                let admission = try await ingress.prepare(
                    route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint())
                #expect(admission == nil)
                #expect(!canceled.withLock { $0 })
            }
            try await ingress.forget(stableID: fixture.stableID)
            #expect(canceled.withLock { $0 } == !hasLivePeer)
            #expect(fixture.profileRows.first { $0.stableID == fixture.stableID }?.accessOrigin == nil)
            #expect(fixture.profileRows.first { $0.stableID == sibling.stableID }?.accessOrigin == fixture.application
                .origin)
            #expect(fixture.persisted == nil)
            #expect(fixture.retirements == 0)
            if hasLivePeer {
                #expect(ingress.signingIn)
                #expect(ingress.attention?.stableID == sibling.stableID)
            } else {
                #expect(!ingress.signingIn)
                #expect(ingress.attention == nil)
            }
            // A cancellation-ignoring transfer cannot repersist after its exact owner was forgotten.
            authentication.release()
            let departed = try #require(caller)
            await #expect(throws: CancellationError.self) { try await departed.value }
            if hasLivePeer {
                let authorization = try #require(try await peer?.value)
                #expect(authorization.isCurrent())
                #expect(try await authorization.headers(siblingRoute.url)["Cf-Access-Token"] == fixture.nextSession
                    .authorizationHeader(for: siblingRoute.url))
                #expect(fixture.persisted != nil)
                #expect(fixture.retirements == 1)
            } else {
                #expect(fixture.persisted == nil)
                #expect(fixture.retirements == 0)
            }
            #expect(authentication.settled)
            #expect(prompts == 1)
        } catch {
            await drainCallers()
            throw error
        }
        await drainCallers()
    }

    @Test @MainActor
    func `a new browser caller replaces an intent after its final participant withdraws`() async throws {
        let fixture = try IngressTestHarness()
        let oldSession = fixture.nextSession
        let newSession = try fixture.session(for: fixture.application, subject: "new-browser-owner")
        let oldAuthentication = IngressTestGate()
        let newAuthentication = IngressTestGate()
        let withdrawn = AsyncStream<Void>.makeStream()
        let oldCanceled = OSAllocatedUnfairLock(initialState: false)
        fixture.browser.onDismiss = { withdrawn.continuation.finish() }
        var prompts = 0
        let ingress = fixture.controller(authenticate: { application, browser in
            prompts += 1
            if prompts == 1 {
                return await withTaskCancellationHandler {
                    await oldAuthentication.wait()
                    return oldSession
                } onCancel: { oldCanceled.withLock { $0 = true } }
            }
            try await browser(application.origin.url.appendingPathComponent("cdn-cgi/access/cli"))
            await newAuthentication.wait()
            try Task.checkCancellation()
            return newSession
        })
        let first = Task { try await ingress.prepare(
            route: fixture.route, userInitiated: true, admissionCheckpoint: ingress.admissionCheckpoint()) }
        var replacement: Task<GatewayIngressAuthorization?, Error>?
        defer {
            oldAuthentication.release()
            newAuthentication.release()
            first.cancel()
            replacement?.cancel()
        }
        await oldAuthentication.waitUntilStarted()
        first.cancel()
        for await _ in withdrawn.stream {}
        #expect(!oldCanceled.withLock { $0 })
        #expect(ingress.attention == nil)
        #expect(fixture.browser.presented.isEmpty)
        replacement = Task { try await ingress.prepare(
            route: fixture.route, userInitiated: true, admissionCheckpoint: ingress.admissionCheckpoint()) }
        await newAuthentication.waitUntilStarted()
        #expect(oldCanceled.withLock { $0 })
        #expect(prompts == 2)
        #expect(fixture.browser.presented.count == 1)
        oldAuthentication.release()
        await #expect(throws: CancellationError.self) { try await first.value }
        #expect(fixture.persisted == nil)
        newAuthentication.release()
        let authorization = try #require(try await replacement?.value)
        #expect(authorization.isCurrent())
        #expect(try JSONDecoder().decode(CloudflareAccessSession.self, from: Data(#require(fixture.persisted).utf8))
            .subject ==
            "new-browser-owner")
        #expect(ingress.attention == nil)
        #expect(!ingress.signingIn)
    }

    @Test(arguments: [-1, 0, 1]) @MainActor
    func `coalesced callers share authentication and dismissal despite caller cancellation`(
        canceledCaller: Int) async throws
    {
        let fixture = try IngressTestHarness()
        var sibling = try #require(fixture.profileRows.first)
        sibling.stableID = "coalesced-sibling"
        fixture.profileRows.append(sibling)
        let ingress = fixture.controller()
        let dismissal = AsyncStream<Void>.makeStream()
        fixture.browser.dismissalGate = dismissal.stream
        let first = Task { try await ingress.prepare(
            route: fixture.route, userInitiated: true, admissionCheckpoint: ingress.admissionCheckpoint()) }
        var second: Task<GatewayIngressAuthorization?, Error>?
        func drainCallers() async {
            fixture.release.continuation.finish()
            dismissal.continuation.finish()
            first.cancel()
            second?.cancel()
            _ = try? await first.value
            _ = try? await second?.value
        }
        do {
            try await waitForIngress { fixture.browser.presented.count == 1 }
            let secondRoute = GatewayIngressController.Route(
                url: fixture.route.url, stableID: sibling.stableID, tls: nil)
            second = Task { try await ingress.prepare(
                route: secondRoute, userInitiated: true, admissionCheckpoint: ingress.admissionCheckpoint()) }
            // Prompt publication and participant attachment share one MainActor segment.
            // Discovery request entry alone does not establish a surviving browser caller.
            try await waitForIngress { ingress.attention?.stableID == sibling.stableID }
            #expect(ingress.attention?.stableID == sibling.stableID)
            #expect(fixture.persisted == nil)
            if canceledCaller == 0 {
                first.cancel()
            }
            if canceledCaller == 1 {
                second?.cancel()
            }
            fixture.release.continuation.finish()
            try await waitForIngress { !fixture.browser.dismissed.isEmpty }
            #expect(ingress.signingIn)
            #expect(fixture.browser.presented.count == 1)
            #expect(fixture.browser.dismissed.count == 1)
            dismissal.continuation.finish()
            for (index, task) in try [first, #require(second)].enumerated() {
                if index == canceledCaller {
                    await #expect(throws: CancellationError.self) { try await task.value }
                } else {
                    let authorization = try #require(try await task.value)
                    #expect(authorization.isCurrent())
                }
            }
            #expect(!ingress.signingIn)
            #expect(fixture.browser.dismissed.count == 1)
            #expect(fixture.persisted != nil)
        } catch {
            await drainCallers()
            throw error
        }
        await drainCallers()
    }

    @Test(arguments: [false, true]) @MainActor
    func `already canceled preparation preserves active and cold saved ownership`(cold: Bool) async throws {
        let fixture = try IngressTestHarness()
        fixture.persisted = try String(data: JSONEncoder().encode(fixture.nextSession), encoding: .utf8)
        fixture.profileRows[0].accessOrigin = fixture.application.origin
        let ingress = fixture.controller()
        let authorization = cold ? nil : try await ingress.prepare(
            route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint())
        let original = fixture.persisted
        let requests = fixture.requests.count
        let writes = fixture.savedOrigins.count
        let replacement = try GatewayIngressController.Route(
            url: #require(URL(string: "https://replacement.example.test/")),
            stableID: fixture.stableID, tls: nil)
        let canceled = Task { try await ingress.prepare(
            route: replacement, userInitiated: true, admissionCheckpoint: ingress.admissionCheckpoint()) }
        // This test still owns MainActor: cancellation precedes the new task's entry.
        canceled.cancel()
        await #expect(throws: CancellationError.self) { try await canceled.value }
        #expect(fixture.persisted == original)
        #expect(fixture.profileRows[0].accessOrigin == fixture.application.origin)
        #expect(fixture.savedOrigins.count == writes)
        #expect(fixture.requests.count == requests)
        #expect(fixture.retirements == 0)
        #expect(authorization?.isCurrent() == (cold ? nil : true))
    }

    @Test @MainActor
    func `cleartext replacement retires its capability and media while retaining a sibling grant`() async throws {
        let fixture = try IngressTestHarness()
        var sibling = try #require(fixture.profileRows.first)
        sibling.stableID = "managed-sibling"
        fixture.profileRows.append(sibling)
        fixture.persisted = try String(data: JSONEncoder().encode(fixture.nextSession), encoding: .utf8)
        let ingress = fixture.controller()
        let first = try #require(try await ingress.prepare(
            route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()))
        let siblingRoute = GatewayIngressController.Route(url: fixture.route.url, stableID: sibling.stableID, tls: nil)
        let second = try #require(try await ingress.prepare(
            route: siblingRoute, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()))
        let started = AsyncStream<Void>.makeStream()
        let download = Task { try await first.load(URLRequest(url: fixture.route.url)) { _ in
            started.continuation.yield()
            try await Task.sleep(for: .seconds(300))
            throw URLError(.timedOut)
        } }
        defer { download.cancel() }
        for await _ in started.stream {
            break
        }
        let cleartext = try GatewayIngressController.Route(
            url: #require(URL(string: "ws://gateway.example.test:8443/")),
            stableID: fixture.stableID, tls: nil)
        #expect(try await ingress.prepare(
            route: cleartext, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()) == nil)
        await #expect(throws: CancellationError.self) { try await download.value }
        #expect(!first.isCurrent())
        #expect(second.isCurrent())
        #expect(fixture.profileRows[0].accessOrigin == nil)
        #expect(fixture.profileRows[1].accessOrigin == fixture.application.origin)
        #expect(fixture.persisted != nil)
        #expect(fixture.retirements == 0)
        #expect(fixture.browser.presented.isEmpty)
        #expect(ingress.attention == nil)
    }

    @Test @MainActor
    func `cleartext cleanup preserves a distinct profile signing out from the same origin`() async throws {
        let fixture = try IngressTestHarness()
        var sibling = try #require(fixture.profileRows.first)
        sibling.stableID = "independent-sibling"
        fixture.profileRows.append(sibling)
        fixture.preauthenticatedStableIDs.insert(sibling.stableID)
        fixture.persisted = try String(data: JSONEncoder().encode(fixture.nextSession), encoding: .utf8)
        let retirement = IngressTestGate()
        let ingress = fixture.controller(retirement: { _ in
            if fixture.retirements == 1 {
                await retirement.wait()
            }
        })
        let first = try #require(try await ingress.prepare(
            route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()))
        let siblingRoute = GatewayIngressController.Route(url: fixture.route.url, stableID: sibling.stableID, tls: nil)
        #expect(try await ingress.prepare(
            route: siblingRoute, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()) == nil)
        let media = IngressTestGate()
        let download = Task { try await first.load(URLRequest(url: fixture.route.url)) { _ in
            await media.wait()
            throw CancellationError()
        } }
        defer { media.release()
            retirement.release()
            download.cancel()
        }
        try await waitForIngress { media.started }
        let cleartext = try GatewayIngressController.Route(
            url: #require(URL(string: "ws://gateway.example.test:8443/")),
            stableID: fixture.stableID, tls: nil)
        let pending = Task { try await ingress.prepare(
            route: cleartext, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()) }
        defer { pending.cancel() }
        try await waitForIngress { !first.isCurrent() }
        #expect(!retirement.started)
        // The other profile becomes a durable owner after the first retirement was
        // reserved. Its later origin transition must not veto profile-local cleanup.
        fixture.profileRows[1].accessOrigin = fixture.application.origin
        let checkpoint = ingress.admissionCheckpoint()
        let signedOut = Task { await ingress.signOut(stableID: sibling.stableID) }
        defer { signedOut.cancel() }
        try await waitForIngress { ingress.admissionCheckpoint() > checkpoint }
        media.release()
        try await waitForIngress { retirement.started }
        retirement.release()
        #expect(try await pending.value == nil)
        await signedOut.value
        await #expect(throws: CancellationError.self) { try await download.value }
        #expect(fixture.profileRows[0].accessOrigin == nil)
        #expect(fixture.profileRows[1].accessOrigin == fixture.application.origin)
        #expect(fixture.retirements == 2)
        let attention = try #require(ingress.attention)
        #expect(attention.stableID == sibling.stableID)
        // Reusing the attention also proves that cleanup retained the sibling's route.
        try await ingress.signIn(for: attention, admissionCheckpoint: ingress.admissionCheckpoint())
        #expect(ingress.attention == nil)
        #expect(fixture.profileRows[1].accessOrigin == fixture.application.origin)
        #expect(fixture.browser.presented.isEmpty)
    }

    @Test(arguments: ["forget", "cleartext"]) @MainActor
    func `overlapping departures share the latest explicit retirement outcome`(mode: String) async throws {
        for succeeds in [false, true] {
            let fixture = try IngressTestHarness()
            let storage = IngressOriginStorage()
            try storage.save(fixture.nextSession)
            storage.deletionSucceeds = succeeds
            let retirement = IngressTestGate()
            let ingress = fixture.controller(persistence: storage.persistence, retirement: { _ in
                if fixture.retirements == 1 { await retirement.wait() }
            })
            _ = try await ingress.prepare(
                route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint())
            let cleartext = try GatewayIngressController.Route(
                url: #require(URL(string: "ws://gateway.example.test:8443/")),
                stableID: fixture.stableID, tls: nil)
            func depart() async throws -> GatewayIngressAuthorization? {
                if mode == "forget" {
                    try await ingress.forget(stableID: fixture.stableID)
                    return nil
                }
                return try await ingress.prepare(
                    route: cleartext, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint())
            }
            let first = Task { try await depart() }
            defer { retirement.release()
                first.cancel()
            }
            try await waitForIngress { retirement.started }
            let checkpoint = ingress.admissionCheckpoint()
            let second = Task { try await depart() }
            defer { second.cancel() }
            // R2 is reserved while R1 is held; both callers still own the same
            // saved association. Their passive completion must not reserve R3/R4.
            try await waitForIngress { ingress.admissionCheckpoint() > checkpoint }
            retirement.release()
            if succeeds {
                #expect(try await first.value == nil)
                #expect(try await second.value == nil)
                #expect(fixture.profileRows[0].accessOrigin == nil)
                #expect(storage.values[fixture.application.origin] == nil)
            } else {
                await #expect(throws: CloudflareAccessError.self) { try await first.value }
                await #expect(throws: CloudflareAccessError.self) { try await second.value }
                #expect(fixture.profileRows[0].accessOrigin == fixture.application.origin)
                #expect(storage.values[fixture.application.origin] != nil)
            }
            #expect(fixture.retirements == 2)
            #expect(storage.deleted.count == 2)
            if !succeeds {
                storage.deletionSucceeds = true
                try await ingress.forget(stableID: fixture.stableID)
                #expect(fixture.profileRows[0].accessOrigin == nil)
                #expect(storage.values[fixture.application.origin] == nil)
            }
            #expect(fixture.browser.presented.isEmpty)
            #expect(ingress.attention == nil)
        }
    }

    @Test(arguments: ["forget", "cleartext"]) @MainActor
    func `profile departure blocks renewed grants until its media settles`(mode: String) async throws {
        for outcome in ["leaves", "stays", "delete-fails"] {
            let fixture = try IngressTestHarness()
            var sibling = try #require(fixture.profileRows.first)
            sibling.stableID = "renewing-sibling"
            fixture.profileRows.append(sibling)
            let storage = IngressOriginStorage()
            try storage.save(fixture.nextSession)
            let ingress = fixture.controller(persistence: storage.persistence)
            let first = try #require(try await ingress.prepare(
                route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()))
            let media = IngressTestGate()
            let download = Task { try await first.load(URLRequest(url: fixture.route.url)) { _ in
                await media.wait()
                throw CancellationError()
            } }
            defer { media.release()
                download.cancel()
            }
            try await waitForIngress { media.started }
            let cleartext = try GatewayIngressController.Route(
                url: #require(URL(string: "ws://gateway.example.test:8443/")),
                stableID: fixture.stableID, tls: nil)
            let pending = Task<GatewayIngressAuthorization?, Error> {
                if mode == "forget" {
                    try await ingress.forget(stableID: fixture.stableID)
                    return nil
                }
                return try await ingress.prepare(
                    route: cleartext, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint())
            }
            defer { pending.cancel() }
            try await waitForIngress { !first.isCurrent() }
            // Revocation is immediate, but deletion and another profile's grant
            // publication must wait for the retained old media task to settle.
            #expect(storage.deleted.isEmpty)
            #expect(storage.values[fixture.application.origin] != nil)
            #expect(fixture.profileRows[0].accessOrigin == fixture.application.origin)
            fixture.nextSession = try fixture.tokens.session(subject: "renewed-sibling")
            fixture.release.continuation.finish()
            let probe = AsyncStream<Void>.makeStream()
            fixture.probeGate = probe.stream
            fixture.probeStableID = sibling.stableID
            let renewal = Task {
                let authorization = try await ingress.prepare(
                    route: .init(url: fixture.route.url, stableID: sibling.stableID, tls: nil),
                    userInitiated: true, admissionCheckpoint: ingress.admissionCheckpoint())
                #expect(media.settled)
                return authorization
            }
            defer { probe.continuation.finish()
                renewal.cancel()
            }
            try await waitForIngress { fixture.pendingProbes == 1 }
            #expect(storage.deleted.isEmpty)
            #expect(fixture.browser.presented.isEmpty)
            probe.continuation.finish()
            media.release()
            #expect(try await pending.value == nil)
            await #expect(throws: CancellationError.self) { try await download.value }
            let peer = try #require(try await renewal.value)
            let renewedBytes = try #require(storage.values[fixture.application.origin])
            #expect(fixture.profileRows[0].accessOrigin == nil)
            #expect(fixture.profileRows[1].accessOrigin == fixture.application.origin)
            #expect(peer.isCurrent())
            if outcome == "stays" {
                #expect(storage.values[fixture.application.origin] == renewedBytes)
            } else {
                storage.deletionSucceeds = outcome != "delete-fails"
                if outcome == "delete-fails" {
                    await #expect(throws: CloudflareAccessError.storageFailed) {
                        try await ingress.forget(stableID: sibling.stableID)
                    }
                    #expect(fixture.profileRows[1].accessOrigin == fixture.application.origin)
                    #expect(storage.values[fixture.application.origin] == renewedBytes)
                    storage.deletionSucceeds = true
                }
                try await ingress.forget(stableID: sibling.stableID)
                #expect(fixture.profileRows[1].accessOrigin == nil)
                #expect(storage.values[fixture.application.origin] == nil)
                #expect(!peer.isCurrent())
            }
        }
    }

    @Test @MainActor
    func `repeated replacement admissions join the old registration media drain`() async throws {
        let fixture = try IngressTestHarness()
        let storage = IngressOriginStorage()
        try storage.save(fixture.nextSession)
        let retirement = IngressTestGate()
        let media = IngressTestGate()
        let ingress = fixture.controller(persistence: storage.persistence, retirement: { _ in
            #expect(media.settled)
            if fixture.retirements == 1 { await retirement.wait() }
        })
        let old = try #require(try await ingress.prepare(
            route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()))
        let download = Task { try await old.load(URLRequest(url: fixture.route.url)) { _ in
            await media.wait()
            throw CancellationError()
        } }
        defer { media.release()
            retirement.release()
            download.cancel()
        }
        try await waitForIngress { media.started }
        fixture.preauthenticated = true
        let replacement = try GatewayIngressController.Route(
            url: #require(URL(string: "https://replacement.example.test/")),
            stableID: fixture.stableID, tls: nil)
        let checkpoint = ingress.admissionCheckpoint()
        let first = Task { try await ingress.prepare(
            route: replacement, userInitiated: false, admissionCheckpoint: checkpoint) }
        defer { first.cancel() }
        try await waitForIngress { !old.isCurrent() }
        var secondStarted = false
        let second = Task {
            secondStarted = true
            return try await ingress.prepare(
                route: replacement, userInitiated: false, admissionCheckpoint: checkpoint)
        }
        defer { second.cancel() }
        try await waitForIngress { secondStarted }
        #expect(storage.deleted.isEmpty)
        #expect(fixture.requestRoutes.allSatisfy { $0.url != replacement.url })
        media.release()
        // Hold R1 after the media settles until both same-registration callers
        // captured the old association and reserved their explicit retirements.
        try await waitForIngress { retirement.started && ingress.admissionCheckpoint() >= checkpoint + 2 }
        retirement.release()
        let outcomes = await [first.result, second.result]
        var successes = 0
        var cancellations = 0
        for outcome in outcomes {
            switch outcome {
            case let .success(authorization):
                #expect(authorization == nil)
                successes += 1
            case let .failure(error):
                #expect(error is CancellationError)
                cancellations += 1
            }
        }
        #expect(successes == 1)
        #expect(cancellations == 1)
        await #expect(throws: CancellationError.self) { try await download.value }
        #expect(storage.deleted == [fixture.application.origin, fixture.application.origin])
        #expect(fixture.profileRows[0].accessOrigin == nil)
        #expect(try await ingress.prepare(
            route: replacement, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()) == nil)
        #expect(fixture.browser.presented.isEmpty)
    }

    @Test(arguments: [false, true]) @MainActor
    func `current managed media stays independent of another same route admission`(cancelMedia: Bool) async throws {
        let fixture = try IngressTestHarness()
        fixture.persisted = try String(data: JSONEncoder().encode(fixture.nextSession), encoding: .utf8)
        let ingress = fixture.controller()
        let old = try #require(try await ingress.prepare(
            route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()))
        let media = IngressTestGate()
        let response = try #require(HTTPURLResponse(
            url: fixture.route.url, statusCode: 200, httpVersion: nil, headerFields: nil))
        let download = Task { try await old.load(URLRequest(url: fixture.route.url)) { _ in
            try await withTaskCancellationHandler {
                await media.wait()
                try Task.checkCancellation()
                return (Data([1]), response)
            } onCancel: { Task { @MainActor in media.cancellationObserved = true } }
        } }
        defer { media.release()
            download.cancel()
        }
        try await waitForIngress { media.started }
        if cancelMedia {
            download.cancel()
            try await waitForIngress { media.cancellationObserved }
        }
        var prepared = false
        let admission = Task {
            defer { prepared = true }
            return try await ingress.prepare(
                route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint())
        }
        defer { admission.cancel() }
        try await waitForIngress { prepared }
        let current = try #require(try await admission.value)
        #expect(current.isCurrent())
        #expect(old.isCurrent())
        #expect(!media.settled)
        #expect(media.cancellationObserved == cancelMedia)
        #expect(fixture.retirements == 0)
        media.release()
        if cancelMedia {
            await #expect(throws: CancellationError.self) { try await download.value }
        } else {
            #expect(try await download.value.0 == Data([1]))
        }
    }

    @Test(arguments: ["ordinary", "invalidated-before", "invalidated-during"]) @MainActor
    func `ordinary admission joins media from its retired managed revision`(transition: String) async throws {
        let fixture = try IngressTestHarness()
        fixture.persisted = try String(data: JSONEncoder().encode(fixture.nextSession), encoding: .utf8)
        let ingress = fixture.controller()
        let old = try #require(try await ingress.prepare(
            route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()))
        let media = IngressTestGate()
        let download = Task { try await old.load(URLRequest(url: fixture.route.url)) { _ in
            try await withTaskCancellationHandler {
                await media.wait()
                throw CancellationError()
            } onCancel: { Task { @MainActor in media.cancellationObserved = true } }
        } }
        let probe = AsyncStream<Void>.makeStream()
        defer { media.release()
            probe.continuation.finish()
            download.cancel()
        }
        try await waitForIngress { media.started }
        let challenge = try #require(HTTPURLResponse(
            url: fixture.route.url, statusCode: 302, httpVersion: nil,
            headerFields: [
                "WWW-Authenticate": "Cloudflare-Access resource_metadata=\"\(fixture.route.url.absoluteString)/.well-known/cloudflare-access-protected-resource/\"",
            ]))
        if transition == "invalidated-before" {
            await #expect(throws: GatewayExternalAuthorizationError.self) { try await old.checkResponse(challenge) }
            // The origin-wide drain has canceled the task but must still retain it
            // for the same registration's subsequent ordinary admission to join.
            try await waitForIngress { media.cancellationObserved }
        } else {
            fixture.probeGate = probe.stream
        }
        fixture.preauthenticated = true
        var admissionStarted = false
        var admitted = false
        let admission = Task {
            admissionStarted = true
            let authorization = try await ingress.prepare(
                route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint())
            #expect(media.settled)
            admitted = true
            return authorization
        }
        defer { admission.cancel() }
        if transition == "invalidated-before" {
            try await waitForIngress { admissionStarted }
        } else {
            try await waitForIngress { fixture.pendingProbes == 1 }
            if transition == "invalidated-during" {
                await #expect(throws: GatewayExternalAuthorizationError.self) { try await old.checkResponse(challenge) }
            }
            probe.continuation.finish()
            try await waitForIngress { media.cancellationObserved }
        }
        #expect(!admitted)
        #expect(!old.isCurrent())
        media.release()
        if transition == "invalidated-during" {
            await #expect(throws: CancellationError.self) { try await admission.value }
            #expect(!admitted)
        } else {
            #expect(try await admission.value == nil)
        }
        await #expect(throws: CancellationError.self) { try await download.value }
        #expect(fixture.browser.presented.isEmpty)
    }

    @Test @MainActor
    func `canceled changed origin admission retains the old association before its retirement`() async throws {
        let fixture = try IngressTestHarness()
        let storage = IngressOriginStorage()
        try storage.save(fixture.nextSession)
        let ingress = fixture.controller(persistence: storage.persistence)
        let first = try #require(try await ingress.prepare(
            route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()))
        let media = IngressTestGate()
        let download = Task { try await first.load(URLRequest(url: fixture.route.url)) { _ in
            await media.wait()
            throw CancellationError()
        } }
        defer { media.release()
            download.cancel()
        }
        try await waitForIngress { media.started }
        let replacement = try GatewayIngressController.Route(
            url: #require(URL(string: "https://replacement.example.test/")),
            stableID: fixture.stableID, tls: nil)
        let pending = Task { try await ingress.prepare(
            route: replacement, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()) }
        defer { pending.cancel() }
        try await waitForIngress { !first.isCurrent() }
        pending.cancel()
        media.release()
        await #expect(throws: CancellationError.self) { try await pending.value }
        await #expect(throws: CancellationError.self) { try await download.value }
        #expect(fixture.profileRows[0].accessOrigin == fixture.application.origin)
        #expect(storage.values[fixture.application.origin] != nil)
        #expect(storage.deleted.isEmpty)
        #expect(fixture.browser.presented.isEmpty)
    }

    @Test(arguments: [false, true]) @MainActor
    func `cleartext preparation rejects cancellation and profile replacement during the drain`(
        replaceProfile: Bool) async throws
    {
        let fixture = try IngressTestHarness()
        var sibling = try #require(fixture.profileRows.first)
        sibling.stableID = "retained-sibling"
        fixture.profileRows.append(sibling)
        fixture.persisted = try String(data: JSONEncoder().encode(fixture.nextSession), encoding: .utf8)
        let ingress = fixture.controller()
        let first = try #require(try await ingress.prepare(
            route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()))
        let second = try #require(try await ingress.prepare(
            route: .init(url: fixture.route.url, stableID: sibling.stableID, tls: nil),
            userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()))
        let media = IngressTestGate()
        let download = Task { try await first.load(URLRequest(url: fixture.route.url)) { _ in
            await media.wait()
            throw CancellationError()
        } }
        try await waitForIngress { media.started }
        let cleartext = try GatewayIngressController.Route(
            url: #require(URL(string: "ws://gateway.example.test:8443/")),
            stableID: fixture.stableID, tls: nil)
        let pending = Task { try await ingress.prepare(
            route: cleartext, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()) }
        defer { media.release()
            download.cancel()
            pending.cancel()
        }
        try await waitForIngress { !first.isCurrent() }
        var renewal: Task<GatewayIngressAuthorization?, Error>?
        defer { renewal?.cancel() }
        var replacementStarted = false
        if replaceProfile {
            renewal = Task {
                replacementStarted = true
                let authorization = try await ingress.prepare(
                    route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint())
                #expect(media.settled)
                return authorization
            }
            try await waitForIngress { replacementStarted }
        } else {
            // The caller already entered prepare and is suspended in the media drain.
            pending.cancel()
        }
        let saved = fixture.profileRows[0].accessOrigin
        media.release()
        let renewed = try await renewal?.value
        let writes = fixture.savedOrigins.count
        await #expect(throws: CancellationError.self) { try await pending.value }
        await #expect(throws: CancellationError.self) { try await download.value }
        #expect(second.isCurrent())
        if replaceProfile {
            #expect(renewed?.isCurrent() == true)
            #expect(fixture.savedOrigins.count == writes)
            #expect(fixture.profileRows[0].accessOrigin == saved)
        } else {
            #expect(fixture.profileRows[0].accessOrigin == nil)
        }
        #expect(fixture.browser.presented.isEmpty)
    }

    @Test(arguments: [false, true]) @MainActor
    func `forgotten profile cleanup cannot mutate a replacement after the media drain`(
        replacementFails: Bool) async throws
    {
        let fixture = try IngressTestHarness()
        var sibling = try #require(fixture.profileRows.first)
        sibling.stableID = "retained-sibling"
        fixture.profileRows.append(sibling)
        fixture.persisted = try String(data: JSONEncoder().encode(fixture.nextSession), encoding: .utf8)
        let ingress = fixture.controller()
        let first = try #require(try await ingress.prepare(
            route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()))
        _ = try await ingress.prepare(
            route: .init(url: fixture.route.url, stableID: sibling.stableID, tls: nil),
            userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint())
        let media = IngressTestGate()
        let download = Task { try await first.load(URLRequest(url: fixture.route.url)) { _ in
            await media.wait()
            throw CancellationError()
        } }
        try await waitForIngress { media.started }
        let forgetting = Task { try await ingress.forget(stableID: fixture.stableID) }
        defer { media.release()
            download.cancel()
            forgetting.cancel()
        }
        try await waitForIngress { !first.isCurrent() }
        let replacement = try GatewayIngressController.Route(
            url: replacementFails ? #require(URL(string: "https://replacement.example.test/")) : fixture.route.url,
            stableID: fixture.stableID, tls: nil)
        fixture.probeFailure = replacementFails ? URLError(.cannotConnectToHost) : nil
        var replacementStarted = false
        let renewal = Task {
            replacementStarted = true
            let authorization = try await ingress.prepare(
                route: replacement, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint())
            #expect(media.settled)
            return authorization
        }
        defer { renewal.cancel() }
        try await waitForIngress { replacementStarted }
        media.release()
        var renewed: GatewayIngressAuthorization?
        if replacementFails {
            await #expect(throws: URLError.self) { try await renewal.value }
        } else {
            renewed = try await renewal.value
            #expect(renewed?.isCurrent() == true)
        }
        let writes = fixture.savedOrigins.count
        let saved = fixture.profileRows[0].accessOrigin
        try await forgetting.value
        await #expect(throws: CancellationError.self) { try await download.value }
        #expect(fixture.savedOrigins.count == writes)
        #expect(fixture.profileRows[0].accessOrigin == saved)
        if !replacementFails {
            #expect(renewed?.isCurrent() == true)
        }
    }

    @Test(arguments: [false, true]) @MainActor
    func `expiry attention belongs only to a currently managed profile`(formerlyManaged: Bool) async throws {
        let fixture = try IngressTestHarness()
        var ordinary = try #require(fixture.profileRows.first)
        ordinary.stableID = "a-ordinary-sibling"
        fixture.profileRows.append(ordinary)
        fixture.persisted = try String(data: JSONEncoder().encode(fixture.nextSession), encoding: .utf8)
        let ingress = fixture.controller()
        let ordinaryRoute = GatewayIngressController.Route(
            url: fixture.route.url,
            stableID: ordinary.stableID,
            tls: nil)
        var old: GatewayIngressAuthorization?
        if formerlyManaged {
            old = try await ingress.prepare(
                route: ordinaryRoute, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint())
        }
        fixture.preauthenticatedStableIDs.insert(ordinary.stableID)
        #expect(try await ingress.prepare(
            route: ordinaryRoute, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()) == nil)
        if formerlyManaged {
            #expect(old?.isCurrent() == false)
            // Durable last-owner metadata survives ordinary admission; it is not live grant use.
            #expect(fixture.profileRows[1].accessOrigin == fixture.application.origin)
        }
        let managed = try #require(try await ingress.prepare(
            route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()))
        fixture.now = fixture.nextSession.expiresAt
        ingress.foregrounded()
        #expect(!managed.isCurrent())
        #expect(ingress.attention?.stableID == fixture.stableID)
        let attentionID = ingress.attention?.id
        ingress.foregrounded()
        #expect(ingress.attention?.id == attentionID)
        #expect(fixture.browser.presented.isEmpty)
    }

    @Test @MainActor
    func `a canceled completion cannot clear a newer sign in while browser dismissal drains`() async throws {
        let fixture = try IngressTestHarness()
        let ingress = fixture.controller()
        let dismissal = AsyncStream<Void>.makeStream()
        fixture.browser.dismissalGate = dismissal.stream
        fixture.release.continuation.finish()
        let first = Task { try await ingress.prepare(
            route: fixture.route, userInitiated: true, admissionCheckpoint: ingress.admissionCheckpoint()) }
        defer { dismissal.continuation.finish()
            first.cancel()
        }
        try await waitForIngress { fixture.browser.dismissed.count == 1 }
        ingress.cancelSignIn()
        fixture.revoked = true
        let second = Task { try await ingress.prepare(
            route: fixture.route, userInitiated: true, admissionCheckpoint: ingress.admissionCheckpoint()) }
        defer { second.cancel() }
        try await waitForIngress { fixture.browser.presented.count == 2 }
        #expect(ingress.signingIn)
        dismissal.continuation.finish()
        await #expect(throws: CancellationError.self) { try await first.value }
        let authorization = try #require(try await second.value)
        #expect(authorization.isCurrent())
        #expect(!ingress.signingIn)
        #expect(ingress.attention == nil)
    }

    @Test @MainActor
    func `expiry cannot target a replacement whose ordinary probe is still pending`() async throws {
        let fixture = try IngressTestHarness()
        fixture.persisted = try String(data: JSONEncoder().encode(fixture.nextSession), encoding: .utf8)
        let ingress = fixture.controller()
        let old = try #require(try await ingress.prepare(
            route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()))
        let probe = AsyncStream<Void>.makeStream()
        fixture.probeGate = probe.stream
        fixture.preauthenticated = true
        let replacement = GatewayIngressController.Route(
            url: fixture.route.url.appendingPathComponent("replacement"), stableID: fixture.stableID, tls: nil)
        let pending = Task { try await ingress.prepare(
            route: replacement, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()) }
        defer { probe.continuation.finish()
            pending.cancel()
        }
        try await waitForIngress { fixture.probeStarted }
        fixture.now = fixture.nextSession.expiresAt
        ingress.foregrounded()
        #expect(!old.isCurrent())
        #expect(ingress.attention == nil)
        probe.continuation.finish()
        #expect(try await pending.value == nil)
        #expect(ingress.attention == nil)
    }

    @Test @MainActor
    func `already canceled browser presentation cannot dismiss the current owner`() async throws {
        let url = try #require(URL(string: "https://gateway.example.test/"))
        var presented: [SFSafariViewController] = []
        var dismissed = 0
        let presenter = CloudflareAccessBrowserPresenter(
            present: { presented.append($0) }, dismiss: { _ in dismissed += 1 })
        let currentID = UUID()
        try await presenter.open(url, intentID: currentID) {}
        let canceled = Task { try await presenter.open(url, intentID: UUID()) {} }
        canceled.cancel()
        await #expect(throws: CancellationError.self) { try await canceled.value }
        #expect(presented.count == 1)
        #expect(dismissed == 0)
        await presenter.dismiss(intentID: currentID)
        #expect(dismissed == 1)
    }
}
