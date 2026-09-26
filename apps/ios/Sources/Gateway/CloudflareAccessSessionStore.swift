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

    private struct Lifecycle {
        var phase: State = .signedOut
        var admissionRevokedAt: UInt64 = 0
        var transitionRevision: UInt64 = 0
        var retirement: Retirement?
    }

    private struct Attempt {
        let id: UUID
        let application: CloudflareAccessApplication
        let task: Task<Snapshot, Error>
    }

    struct Retirement: Sendable {
        let id: UUID
        let origin: CloudflareAccessOrigin
        let transitionRevision: UInt64
        let task: Task<Void, Error>
    }

    private(set) var revision: UInt64 = 0
    @ObservationIgnored private var sessions: [CloudflareAccessOrigin: Snapshot] = [:]
    @ObservationIgnored private var states: [CloudflareAccessOrigin: Lifecycle] = [:]
    @ObservationIgnored private var attempts: [CloudflareAccessOrigin: Attempt] = [:]
    @ObservationIgnored private var retirements: [CloudflareAccessOrigin: Retirement] = [:]
    @ObservationIgnored private let persistence: Persistence
    @ObservationIgnored private let authenticate: Authenticate
    @ObservationIgnored private let retireTransports: @MainActor (CloudflareAccessOrigin) async -> Void
    @ObservationIgnored private let now: () -> Date

    init(
        persistence: Persistence = .keychain,
        authenticate: @escaping Authenticate = { application, browser in
            try await CloudflareAccessTransfer().signIn(application: application, openBrowser: browser)
        },
        now: @escaping () -> Date = Date.init,
        retireTransports: @escaping @MainActor (CloudflareAccessOrigin) async -> Void)
    {
        self.persistence = persistence
        self.authenticate = authenticate
        self.retireTransports = retireTransports
        self.now = now
    }

    func state(for origin: CloudflareAccessOrigin) -> State {
        _ = self.revision
        return self.states[origin]?.phase ?? .signedOut
    }

    func snapshot(for origin: CloudflareAccessOrigin, now: Date? = nil) -> Snapshot? {
        let now = now ?? self.now()
        _ = self.revision
        if self.states[origin] == nil {
            if let encoded = self.persistence.load(origin),
               let data = encoded.data(using: .utf8),
               let session = try? JSONDecoder().decode(CloudflareAccessSession.self, from: data),
               session.origin == origin, (try? session.validate(now: now)) != nil
            {
                self.setState(.authenticated, for: origin)
                self.sessions[origin] = Snapshot(session: session, revision: self.revision)
            } else {
                self.setState(.signedOut, for: origin)
            }
        }
        guard let snapshot = self.sessions[origin] else { return nil }
        guard snapshot.session.authorizationHeader(for: origin.url, now: now) != nil else {
            self.sessions.removeValue(forKey: origin)
            self.setState(.reauthenticationRequired, for: origin)
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
                self.setState(.signingIn, for: origin)
                try await self.queueRetirement(origin).task.value
                try self.checkAttempt(origin: origin, id: id)
                // Teardown can suspend across backgrounding or expiry. Admission
                // must still be valid when persistence and publication happen.
                try session.validate(now: self.now())
                let encoded = try JSONEncoder().encode(session)
                guard let value = String(data: encoded, encoding: .utf8), self.persistence.save(origin, value) else {
                    throw CloudflareAccessError.storageFailed
                }
                self.setState(.authenticated, for: origin)
                let snapshot = Snapshot(session: session, revision: self.revision)
                self.sessions[origin] = snapshot
                self.attempts.removeValue(forKey: origin)
                return snapshot
            } catch {
                if self.attempts[origin]?.id == id {
                    self.attempts.removeValue(forKey: origin)
                    self.setState(.reauthenticationRequired, for: origin)
                }
                throw error
            }
        }
        self.attempts[origin] = Attempt(id: id, application: application, task: task)
        self.setState(.signingIn, for: origin)
        return task
    }

    func cancelSignIn(for origin: CloudflareAccessOrigin) {
        guard let attempt = self.attempts.removeValue(forKey: origin) else { return }
        attempt.task.cancel()
        self.setState(.reauthenticationRequired, for: origin)
    }

    func currentRevision(for origin: CloudflareAccessOrigin) -> UInt64 {
        self.sessions[origin]?.revision ?? 0
    }

    func waitForRetirement(of origin: CloudflareAccessOrigin) async throws {
        try await self.retirements[origin]?.task.value
    }

    func requireReauthentication(for origin: CloudflareAccessOrigin, revision: UInt64) async throws {
        try await self.beginReauthentication(for: origin, revision: revision)?.task.value
    }

    func beginReauthentication(for origin: CloudflareAccessOrigin, revision: UInt64) -> Retirement? {
        // Revoke before yielding: a completed browser task can still have queued
        // admission waiters. An old socket must not invalidate a newer grant.
        guard self.sessions[origin]?.revision == revision else { return nil }
        self.sessions.removeValue(forKey: origin)
        self.setState(.reauthenticationRequired, for: origin)
        return self.queueRetirement(origin)
    }

    /// Capture before endpoint/QR resolution; a later resolved origin can reject only
    /// its own retired Access intent without canceling ordinary or unrelated gateways.
    func admissionCheckpoint() -> UInt64 {
        self.revision
    }

    func admits(_ checkpoint: UInt64, for origin: CloudflareAccessOrigin) -> Bool {
        (self.states[origin]?.admissionRevokedAt ?? 0) <= checkpoint
    }

    func forget(_ origin: CloudflareAccessOrigin) -> Retirement {
        self.cancelSignIn(for: origin)
        self.sessions.removeValue(forKey: origin)
        self.setState(.signedOut, for: origin)
        self.states[origin, default: Lifecycle()].admissionRevokedAt = self.revision
        return self.queueRetirement(origin)
    }

    /// Cleanup waiters follow the latest explicit revocation, including its failure.
    /// A newer authentication/session transition instead requires a fresh retirement.
    func reconcileForget(_ origin: CloudflareAccessOrigin) -> Retirement {
        if let lifecycle = self.states[origin], lifecycle.phase == .signedOut,
           let retirement = lifecycle.retirement
        {
            return retirement
        }
        return self.forget(origin)
    }

    func isCurrent(_ retirement: Retirement) -> Bool {
        self.states[retirement.origin]?.transitionRevision == retirement.transitionRevision
    }

    private func setState(_ phase: State, for origin: CloudflareAccessOrigin) {
        // Phase changes and replacement grants must not revive an old admission.
        self.revision &+= 1
        self.states[origin, default: Lifecycle()].phase = phase
        self.states[origin, default: Lifecycle()].retirement = nil
        self.states[origin, default: Lifecycle()].transitionRevision = self.revision
    }

    private func queueRetirement(_ origin: CloudflareAccessOrigin) -> Retirement {
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
            guard self.persistence.delete(origin) else {
                if self.states[origin]?.retirement?.id == id {
                    self.states[origin]?.retirement = nil
                }
                throw CloudflareAccessError.storageFailed
            }
        }
        // Queue completion only releases its task. Its acknowledgement stays current
        // until a later transition for this origin, even after the queue entry is gone.
        let retirement = Retirement(id: id, origin: origin, transitionRevision: self.revision, task: task)
        self.retirements[origin] = retirement
        self.states[origin, default: Lifecycle()].retirement = retirement
        return retirement
    }

    private func checkAttempt(origin: CloudflareAccessOrigin, id: UUID) throws {
        try Task.checkCancellation()
        guard self.attempts[origin]?.id == id else { throw CancellationError() }
    }
}
