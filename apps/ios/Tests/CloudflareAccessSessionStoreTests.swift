import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@MainActor
struct CloudflareAccessSessionStoreTests {
    private final class MemoryStore {
        var values: [CloudflareAccessOrigin: String] = [:]
        var events: [String] = []
        var canSave = true
        var canDelete = true

        var persistence: CloudflareAccessSessionStore.Persistence {
            .init(
                load: { self.values[$0] },
                save: {
                    self.events.append("save")
                    guard self.canSave else { return false }
                    self.values[$0] = $1
                    return true
                },
                delete: {
                    self.events.append("delete")
                    guard self.canDelete else { return false }
                    self.values.removeValue(forKey: $0)
                    return true
                })
        }
    }

    @MainActor
    private final class LoginGate {
        var count = 0
        var continuation: CheckedContinuation<CloudflareAccessSession, Error>?
        var started: CheckedContinuation<Void, Never>?

        func login() async throws -> CloudflareAccessSession {
            self.count += 1
            return try await withCheckedThrowingContinuation { continuation in
                self.continuation = continuation
                self.started?.resume()
                self.started = nil
            }
        }

        func waitUntilStarted() async {
            if self.continuation != nil { return }
            await withCheckedContinuation { self.started = $0 }
        }

        func complete(_ session: CloudflareAccessSession) {
            self.continuation?.resume(returning: session)
            self.continuation = nil
        }
    }

    @Test func `concurrent roles share one browser attempt and commit after retirement`() async throws {
        let memory = MemoryStore()
        let gate = LoginGate()
        let application = try CloudflareAccessTestTokens.application()
        let session = try CloudflareAccessTestTokens().session()
        let store = CloudflareAccessSessionStore(
            persistence: memory.persistence,
            authenticate: { _, _ in try await gate.login() },
            retireTransports: { _ in memory.events.append("retire") })
        let node = store.signIn(application: application, openBrowser: { _ in })
        let `operator` = store.signIn(application: application, openBrowser: { _ in })
        await gate.waitUntilStarted()
        #expect(gate.count == 1)
        #expect(store.state(for: application.origin) == .signingIn)
        gate.complete(session)
        let nodeSnapshot = try await node.value
        let operatorSnapshot = try await `operator`.value
        #expect(nodeSnapshot.revision == operatorSnapshot.revision)
        #expect(memory.events == ["retire", "delete", "save"])
        #expect(store.snapshot(for: application.origin)?.session.subject == session.subject)
    }

    @Test(arguments: [false, true])
    func `different applications on one origin replace the browser attempt`(differentIssuer: Bool) async throws {
        let memory = MemoryStore()
        let firstGate = LoginGate()
        let secondGate = LoginGate()
        let tokens = try CloudflareAccessTestTokens()
        let firstApplication = try CloudflareAccessTestTokens.application()
        let firstSession = try tokens.session()
        let secondApplication = try CloudflareAccessApplication(
            origin: firstApplication.origin,
            issuer: differentIssuer
                ? #require(URL(string: "https://other.cloudflareaccess.com")) : firstApplication.issuer,
            audience: differentIssuer ? firstApplication.audience : "other-audience")
        let expires = Date().addingTimeInterval(3600)
        let token = try tokens.token([
            "iss": secondApplication.issuer.absoluteString, "aud": [secondApplication.audience],
            "type": "app", "sub": "replacement-subject", "exp": expires.timeIntervalSince1970,
        ])
        let secondSession = CloudflareAccessSession(
            application: secondApplication, subject: "replacement-subject", token: token, expiresAt: expires)
        let store = CloudflareAccessSessionStore(
            persistence: memory.persistence,
            authenticate: { application, _ in
                if application == firstApplication { return try await firstGate.login() }
                #expect(application == secondApplication)
                return try await secondGate.login()
            },
            retireTransports: { _ in memory.events.append("retire") })
        let first = store.signIn(application: firstApplication, openBrowser: { _ in })
        defer {
            first.cancel()
            firstGate.complete(firstSession)
            secondGate.complete(secondSession)
        }
        await firstGate.waitUntilStarted()
        let second = store.signIn(application: secondApplication, openBrowser: { _ in })
        defer { second.cancel() }
        try #require(first.isCancelled)
        await secondGate.waitUntilStarted()
        #expect(firstGate.count == 1)
        #expect(secondGate.count == 1)
        secondGate.complete(secondSession)
        let snapshot = try await second.value
        #expect(snapshot.session.issuer == secondApplication.issuer)
        #expect(snapshot.session.audience == secondApplication.audience)
        #expect(snapshot.session.subject == secondSession.subject)

        // The canceled authentication deliberately returns after its replacement
        // commits. Its late completion must not persist or retire that grant.
        firstGate.complete(firstSession)
        await #expect(throws: CancellationError.self) { try await first.value }
        #expect(store.snapshot(for: secondApplication.origin)?.revision == snapshot.revision)
        #expect(store.state(for: secondApplication.origin) == .authenticated)
        #expect(memory.events == ["retire", "delete", "save"])
        let encoded = try #require(memory.values[secondApplication.origin]?.data(using: .utf8))
        let persisted = try JSONDecoder().decode(CloudflareAccessSession.self, from: encoded)
        #expect(persisted.issuer == secondApplication.issuer)
        #expect(persisted.audience == secondApplication.audience)
        #expect(persisted.subject == secondSession.subject)
    }

