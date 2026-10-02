import Foundation
import Observation
import OpenClawKit

/// One ingress session per authority; matching Access applications share a browser attempt.
@MainActor
@Observable
final class CloudflareAccessSessionStore {
    struct Snapshot: Sendable {
        let session: CloudflareAccessSession
        let revision: UInt64
    }

    enum State: Equatable {
        case signedOut
        case signingIn
        case authenticated
        case reauthenticationRequired
    }

    struct Persistence {
        var load: (CloudflareAccessOrigin) -> String?
        var save: (CloudflareAccessOrigin, String) -> Bool
        var delete: (CloudflareAccessOrigin) -> Bool

        static var keychain: Self {
            let service = "\(Bundle.main.bundleIdentifier ?? "ai.openclaw.ios").cloudflare-access"
            return Self(
                load: { GenericPasswordKeychainStore.loadString(service: service, account: $0.url.absoluteString) },
                save: { GenericPasswordKeychainStore.saveString($1, service: service, account: $0.url.absoluteString) },
                delete: { GenericPasswordKeychainStore.delete(service: service, account: $0.url.absoluteString) })
        }
    }

    typealias Browser = @MainActor @Sendable (URL) async throws -> Void
    typealias Authenticate = @MainActor (CloudflareAccessApplication, @escaping Browser) async throws
        -> CloudflareAccessSession

    private struct Attempt {
        let id: UUID
        let application: CloudflareAccessApplication
        let task: Task<Snapshot, Error>
    }

    private struct Retirement {
        let id: UUID
        let task: Task<Void, Error>
    }

    private(set) var revision: UInt64 = 0
    @ObservationIgnored private var sessions: [CloudflareAccessOrigin: Snapshot] = [:]
    @ObservationIgnored private var states: [CloudflareAccessOrigin: State] = [:]
    @ObservationIgnored private var attempts: [CloudflareAccessOrigin: Attempt] = [:]
    @ObservationIgnored private var retirements: [CloudflareAccessOrigin: Retirement] = [:]
    @ObservationIgnored private let persistence: Persistence
    @ObservationIgnored private let authenticate: Authenticate
    @ObservationIgnored private let retireTransports: (CloudflareAccessOrigin) async -> Void
    @ObservationIgnored private let now: () -> Date

    init(
        persistence: Persistence = .keychain,
        authenticate: @escaping Authenticate = { application, browser in
            try await CloudflareAccessTransfer().signIn(application: application, openBrowser: browser)
        },
        now: @escaping () -> Date = Date.init,
        retireTransports: @escaping (CloudflareAccessOrigin) async -> Void)
    {
        self.persistence = persistence
        self.authenticate = authenticate
        self.retireTransports = retireTransports
        self.now = now
    }

    func state(for origin: CloudflareAccessOrigin) -> State {
        _ = self.revision
        return self.states[origin] ?? .signedOut
    }

    func snapshot(for origin: CloudflareAccessOrigin, now: Date = Date()) -> Snapshot? {
        _ = self.revision
        if self.states[origin] == nil {
            if let encoded = self.persistence.load(origin),
               let data = encoded.data(using: .utf8),
               let session = try? JSONDecoder().decode(CloudflareAccessSession.self, from: data),
               session.origin == origin, (try? session.validate(now: now)) != nil
            {
                self.revision &+= 1
                self.sessions[origin] = Snapshot(session: session, revision: self.revision)
                self.states[origin] = .authenticated
            } else {
                self.states[origin] = .signedOut
            }
        }
        guard let snapshot = self.sessions[origin] else { return nil }
        guard snapshot.session.authorizationHeader(for: origin.url, now: now) != nil else {
            self.sessions.removeValue(forKey: origin)
            self.states[origin] = .reauthenticationRequired
            self.revision &+= 1
            _ = self.queueRetirement(origin)
            return nil
        }
        return snapshot
    }

    func signIn(application: CloudflareAccessApplication, openBrowser: @escaping Browser) -> Task<Snapshot, Error> {
        let origin = application.origin
        if let attempt = self.attempts[origin] {
            // Paths on one authority can belong to different Access applications.
            // Only matching signed metadata can share a browser transfer.
            if attempt.application == application { return attempt.task }
            self.cancelSignIn(for: origin)
        }
        let id = UUID()
        let task = Task { @MainActor in
            do {
                let session = try await self.authenticate(application, openBrowser)
                try self.checkAttempt(origin: origin, id: id)
                guard session.origin == origin, session.issuer == application.issuer,
                      session.audience == application.audience
                else { throw CloudflareAccessError.invalidSession }
                try session.validate(now: self.now())
                // Close transports, browser cookies and cached media before a new
                // Access principal can be committed. Gateway device tokens survive.
                self.sessions.removeValue(forKey: origin)
                self.revision &+= 1
                try await self.queueRetirement(origin).value
                try self.checkAttempt(origin: origin, id: id)
                // Teardown can suspend across backgrounding or expiry. Admission
                // must still be valid when persistence and publication happen.
                try session.validate(now: self.now())
                let encoded = try JSONEncoder().encode(session)
                guard let value = String(data: encoded, encoding: .utf8), self.persistence.save(origin, value) else {
                    throw CloudflareAccessError.storageFailed
                }
                self.revision &+= 1
                let snapshot = Snapshot(session: session, revision: self.revision)
                self.sessions[origin] = snapshot
                self.states[origin] = .authenticated
                self.attempts.removeValue(forKey: origin)
                return snapshot
            } catch {
                if self.attempts[origin]?.id == id {
                    self.attempts.removeValue(forKey: origin)
                    self.states[origin] = .reauthenticationRequired
                    self.revision &+= 1
                }
                throw error
            }
        }
        self.attempts[origin] = Attempt(id: id, application: application, task: task)
        self.states[origin] = .signingIn
        self.revision &+= 1
        return task
    }

    func cancelSignIn(for origin: CloudflareAccessOrigin) {
        guard let attempt = self.attempts.removeValue(forKey: origin) else { return }
        attempt.task.cancel()
        self.states[origin] = .reauthenticationRequired
        self.revision &+= 1
    }

    func requireReauthentication(for origin: CloudflareAccessOrigin, revision: UInt64) async throws {
        // A failure from an old socket must not invalidate a newer browser grant.
        guard self.sessions[origin]?.revision == revision else { return }
        self.sessions.removeValue(forKey: origin)
        self.states[origin] = .reauthenticationRequired
        self.revision &+= 1
        try await self.queueRetirement(origin).value
    }

    func forget(_ origin: CloudflareAccessOrigin) async throws {
        self.cancelSignIn(for: origin)
        self.sessions.removeValue(forKey: origin)
        self.states[origin] = .signedOut
        self.revision &+= 1
        try await self.queueRetirement(origin).value
    }

    private func queueRetirement(_ origin: CloudflareAccessOrigin) -> Task<Void, Error> {
        let previous = self.retirements[origin]?.task
        let id = UUID()
        let task = Task { @MainActor in
            // A forget or account change must finish its cookie/cache retirement
            // before a later sign-in can publish credentials for this authority.
            if let previous { _ = await previous.result }
            defer {
                if self.retirements[origin]?.id == id { self.retirements.removeValue(forKey: origin) }
            }
            await self.retireTransports(origin)
            guard self.persistence.delete(origin) else { throw CloudflareAccessError.storageFailed }
        }
        self.retirements[origin] = Retirement(id: id, task: task)
        return task
    }

    private func checkAttempt(origin: CloudflareAccessOrigin, id: UUID) throws {
        try Task.checkCancellation()
        guard self.attempts[origin]?.id == id else { throw CancellationError() }
    }
}
