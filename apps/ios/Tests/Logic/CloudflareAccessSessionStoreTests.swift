import Foundation
import Testing

@MainActor
struct CloudflareAccessSessionStoreTests {
    private final class MemoryStore {
        var values: [CloudflareAccessOrigin: String] = [:]
        var events: [String] = []
        var canSave = true

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
        try await store.forget(application.origin)
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