    @Test func `forget rejects late login completion and removes only ingress state`() async throws {
        let memory = MemoryStore()
        let gate = LoginGate()
        let application = try CloudflareAccessTestTokens.application()
        let session = try CloudflareAccessTestTokens().session()
        let store = CloudflareAccessSessionStore(
            persistence: memory.persistence,
            authenticate: { _, _ in try await gate.login() },
            retireTransports: { _ in memory.events.append("retire") })
        let attempt = store.signIn(application: application, openBrowser: { _ in })
        await gate.waitUntilStarted()
        try await store.forget(application.origin).task.value
        gate.complete(session)
        await #expect(throws: CancellationError.self) { try await attempt.value }
        #expect(memory.values.isEmpty)
        #expect(store.snapshot(for: application.origin) == nil)
        #expect(store.state(for: application.origin) == .signedOut)
        #expect(memory.events == ["retire", "delete"])
    }

    @Test func `cancellation is visible and cannot save a completed stale poll`() async throws {
        let memory = MemoryStore()
        let gate = LoginGate()
        let application = try CloudflareAccessTestTokens.application()
        let session = try CloudflareAccessTestTokens().session()
        let store = CloudflareAccessSessionStore(
            persistence: memory.persistence,
            authenticate: { _, _ in try await gate.login() },
            retireTransports: { _ in })
        let attempt = store.signIn(application: application, openBrowser: { _ in })
        await gate.waitUntilStarted()
        store.cancelSignIn(for: application.origin)
        gate.complete(session)
        await #expect(throws: CancellationError.self) { try await attempt.value }
        #expect(memory.values.isEmpty)
        #expect(store.state(for: application.origin) == .reauthenticationRequired)
    }

    @Test func `old socket failures cannot revoke the renewed account session`() async throws {
        let memory = MemoryStore()
        let tokens = try CloudflareAccessTestTokens()
        let application = try CloudflareAccessTestTokens.application()
        var next = try tokens.session()
        let store = CloudflareAccessSessionStore(
            persistence: memory.persistence, authenticate: { _, _ in next }, retireTransports: { _ in })
        let old = try await store.signIn(application: application, openBrowser: { _ in }).value
        next = try tokens.session(subject: "another-subject")
        let renewed = try await store.signIn(application: application, openBrowser: { _ in }).value
        try await store.requireReauthentication(for: application.origin, revision: old.revision)
        #expect(store.snapshot(for: application.origin)?.revision == renewed.revision)
        #expect(store.snapshot(for: application.origin)?.session.subject == "another-subject")
        try await store.requireReauthentication(for: application.origin, revision: renewed.revision)
        #expect(store.snapshot(for: application.origin) == nil)
        #expect(store.state(for: application.origin) == .reauthenticationRequired)
        #expect(memory.values.isEmpty)
    }

