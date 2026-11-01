import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@MainActor
struct CloudflareAccessSessionStoreTests {
    private final class MemoryStore {
        var values: [CloudflareAccessOrigin: String] = [:]
        var events: [String] = []
        var canLoad = true
        var canSave = true
        var canDelete = true

        var persistence: CloudflareAccessSessionStore.Persistence {
            .init(
                load: {
                    guard self.canLoad else { throw CloudflareAccessError.storageFailed }
                    return self.values[$0]
                },
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
        struct Saved: Decodable { let session: CloudflareAccessSession }
        let persisted = try JSONDecoder().decode(Saved.self, from: encoded).session
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
        next = try tokens.session()
        let renewed = try await store.signIn(application: application, openBrowser: { _ in }).value
        try await store.requireReauthentication(for: application.origin, revision: old.revision)
        #expect(store.snapshot(for: application.origin)?.revision == renewed.revision)
        #expect(store.snapshot(for: application.origin)?.session.subject == "test-subject")
        try await store.requireReauthentication(for: application.origin, revision: renewed.revision)
        #expect(store.snapshot(for: application.origin) == nil)
        #expect(store.state(for: application.origin) == .reauthenticationRequired)
        #expect(memory.values[application.origin] != nil)
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
            #expect(memory.values[application.origin] != nil)
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

    @Test(arguments: [false, true], [false, true])
    func `distinct origins keep A and B through expiry restart renewal and explicit logout`(
        legacy: Bool, loadBeforeExpiry: Bool) async throws
    {
        let memory = MemoryStore()
        let tokens = try CloudflareAccessTestTokens()
        let a = try CloudflareAccessTestTokens.application()
        let b = try CloudflareAccessApplication(
            origin: CloudflareAccessOrigin(#require(URL(string: "https://other.example.test"))),
            issuer: a.issuer, audience: a.audience)
        let expiry = Date(timeIntervalSince1970: 2_000_000_000)
        var now = expiry.addingTimeInterval(-60)
        func session(_ app: CloudflareAccessApplication, _ subject: String, expires: Date) throws
            -> CloudflareAccessSession
        {
            let token = try tokens.token([
                "iss": app.issuer.absoluteString, "aud": [app.audience],
                "type": "app", "sub": subject, "exp": expires.timeIntervalSince1970,
            ])
            return CloudflareAccessSession(application: app, subject: subject, token: token, expiresAt: expires)
        }
        var next = try session(a, "A", expires: expiry)
        func owner() -> CloudflareAccessSessionStore {
            CloudflareAccessSessionStore(
                persistence: memory.persistence, authenticate: { _, _ in next },
                now: { now }, retireTransports: { _ in })
        }
        let initial = owner()
        _ = try await initial.signIn(application: a, openBrowser: { _ in }).value
        if legacy {
            memory.values[a.origin] = try String(data: JSONEncoder().encode(next), encoding: .utf8)
        }
        next = try session(b, "B", expires: expiry.addingTimeInterval(3600))
        _ = try await initial.signIn(application: b, openBrowser: { _ in }).value
        // Reconstruct before A is read: restoration must retain an already expired account.
        let restarted = owner()
        if loadBeforeExpiry {
            #expect(restarted.snapshot(for: a.origin)?.session.subject == "A")
        }
        now = expiry
        #expect(restarted.snapshot(for: a.origin) == nil)
        try await restarted.waitForRetirement(of: a.origin)
        #expect(restarted.snapshot(for: b.origin)?.session.subject == "B")
        next = try session(a, "B", expires: expiry.addingTimeInterval(3600))
        await #expect(throws: CloudflareAccessError.accountMismatch) {
            try await restarted.signIn(application: a, openBrowser: { _ in }).value
        }
        let otherIssuer = try CloudflareAccessApplication(
            origin: a.origin, issuer: #require(URL(string: "https://other.cloudflareaccess.com")), audience: a.audience)
        next = try session(otherIssuer, "A", expires: expiry.addingTimeInterval(3600))
        await #expect(throws: CloudflareAccessError.accountMismatch) {
            try await restarted.signIn(application: otherIssuer, openBrowser: { _ in }).value
        }
        next = try session(a, "A", expires: expiry.addingTimeInterval(3600))
        let renewed = try await restarted.signIn(application: a, openBrowser: { _ in }).value
        try await restarted.requireReauthentication(for: a.origin, revision: renewed.revision)
        let afterRevocation = owner()
        next = try session(a, "B", expires: expiry.addingTimeInterval(3600))
        await #expect(throws: CloudflareAccessError.accountMismatch) {
            try await afterRevocation.signIn(application: a, openBrowser: { _ in }).value
        }
        #expect(afterRevocation.snapshot(for: b.origin)?.session.subject == "B")
        try await afterRevocation.forget(a.origin).task.value
        let afterLogout = owner()
        _ = try await afterLogout.signIn(application: a, openBrowser: { _ in }).value
        let final = owner()
        #expect(final.snapshot(for: a.origin)?.session.subject == "B")
        #expect(final.snapshot(for: b.origin)?.session.subject == "B")
    }

    @Test func `read save and delete failures cannot release the expected principal`() async throws {
        let memory = MemoryStore()
        let tokens = try CloudflareAccessTestTokens()
        let app = try CloudflareAccessTestTokens.application()
        var next = try tokens.session(subject: "A")
        func owner() -> CloudflareAccessSessionStore {
            CloudflareAccessSessionStore(
                persistence: memory.persistence, authenticate: { _, _ in next }, retireTransports: { _ in })
        }
        let initial = owner()
        let original = try await initial.signIn(application: app, openBrowser: { _ in }).value
        memory.canSave = false
        await #expect(throws: CloudflareAccessError.storageFailed) {
            try await initial.requireReauthentication(for: app.origin, revision: original.revision)
        }
        next = try tokens.session(subject: "B")
        let restarted = owner()
        memory.canLoad = false
        await #expect(throws: CloudflareAccessError.storageFailed) {
            try await restarted.signIn(application: app, openBrowser: { _ in }).value
        }
        memory.canLoad = true
        memory.canSave = true
        await #expect(throws: CloudflareAccessError.accountMismatch) {
            try await restarted.signIn(application: app, openBrowser: { _ in }).value
        }
        memory.canDelete = false
        await #expect(throws: CloudflareAccessError.storageFailed) {
            try await restarted.forget(app.origin).task.value
        }
        await #expect(throws: CloudflareAccessError.accountMismatch) {
            try await restarted.signIn(application: app, openBrowser: { _ in }).value
        }
        #expect(owner().snapshot(for: app.origin)?.session.subject == "A")
    }

    @Test(arguments: [false, true])
    func `cold forget cannot restore credentials while secure deletion is pending or failed`(
        succeeds: Bool) async throws
    {
        let memory = MemoryStore()
        let a = try CloudflareAccessTestTokens().session(subject: "A")
        memory.values[a.origin] = try String(data: JSONEncoder().encode(a), encoding: .utf8)
        memory.canDelete = succeeds
        let gate = LoginGate()
        let owner = CloudflareAccessSessionStore(
            persistence: memory.persistence, retireTransports: { _ in _ = try? await gate.login() })
        let retirement = owner.forget(a.origin)
        #expect(owner.snapshot(for: a.origin) == nil)
        await gate.waitUntilStarted()
        #expect(owner.snapshot(for: a.origin) == nil)
        gate.complete(a)
        if succeeds { try await retirement.task.value }
        else { await #expect(throws: CloudflareAccessError.storageFailed) { try await retirement.task.value } }
        #expect(owner.snapshot(for: a.origin) == nil)
        #expect((memory.values[a.origin] == nil) == succeeds)
    }

    @Test(arguments: [false, true])
    func `failed cold forget cannot readmit its saved grant on a failed sign in`(cancel: Bool) async throws {
        let memory = MemoryStore()
        let tokens = try CloudflareAccessTestTokens()
        let application = try CloudflareAccessTestTokens.application()
        let original = try tokens.session(subject: "A")
        memory.values[application.origin] = try String(data: JSONEncoder().encode(original), encoding: .utf8)
        memory.canDelete = false
        var failAuthentication = true
        var next = try tokens.session(subject: "B")
        let owner = CloudflareAccessSessionStore(
            persistence: memory.persistence,
            authenticate: { _, _ in
                if failAuthentication {
                    if cancel { throw CancellationError() }
                    throw CloudflareAccessError.loginFailed
                }
                return next
            },
            retireTransports: { _ in })
        await #expect(throws: CloudflareAccessError.storageFailed) {
            try await owner.forget(application.origin).task.value
        }
        #expect(owner.snapshot(for: application.origin) == nil)
        let failed = owner.signIn(application: application, openBrowser: { _ in })
        if cancel { await #expect(throws: CancellationError.self) { try await failed.value } }
        else { await #expect(throws: CloudflareAccessError.loginFailed) { try await failed.value } }
        #expect(owner.snapshot(for: application.origin) == nil)
        #expect(owner.currentRevision(for: application.origin) == 0)

        failAuthentication = false
        await #expect(throws: CloudflareAccessError.accountMismatch) {
            try await owner.signIn(application: application, openBrowser: { _ in }).value
        }
        #expect(owner.snapshot(for: application.origin) == nil)
        next = try tokens.session(subject: "A")
        memory.canSave = false
        await #expect(throws: CloudflareAccessError.storageFailed) {
            try await owner.signIn(application: application, openBrowser: { _ in }).value
        }
        #expect(owner.snapshot(for: application.origin) == nil)
        memory.canSave = true
        let fresh = try await owner.signIn(application: application, openBrowser: { _ in }).value
        #expect(owner.snapshot(for: application.origin)?.revision == fresh.revision)
        #expect(fresh.session.subject == "A")
    }

    @Test(arguments: [false, true])
    func `canceling renewal retains A and the other origin B across restart`(
        duringRetirement: Bool) async throws
    {
        let memory = MemoryStore()
        let tokens = try CloudflareAccessTestTokens()
        let app = try CloudflareAccessTestTokens.application()
        let a = try tokens.session(subject: "A")
        let initial = CloudflareAccessSessionStore(
            persistence: memory.persistence, authenticate: { _, _ in a }, retireTransports: { _ in })
        let first = try await initial.signIn(application: app, openBrowser: { _ in }).value
        let bOrigin = try CloudflareAccessOrigin(#require(URL(string: "https://other.example.test")))
        let bApplication = CloudflareAccessApplication(origin: bOrigin, issuer: app.issuer, audience: app.audience)
        let bToken = try tokens.token([
            "iss": app.issuer.absoluteString, "aud": [app.audience],
            "type": "app", "sub": "B", "exp": a.expiresAt.timeIntervalSince1970,
        ])
        let b = CloudflareAccessSession(
            application: bApplication, subject: "B", token: bToken, expiresAt: a.expiresAt)
        let other = CloudflareAccessSessionStore(
            persistence: memory.persistence, authenticate: { _, _ in b }, retireTransports: { _ in })
        _ = try await other.signIn(application: bApplication, openBrowser: { _ in }).value
        try await initial.requireReauthentication(for: app.origin, revision: first.revision)
        let gate = LoginGate()
        let renewing = CloudflareAccessSessionStore(
            persistence: memory.persistence,
            authenticate: { _, _ in duringRetirement ? a : try await gate.login() },
            retireTransports: { _ in
                if duringRetirement { _ = try? await gate.login() }
            })
        let attempt = renewing.signIn(application: app, openBrowser: { _ in })
        await gate.waitUntilStarted()
        renewing.cancelSignIn(for: app.origin)
        gate.complete(try tokens.session(subject: "B"))
        await #expect(throws: CancellationError.self) { try await attempt.value }
        let restarted = CloudflareAccessSessionStore(
            persistence: memory.persistence,
            authenticate: { _, _ in try tokens.session(subject: "B") }, retireTransports: { _ in })
        await #expect(throws: CloudflareAccessError.accountMismatch) {
            try await restarted.signIn(application: app, openBrowser: { _ in }).value
        }
        #expect(restarted.snapshot(for: bOrigin)?.session.subject == "B")
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
                #expect(GenericPasswordKeychainStore.delete(service: rowService, account: account))
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
