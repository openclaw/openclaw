import Foundation
import Testing

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
            authenticate: { _, _ in try await gate.login() }, retireTransports: { _ in })
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

    @Test func `reauthentication revokes completed shared grants before retirement can suspend`() async throws {
        let memory = MemoryStore()
        let application = try CloudflareAccessTestTokens.application()
        let session = try CloudflareAccessTestTokens().session()
        let retirement = AsyncStream<Void>.makeStream()
        let retiring = AsyncStream<Void>.makeStream()
        var holdRetirement = false
        let store = CloudflareAccessSessionStore(
            persistence: memory.persistence,
            authenticate: { _, _ in session },
            retireTransports: { _ in
                if holdRetirement {
                    retiring.continuation.finish()
                    for await _ in retirement.stream {}
                }
            })
        let first = store.signIn(application: application, openBrowser: { _ in })
        let peer = store.signIn(application: application, openBrowser: { _ in })
        var receipt: CloudflareAccessSessionStore.Retirement?
        func drain() async {
            retirement.continuation.finish()
            first.cancel()
            peer.cancel()
            _ = await first.result
            _ = await peer.result
            _ = await receipt?.task.result
        }
        do {
            let admitted = try await first.value
            holdRetirement = true
            receipt = try #require(store.beginReauthentication(
                for: application.origin, revision: admitted.revision))
            // No await separates revocation from these admission checks.
            #expect(store.snapshot(for: application.origin) == nil)
            #expect(store.currentRevision(for: application.origin) == 0)
            #expect(store.state(for: application.origin) == .reauthenticationRequired)
            #expect(store.beginReauthentication(for: application.origin, revision: admitted.revision) == nil)
            #expect(memory.values[application.origin] != nil)

            let stale = try await peer.value
            #expect(stale.revision == admitted.revision)
            #expect(store.snapshot(for: application.origin) == nil)
            for await _ in retiring.stream {}
            #expect(memory.values[application.origin] != nil)
            retirement.continuation.finish()
            try await receipt?.task.value
            #expect(memory.values[application.origin] == nil)
            #expect(store.state(for: application.origin) == .reauthenticationRequired)
        } catch {
            await drain()
            throw error
        }
        await drain()
    }

    @Test func `restart loads only a valid session for its exact authority`() throws {
        let memory = MemoryStore()
        let session = try CloudflareAccessTestTokens().session()
        memory.values[session.origin] = try String(data: JSONEncoder().encode(session), encoding: .utf8)
        let store = CloudflareAccessSessionStore(
            persistence: memory.persistence,
            authenticate: { _, _ in throw CloudflareAccessError.loginFailed }, retireTransports: { _ in })
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

    @Test func `retirement acknowledgement survives its completion and unrelated origin transitions`() async throws {
        let memory = MemoryStore()
        let application = try CloudflareAccessTestTokens.application()
        let session = try CloudflareAccessTestTokens().session()
        let other = try CloudflareAccessOrigin(#require(URL(string: "https://other.example.test")))
        let store = CloudflareAccessSessionStore(
            persistence: memory.persistence, authenticate: { _, _ in session }, retireTransports: { _ in })
        let first = store.forget(application.origin)
        #expect(store.isCurrent(first))
        try await first.task.value
        try await store.waitForRetirement(of: application.origin)
        #expect(store.snapshot(for: application.origin) == nil)
        #expect(store.isCurrent(first))
        try await store.forget(other).task.value
        #expect(store.isCurrent(first))

        let second = store.forget(application.origin)
        #expect(!store.isCurrent(first))
        try await second.task.value
        #expect(store.isCurrent(second))
        let renewed = try await store.signIn(application: application, openBrowser: { _ in }).value
        #expect(!store.isCurrent(second))
        #expect(store.snapshot(for: application.origin)?.revision == renewed.revision)
        let final = store.forget(application.origin)
        try await final.task.value
        #expect(store.isCurrent(final))
        #expect(memory.values[application.origin] == nil)
    }

    @Test(arguments: [false, true])
    func `passive cleanup retains the current successful or failed receipt until a session transition`(
        succeeds: Bool) async throws
    {
        let memory = MemoryStore()
        memory.canDelete = succeeds
        let application = try CloudflareAccessTestTokens.application()
        let session = try CloudflareAccessTestTokens().session()
        let other = try CloudflareAccessOrigin(#require(URL(string: "https://other.example.test")))
        let store = CloudflareAccessSessionStore(
            persistence: memory.persistence, authenticate: { _, _ in session }, retireTransports: { _ in })
        let first = store.forget(application.origin)
        if succeeds {
            try await first.task.value
        } else {
            await #expect(throws: CloudflareAccessError.self) { try await first.task.value }
        }
        let shared = store.reconcileForget(application.origin)
        #expect(shared.id == first.id)
        if succeeds {
            try await shared.task.value
        } else {
            await #expect(throws: CloudflareAccessError.self) { try await shared.task.value }
        }
        #expect(memory.events == ["delete"])
        memory.canDelete = true
        try await store.forget(other).task.value
        #expect(store.reconcileForget(application.origin).id == first.id)
        let explicit = store.forget(application.origin)
        #expect(explicit.id != first.id)
        try await explicit.task.value
        #expect(store.reconcileForget(application.origin).id == explicit.id)
        _ = try await store.signIn(application: application, openBrowser: { _ in }).value
        let afterRenewal = store.reconcileForget(application.origin)
        #expect(afterRenewal.id != explicit.id)
        #expect(memory.values[application.origin] != nil)
        try await afterRenewal.task.value
        #expect(memory.values[application.origin] == nil)
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
}