    @Test func `dashboard cookie is a current host-scoped HTTP-only Access app grant`() throws {
        let tokens = try CloudflareAccessTestTokens()
        let application = try CloudflareAccessTestTokens.application(port: 443)
        let now = Date()
        let expiry = Date(timeIntervalSince1970: floor(now.timeIntervalSince1970) + 3600)
        let session = try tokens.session(expires: expiry, application: application)
        let dashboardURL = try #require(URL(string: "https://gateway.example.test/settings"))
        let cookie = try #require(session.dashboardCookie(
            for: dashboardURL,
            now: expiry.addingTimeInterval(-1)))

        #expect(cookie.name == "CF_Authorization")
        #expect(cookie.domain == "gateway.example.test")
        #expect(cookie.path == "/")
        #expect(cookie.isSecure)
        #expect(cookie.isHTTPOnly)
        #expect(cookie.expiresDate.map { $0 <= expiry && $0 > expiry.addingTimeInterval(-1) } == true)
        #expect(try session.dashboardCookie(
            for: #require(URL(string: "https://other.example.test/settings")),
            now: expiry.addingTimeInterval(-1)) == nil)
        #expect(try session.dashboardCookie(
            for: #require(URL(string: "https://gateway.example.test:8443/settings")),
            now: expiry.addingTimeInterval(-1)) == nil)
        #expect(session.dashboardCookie(for: dashboardURL, now: expiry) == nil)

        let nonstandard = try CloudflareAccessTestTokens.application(port: 8443)
        let nonstandardSession = try tokens.session(expires: expiry, application: nonstandard)
        let nonstandardURL = try #require(URL(string: "https://gateway.example.test:8443/settings"))
        let nonstandardCookie = try #require(nonstandardSession.dashboardCookie(
            for: nonstandardURL,
            now: expiry.addingTimeInterval(-1)))
        #expect(nonstandardCookie.domain == "gateway.example.test")
        #expect(nonstandardCookie.isSecure)
        #expect(nonstandardCookie.isHTTPOnly)
        #expect(try nonstandardSession.dashboardCookie(
            for: #require(URL(string: "https://gateway.example.test:8443/settings")),
            now: expiry.addingTimeInterval(-1))?.value == nonstandardCookie.value)
        #expect(try nonstandardSession.dashboardCookie(
            for: #require(URL(string: "https://gateway.example.test:9443/settings")),
            now: expiry.addingTimeInterval(-1)) == nil)
    }

    @Test func `restart loads only a valid session for its exact authority`() throws {
        let memory = MemoryStore()
        let session = try CloudflareAccessTestTokens().session()
        memory.values[session.origin] = try String(data: JSONEncoder().encode(session), encoding: .utf8)
        let store = CloudflareAccessSessionStore(
            persistence: memory.persistence,
            authenticate: { _, _ in throw CloudflareAccessError.loginFailed },
            retireTransports: { _ in })
        #expect(store.snapshot(for: session.origin)?.session.subject == session.subject)
        let other = try CloudflareAccessOrigin(#require(URL(string: "https://gateway.example.test")))
        #expect(store.snapshot(for: other) == nil)
        #expect(store.snapshot(for: session.origin, now: session.expiresAt) == nil)
        #expect(store.state(for: session.origin) == .reauthenticationRequired)
    }

    @Test func `failed secure storage never publishes a usable session`() async throws {
        let memory = MemoryStore()
        memory.canSave = false
        let application = try CloudflareAccessTestTokens.application()
        let session = try CloudflareAccessTestTokens().session()
        let store = CloudflareAccessSessionStore(
            persistence: memory.persistence, authenticate: { _, _ in session }, retireTransports: { _ in })
        await #expect(throws: CloudflareAccessError.self) {
            try await store.signIn(application: application, openBrowser: { _ in }).value
        }
        #expect(store.snapshot(for: application.origin) == nil)
        #expect(store.state(for: application.origin) == .reauthenticationRequired)
    }

    @Test func `explicit revocation is synchronous origin scoped and survives a renewed grant`() async throws {
        let memory = MemoryStore()
        let application = try CloudflareAccessTestTokens.application()
        let session = try CloudflareAccessTestTokens().session()
        let other = try CloudflareAccessOrigin(#require(URL(string: "https://other.example.test")))
        let store = CloudflareAccessSessionStore(
            persistence: memory.persistence,
            authenticate: { _, _ in session }, retireTransports: { _ in })
        let original = store.admissionCheckpoint()
        let retirement = store.forget(application.origin)
        #expect(!store.admits(original, for: application.origin))
        #expect(store.admits(original, for: other))
        let retry = store.admissionCheckpoint()
        try await retirement.task.value
        _ = try await store.signIn(application: application, openBrowser: { _ in }).value
        #expect(!store.admits(original, for: application.origin))
        #expect(store.admits(retry, for: application.origin))
        #expect(store.snapshot(for: application.origin) != nil)
    }

    @Test func `failed deletion retires admission and reports failure without rewriting saved credentials`() async throws {
        let memory = MemoryStore()
        let session = try CloudflareAccessTestTokens().session()
        let encoded = try #require(String(data: JSONEncoder().encode(session), encoding: .utf8))
        memory.values[session.origin] = encoded
        memory.canDelete = false
        let store = CloudflareAccessSessionStore(
            persistence: memory.persistence,
            retireTransports: { _ in memory.events.append("retire") })
        #expect(store.snapshot(for: session.origin) != nil)
        let checkpoint = store.admissionCheckpoint()
        let retirement = store.forget(session.origin)
        #expect(!store.admits(checkpoint, for: session.origin))
        await #expect(throws: CloudflareAccessError.self) { try await retirement.task.value }
        #expect(!store.admits(checkpoint, for: session.origin))
        #expect(store.snapshot(for: session.origin) == nil)
        #expect(store.state(for: session.origin) == .signedOut)
        #expect(memory.values[session.origin] == encoded)
        #expect(memory.events == ["retire", "delete"])
    }

    @Test func `expiry while teardown is suspended cannot publish or persist authentication`() async throws {
        let memory = MemoryStore()
        let retirement = LoginGate()
        let application = try CloudflareAccessTestTokens.application()
        let session = try CloudflareAccessTestTokens().session()
        var now = session.expiresAt.addingTimeInterval(-1)
        let store = CloudflareAccessSessionStore(
            persistence: memory.persistence,
            authenticate: { _, _ in session },
            now: { now },
            retireTransports: { _ in _ = try? await retirement.login() })
        let attempt = store.signIn(application: application, openBrowser: { _ in })
        await retirement.waitUntilStarted()
        now = session.expiresAt
        retirement.complete(session)
        await #expect(throws: CloudflareAccessError.self) { try await attempt.value }
        #expect(memory.values.isEmpty)
        #expect(!memory.events.contains("save"))
        #expect(store.state(for: application.origin) == .reauthenticationRequired)
        #expect(store.snapshot(for: application.origin) == nil)
    }

    @Test func `default Keychain restores new owners and awaits isolated deletion`() async throws {
        let seed = try CloudflareAccessTestTokens().session()
        guard let token = seed.authorizationHeader(for: seed.origin.url) else {
            throw CloudflareAccessError.invalidSession
        }
        let identifier = UUID().uuidString.lowercased()
        let firstOrigin = try CloudflareAccessOrigin(#require(URL(string: "https://first-\(identifier).example.test")))
        let secondOrigin =
            try CloudflareAccessOrigin(#require(URL(string: "https://second-\(identifier).example.test")))
        let firstApplication = try CloudflareAccessApplication(
            origin: firstOrigin, issuer: seed.issuer, audience: seed.audience)
        let secondApplication = try CloudflareAccessApplication(
            origin: secondOrigin, issuer: seed.issuer, audience: seed.audience)
        let firstSession = CloudflareAccessSession(
            application: firstApplication, subject: seed.subject, token: token, expiresAt: seed.expiresAt)
        let secondSession = CloudflareAccessSession(
            application: secondApplication, subject: seed.subject, token: token, expiresAt: seed.expiresAt)
        let service = "\(Bundle.main.bundleIdentifier ?? "ai.openclaw.ios").cloudflare-access"
        let controlService = "openclaw.tests.cloudflare-access.\(identifier)"
        let firstAccount = firstOrigin.url.absoluteString
        let secondAccount = secondOrigin.url.absoluteString
        let ownedRows = [(service, firstAccount), (service, secondAccount), (controlService, firstAccount)]
        for (rowService, account) in ownedRows {
            let absent = GenericPasswordKeychainStore.loadString(service: rowService, account: account) == nil
            try #require(absent)
        }
        defer {
            // Only these unique rows belong to this test. No service-wide cleanup.
            for (rowService, account) in ownedRows {
                _ = GenericPasswordKeychainStore.delete(service: rowService, account: account)
                let absent = GenericPasswordKeychainStore.loadString(service: rowService, account: account) == nil
                #expect(absent)
            }
        }
        try GenericPasswordKeychainStore.saveStringResult(
            "sentinel", service: controlService, account: firstAccount).get()
        let writer = CloudflareAccessSessionStore(
            authenticate: { application, _ in
                switch application {
                case firstApplication: firstSession
                case secondApplication: secondSession
                default: throw CloudflareAccessError.loginFailed
                }
            },
            retireTransports: { _ in })
        _ = try await writer.signIn(application: firstApplication, openBrowser: { _ in }).value
        _ = try await writer.signIn(application: secondApplication, openBrowser: { _ in }).value
        let firstSaved = GenericPasswordKeychainStore.loadString(service: service, account: firstAccount) != nil
        let secondSaved = GenericPasswordKeychainStore.loadString(service: service, account: secondAccount) != nil
        #expect(firstSaved)
        #expect(secondSaved)

        let retirement = LoginGate()
        let reader = CloudflareAccessSessionStore(
            authenticate: { _, _ in throw CloudflareAccessError.loginFailed },
            retireTransports: { origin in
                #expect(origin == firstOrigin)
                _ = try? await retirement.login()
            })
        let firstRestored = reader.snapshot(for: firstOrigin)
        let secondRestored = reader.snapshot(for: secondOrigin)
        let firstMatches = firstRestored?.session.origin == firstOrigin &&
            firstRestored?.session.subject == seed.subject &&
            firstRestored?.session.authorizationHeader(for: firstOrigin.url) == token
        let secondMatches = secondRestored?.session.origin == secondOrigin &&
            secondRestored?.session.subject == seed.subject &&
            secondRestored?.session.authorizationHeader(for: secondOrigin.url) == token
        #expect(firstMatches)
        #expect(secondMatches)

        var forgetReturned = false
        let forget = Task { @MainActor in
            try await reader.forget(firstOrigin).task.value
            forgetReturned = true
        }
        do {
            await retirement.waitUntilStarted()
            #expect(!forgetReturned)
            let firstStillStored = GenericPasswordKeychainStore
                .loadString(service: service, account: firstAccount) != nil
            let secondStillStored = GenericPasswordKeychainStore
                .loadString(service: service, account: secondAccount) != nil
            let controlStillStored = GenericPasswordKeychainStore.loadString(
                service: controlService, account: firstAccount) == "sentinel"
            #expect(firstStillStored)
            #expect(secondStillStored)
            #expect(controlStillStored)
            retirement.complete(seed)
            try await forget.value
        } catch {
            // Join the owned retirement before deferred native-row cleanup, even on failure.
            retirement.complete(seed)
            forget.cancel()
            _ = await forget.result
            throw error
        }
        #expect(forgetReturned)
        #expect(reader.state(for: firstOrigin) == .signedOut)
        let firstDeleted = GenericPasswordKeychainStore.loadString(service: service, account: firstAccount) == nil
        #expect(firstDeleted)
        let restarted = CloudflareAccessSessionStore(
            authenticate: { _, _ in throw CloudflareAccessError.loginFailed }, retireTransports: { _ in })
        let firstRemainsAbsent = restarted.snapshot(for: firstOrigin) == nil
        let surviving = restarted.snapshot(for: secondOrigin)
        let secondSurvives = surviving?.session.origin == secondOrigin &&
            surviving?.session.subject == seed.subject &&
            surviving?.session.authorizationHeader(for: secondOrigin.url) == token
        let controlSurvives = GenericPasswordKeychainStore.loadString(
            service: controlService, account: firstAccount) == "sentinel"
        #expect(firstRemainsAbsent)
        #expect(secondSurvives)
        #expect(controlSurvives)
    }
}
