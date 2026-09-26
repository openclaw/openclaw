import Foundation
import Network
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import SafariServices
import Testing
@testable import OpenClaw

@MainActor
final class IngressTestBrowser: CloudflareAccessBrowserPresenting {
    var presented: [UUID] = []
    var dismissed: [UUID] = []
    var cancel: (() -> Void)?
    var dismissalGate: AsyncStream<Void>?

    func open(_: URL, intentID: UUID, onCancel: @escaping () -> Void) async throws {
        self.presented.append(intentID)
        self.cancel = onCancel
    }

    func dismiss(intentID: UUID) async {
        self.dismissed.append(intentID)
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
    private(set) var started = false

    func wait() async {
        await withCheckedContinuation { continuation in
            self.continuation = continuation
            self.started = true
        }
    }

    func release() {
        self.continuation?.resume()
        self.continuation = nil
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
    var probeStableID: String?
    var probeGate: AsyncStream<Void>?
    var probeRequiresManagedGrant = false
    var probeStarted = false
    var pendingProbes = 0
    var probeFailure: URLError?
    var preauthenticated = false
    var preauthenticatedStableIDs = Set<String>()
    var revoked = false
    var retirements = 0
    var release = AsyncStream<Void>.makeStream()
    let stableID: String

    init(port: Int = 8443) throws {
        let tokens = try CloudflareAccessTestTokens()
        let application = try CloudflareAccessTestTokens.application(port: port)
        let stableID = "manual|gateway.example.test|\(port)"
        self.tokens = tokens
        self.application = application
        self.stableID = stableID
        self.nextSession = try tokens.session(application: application)
        self.profileRows = [.init(
            stableID: stableID,
            kind: .manual,
            name: "Gateway",
            host: "gateway.example.test",
            port: port,
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
            authenticate: { application, browser in
                try await browser(application.origin.url.appendingPathComponent("cdn-cgi/access/cli"))
                for await _ in self.release.stream {
                    break
                }
                try Task.checkCancellation()
                return self.nextSession
            },
            requestFactory: { route in
                { request, _ in
                    await self.record(route)
                    return try await self.respond(to: request, stableID: route.stableID)
                }
            },
            customHeaders: { _ in ["X-Existing-Ingress": "preserved"] },
            profiles: { useSavedProfiles ? GatewaySettingsStore.loadGatewayRegistry().entries : self.profileRows },
            saveProfileOrigin: { stableID, origin in
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

    func record(_ route: GatewayIngressController.Route) {
        self.requestRoutes.append(route)
    }

    func respond(to request: URLRequest, stableID: String) async throws -> (Data, HTTPURLResponse) {
        self.requests.append(request)
        if let probeFailure {
            throw probeFailure
        }
        let url = try #require(request.url)
        if let gate = probeGate, request.httpMethod != "HEAD", url.host == self.application.origin.url.host,
           !probeRequiresManagedGrant || request.value(forHTTPHeaderField: "Cf-Access-Token") != nil,
           probeStableID == nil || GatewayStableIdentifier.matches(probeStableID, stableID)
        {
            self.probeStarted = true
            self.pendingProbes += 1
            defer { self.pendingProbes -= 1 }
            for await _ in gate {
                break
            }
        }
        var fields: [String: String] = [:]
        var status = 200
        var data = Data()
        if url.host == self.application.issuer.host {
            data = self.tokens.jwks
        } else if request.httpMethod == "HEAD" {
            fields["Cf-Access-Metadata"] = try self.tokens.token([
                "type": "match", "hostname": self.application.origin.url.host!,
                "auth_domain": self.application.issuer.host!, "aud": self.application.audience,
                "iat": Date().timeIntervalSince1970,
            ])
        } else if !self.preauthenticated, !self.preauthenticatedStableIDs.contains(stableID),
                  self.revoked || request.value(forHTTPHeaderField: "Cf-Access-Token") == nil
        {
            status = 302
            fields["WWW-Authenticate"] =
                "Cloudflare-Access resource_metadata=\"\(self.application.origin.url.absoluteString)" +
                "/.well-known/cloudflare-access-protected-resource/\""
        }
        return try (
            data,
            #require(HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: fields)))
    }
}

@MainActor
func waitForIngress(
    _ diagnostic: @autoclosure () -> Comment? = nil,
    sourceLocation: SourceLocation = #_sourceLocation,
    _ condition: () -> Bool) async throws
{
    let deadline = ContinuousClock.now + .seconds(3)
    while !condition() {
        try #require(
            ContinuousClock.now < deadline,
            diagnostic() ?? "Timed out waiting for gateway ingress state",
            sourceLocation: sourceLocation)
        await Task.yield()
    }
}

@Suite(.serialized)
struct GatewayIngressControllerTests {
    @Test @MainActor
    func `real Keychain ingress persistence survives restart and forget preserves Gateway credentials`() async throws {
        let isolation = GatewayRegistryTestIsolation()
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
        let isolation = GatewayRegistryTestIsolation()
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

    @Test(arguments: [false, true]) @MainActor
    func `committed grant remains discoverable when browser dismissal is canceled or superseded`(
        replace: Bool) async throws
    {
        let isolation = GatewayRegistryTestIsolation()
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
        let signOut = Task {
            await ingress.signOut(stableID: fixture.stableID)
        }
        try await waitForIngress {
            ingress.attention?.message.hasPrefix("Signing out of Cloudflare Access") == true
        }
        #expect(storage.values[fixture.application.origin] != nil)
        media.release()
        await signOut.value
        #expect(storage.values[fixture.application.origin] == nil)
        #expect(storage.values[replacementOrigin] == replacementBytes)
        #expect(storage.deleted == [fixture.application.origin])
        #expect(ingress.attention?.origin == fixture.application.origin)
        #expect(try await replacement.value == nil)
        // Once replacement settles, lookup follows P and sees only P's preexisting grant.
        #expect(ingress.hasSession(stableID: fixture.stableID) == replacementHasGrant)
        if case .success = await download.result { Issue.record("Retired media returned a result") }
        #expect(storage.values[replacementOrigin] == replacementBytes)
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
            fixture.profileRows[0].contextPath = "/saved-gateway"
            let restarted = fixture.controller(persistence: storage.persistence)
            #expect(restarted.hasSession(stableID: fixture.stableID))
            await restarted.signOut(stableID: fixture.stableID)
            #expect(restarted.attention?.origin == fixture.application.origin)
            #expect(!restarted.hasSession(stableID: fixture.stableID))
            let coldAttention = try #require(restarted.attention)
            fixture.preauthenticated = false
            let signIn = Task {
                try await restarted.signIn(
                    for: coldAttention,
                    admissionCheckpoint: restarted.admissionCheckpoint())
            }
            defer {
                fixture.release.continuation.finish()
                signIn.cancel()
            }
            try await waitForIngress { fixture.browser.presented.count == 1 }
            let route = try #require(fixture.requestRoutes.last)
            #expect(route.stableID == fixture.stableID)
            #expect(route.url.host == "gateway.example.test")
            #expect(route.url.port == 8443)
            #expect(route.url.path == "/saved-gateway")
            #expect(route.tls?.required == true)
            #expect(route.tls?.allowTOFU == false)
            fixture.release.continuation.yield()
            try await signIn.value
            #expect(restarted.attention == nil)
        } else {
            try await ingress.signIn(for: attention, admissionCheckpoint: ingress.admissionCheckpoint())
            #expect(fixture.profileRows[0].accessOrigin == nil)
            #expect(ingress.attention == nil)
        }
        #expect((storage.values[fixture.application.origin] == nil) == !cold)
        #expect(storage.values[replacementOrigin] == before[replacementOrigin])
        #expect(storage.deleted.allSatisfy { $0 == fixture.application.origin })
        #expect(fixture.browser.presented.count == (cold ? 1 : 0))
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

    @Test @MainActor
    func `Dashboard Access cookie admission tracks owner revision and distinguishes Gateway auth denial`() async throws {
        let fixture = try IngressTestHarness(port: 443)
        fixture.persisted = try String(data: JSONEncoder().encode(fixture.nextSession), encoding: .utf8)
        let ingress = fixture.controller()
        let admitted = try #require(await ingress.prepare(
            route: fixture.route,
            userInitiated: false,
            admissionCheckpoint: ingress.admissionCheckpoint()))
        let pageURL = try #require(URL(string: "https://gateway.example.test/settings"))
        let cookie = try #require(admitted.dashboardCookie(pageURL))
        #expect(cookie.name == "CF_Authorization")
        #expect(admitted.isCurrent())

        let gatewayDenial = try #require(HTTPURLResponse(
            url: pageURL,
            statusCode: 401,
            httpVersion: nil,
            headerFields: ["WWW-Authenticate": "Bearer realm=\"gateway\""]))
        try await admitted.checkResponse(gatewayDenial)
        #expect(admitted.isCurrent())
        #expect(admitted.dashboardCookie(pageURL) != nil)

        await ingress.signOut(stableID: fixture.stableID)
        #expect(!admitted.isCurrent())
        #expect(admitted.dashboardCookie(pageURL) == nil)
    }
}
