import Foundation
import Observation
import OpenClawKit
import os

struct GatewayIngressAuthorization: Sendable {
    typealias Request = @Sendable (URLRequest) async throws -> (Data, URLResponse)
    let origin: CloudflareAccessOrigin
    let principal: CloudflareAccessPrincipal
    let revision: UInt64
    let headers: @Sendable (URL) async throws -> [String: String]
    let isCurrent: @MainActor @Sendable () -> Bool
    let dashboardCookie: @MainActor @Sendable (URL) -> HTTPCookie?
    let checkResponse: @Sendable (HTTPURLResponse) async throws -> Void
    let load: @Sendable (URLRequest, @escaping Request) async throws -> (Data, URLResponse)
}

/// Owns browser interaction and ingress lifetime across node, operator, fleet and native media.
@MainActor
@Observable
final class GatewayIngressController {
    typealias RequestDeadline = @Sendable (
        TimeInterval, @escaping @Sendable () async throws -> (Data, HTTPURLResponse)) async throws
        -> (Data, HTTPURLResponse)

    struct Route: Equatable, Sendable {
        let url: URL
        let stableID: String
        let tls: GatewayTLSParams?
    }

    struct Attention: Identifiable {
        let id: UUID
        let origin: CloudflareAccessOrigin
        let stableID: String
        let message: String
        let canSignIn: Bool
    }

    private struct Registration: Sendable {
        let id = UUID()
        let route: Route
        var managedRevision: UInt64?
        /// nil is unclassified; false is a verified managed challenge, including pending sign-in.
        var ordinaryAdmission: Bool?
    }

    private struct BrowserParticipant: Sendable {
        let id = UUID()
        let registration: Registration
        let canceled = OSAllocatedUnfairLock(initialState: false)
    }

    private struct ForegroundIntent {
        let id: UUID
        let application: CloudflareAccessApplication
        let route: Route
        let completion: Task<CloudflareAccessSessionStore.Snapshot, Error>
        var participants: [BrowserParticipant] = []
        // Withdrawal ends browser eligibility; pending authentication still belongs to its joined registrations.
        var registrationIDs: Set<UUID> = []
        var attentionID: UUID?
    }

    private struct DiscoveryOwner: Sendable {
        let registration: Registration
        let snapshot: CloudflareAccessSessionStore.Snapshot
        let requiresManagedAdmission: Bool
    }

    private struct ManagedRequest {
        let profileID: GatewayStableIdentifier.Key
        let registrationID: UUID
        let revision: UInt64
        let requiresManagedAdmission: Bool
        let task: Task<(Data, URLResponse), Error>
    }

    private(set) var attention: Attention?
    private(set) var signingIn = false
    @ObservationIgnored private var routes: [GatewayStableIdentifier.Key: Registration] = [:]
    @ObservationIgnored private var expiryTasks: [CloudflareAccessOrigin: Task<Void, Never>] = [:]
    @ObservationIgnored private var blockedRevisions: [CloudflareAccessOrigin: UInt64] = [:]
    @ObservationIgnored private var managedRequests: [CloudflareAccessOrigin: [UUID: ManagedRequest]] =
        [:]
    @ObservationIgnored private var foregroundIntent: ForegroundIntent?
    @ObservationIgnored private let browser: any CloudflareAccessBrowserPresenting
    @ObservationIgnored private let persistence: CloudflareAccessSessionStore.Persistence
    @ObservationIgnored private let authenticate: CloudflareAccessSessionStore.Authenticate?
    @ObservationIgnored private let requestFactory: @Sendable (Route) -> CloudflareAccessClient.Request
    @ObservationIgnored private let requestDeadline: RequestDeadline
    @ObservationIgnored private let profiles: () -> [GatewaySettingsStore.GatewayRegistryEntry]
    @ObservationIgnored private let saveProfileOrigin: (String, CloudflareAccessOrigin?) -> Bool
    @ObservationIgnored private let customHeaders: (String) -> [String: String]
    @ObservationIgnored private let now: () -> Date
    @ObservationIgnored private let retireTransports: @MainActor (CloudflareAccessOrigin) async -> Void
    @ObservationIgnored private lazy var sessions = self.makeSessionStore()

    init(
        persistence: CloudflareAccessSessionStore.Persistence = .keychain,
        browser: any CloudflareAccessBrowserPresenting = CloudflareAccessBrowserPresenter(),
        authenticate: CloudflareAccessSessionStore.Authenticate? = nil,
        requestFactory: @escaping @Sendable (Route) -> CloudflareAccessClient.Request = GatewayIngressController
            .request,
        requestDeadline: @escaping RequestDeadline = GatewayIngressController.withRequestDeadline,
        customHeaders: @escaping (String) -> [String: String] = {
            GatewaySettingsStore.loadGatewayCustomHeaders(gatewayStableID: $0)
        },
        profiles: @escaping () -> [GatewaySettingsStore.GatewayRegistryEntry] = {
            GatewaySettingsStore.loadGatewayRegistry().entries
        },
        saveProfileOrigin: @escaping (String, CloudflareAccessOrigin?) -> Bool = {
            GatewaySettingsStore.saveGatewayAccessOrigin(stableID: $0, origin: $1)
        },
        now: @escaping () -> Date = Date.init,
        retireTransports: @escaping @MainActor (CloudflareAccessOrigin) async -> Void)
    {
        self.persistence = persistence
        self.browser = browser
        self.authenticate = authenticate
        self.requestFactory = requestFactory
        self.requestDeadline = requestDeadline
        self.customHeaders = customHeaders
        self.profiles = profiles
        self.saveProfileOrigin = saveProfileOrigin
        self.now = now
        self.retireTransports = retireTransports
    }

    private func makeSessionStore() -> CloudflareAccessSessionStore {
        CloudflareAccessSessionStore(
            persistence: self.persistence,
            authenticate: { [weak self] application, openBrowser in
                guard let self, let intent = self.foregroundIntent, intent.application == application
                else { throw CancellationError() }
                let route = intent.route
                if let authenticate = self.authenticate {
                    return try await authenticate(application, openBrowser)
                }
                return try await CloudflareAccessTransfer(client: self.client(for: route))
                    .signIn(application: application, openBrowser: openBrowser)
            },
            now: self.now,
            retireTransports: { [weak self] origin in
                guard let self else { return }
                self.expiryTasks.removeValue(forKey: origin)?.cancel()
                let requests = self.managedRequests[origin] ?? [:]
                requests.values.forEach { $0.task.cancel() }
                for request in requests.values {
                    _ = await request.task.result
                }
                await self.retireTransports(origin)
            })
    }

    func admissionCheckpoint() -> UInt64 {
        self.sessions.admissionCheckpoint()
    }

    func prepare(
        route: Route,
        userInitiated: Bool,
        admissionCheckpoint: UInt64) async throws -> GatewayIngressAuthorization?
    {
        try Task.checkCancellation()
        let key = GatewayStableIdentifier.Key(route.stableID)
        guard let origin = try? CloudflareAccessOrigin(route.url) else {
            try await self.forget(stableID: route.stableID)
            try Task.checkCancellation()
            // A superseded Forget is a valid no-op, not ordinary admission for
            // the caller whose route was replaced while cleanup drained.
            guard self.routes[key] == nil else { throw CancellationError() }
            return nil
        }
        let previous = self.routes[key]
        let registration = previous.flatMap { $0.route == route ? $0 : nil } ?? Registration(route: route)
        self.routes[key] = registration
        func checkManagedAdmission() throws {
            try self.checkRegistration(registration)
            guard self.sessions.admits(admissionCheckpoint, for: origin) else { throw CancellationError() }
        }
        if let previous, previous.id != registration.id {
            self.retireBrowserParticipation(for: previous)
        }
        await self.retireRequests(profileID: key)
        try self.checkRegistration(registration)
        if let previous = profiles().first(where: { $0.id == key })?.accessOrigin, previous != origin {
            guard try await self.depart(
                stableID: route.stableID,
                savedOrigin: previous,
                origins: [previous],
                registrationID: registration.id) else { throw CancellationError() }
        }
        let client = self.client(for: route)
        let preCommitRevision = self.routes[key]?.managedRevision
        let preCommitOrdinary = self.routes[key]?.ordinaryAdmission
        // A cached host grant must not make an independently admitted profile depend
        // on browser sign-out or expiry. Existing service headers and WARP go first.
        let ordinaryChallenge = try await client.discover(
            gatewayURL: route.url,
            customHeaders: self.customHeaders(route.stableID))
        try self.checkRegistration(registration)
        guard let ordinaryChallenge else {
            try await self.admitOrdinary(
                registration,
                previousRevision: preCommitRevision,
                previousOrdinary: preCommitOrdinary)
            return nil
        }
        self.routes[key]?.ordinaryAdmission = false
        try checkManagedAdmission()
        var snapshot = self.sessions.snapshot(for: origin)
        try await self.sessions.waitForRetirement(of: origin)
        try checkManagedAdmission()
        if let snapshot, !self.isCurrent(origin: origin, revision: snapshot.revision) {
            throw GatewayExternalAuthorizationError()
        }
        var application: CloudflareAccessApplication? = ordinaryChallenge
        if let snapshot {
            application = try await self.client(for: route, owner: DiscoveryOwner(
                registration: registration, snapshot: snapshot, requiresManagedAdmission: false)).discover(
                gatewayURL: route.url,
                session: snapshot.session,
                customHeaders: self.customHeaders(route.stableID))
        }
        try Task.checkCancellation()
        try checkManagedAdmission()
        // A response obtained with an old grant cannot admit an ordinary transport.
        // Expiry, forget, or account replacement during the probe must retire this admission.
        if let snapshot, !self.isCurrent(origin: origin, revision: snapshot.revision) {
            throw GatewayExternalAuthorizationError()
        }
        // Record verified ownership before sign-in can persist a grant. Browser
        // dismissal can suspend or be canceled after commit; cold Forget must still find it.
        guard self.saveProfileOrigin(route.stableID, origin) else {
            if !self.profiles().contains(where: { $0.accessOrigin == origin }) {
                try await self.sessions.forget(origin).task.value
            }
            throw CloudflareAccessError.storageFailed
        }
        if let application {
            let attentionID = UUID()
            self.showAttention(route, message: "Sign in to Cloudflare Access to connect this gateway.", id: attentionID)
            if let snapshot {
                self.blockedRevisions[origin] = snapshot.revision
                // prepare runs before physical connection ownership, so it can await the drain.
                // Upgrade/media rejection revokes synchronously and queues teardown to avoid joining itself.
                try await self.sessions.requireReauthentication(for: origin, revision: snapshot.revision)
            }
            guard userInitiated else { throw GatewayExternalAuthorizationError() }
            try checkManagedAdmission()
            snapshot = try await self.signIn(application, registration: registration, attentionID: attentionID)
            try checkManagedAdmission()
        }
        // A managed admission must still own its exact revision after browser dismissal.
        guard let snapshot else { throw GatewayExternalAuthorizationError() }
        guard self.isCurrent(origin: origin, revision: snapshot.revision) else {
            throw GatewayExternalAuthorizationError()
        }
        self.blockedRevisions.removeValue(forKey: origin)
        self.routes[key]?.managedRevision = snapshot.revision
        self.scheduleExpiry(snapshot)
        if GatewayStableIdentifier.matches(self.attention?.stableID, route.stableID) {
            self.attention = nil
        }
        return try self.authorization(registration: registration, origin: origin, snapshot: snapshot)
    }

    func signIn(for attention: Attention, admissionCheckpoint: UInt64) async throws {
        guard let current = self.attention, current.id == attention.id, current.canSignIn,
              let route = self.route(stableID: current.stableID, origin: current.origin)
        else {
            throw CancellationError()
        }
        _ = try await self.prepare(route: route, userInitiated: true, admissionCheckpoint: admissionCheckpoint)
    }

    func hasSession(stableID: String) -> Bool {
        guard let origin = origin(stableID: stableID) else { return false }
        return self.sessions.snapshot(for: origin) != nil
    }

    func signOut(stableID: String) async {
        guard let origin = origin(stableID: stableID) else { return }
        _ = self.retireManagedAdmissions(origin: origin, revision: self.sessions.currentRevision(for: origin))
        if self.foregroundIntent?.application.origin == origin {
            self.cancelSignIn()
        }
        let route = Route(url: origin.url, stableID: stableID, tls: nil)
        let retirement = self.sessions.reconcileForget(origin)
        let operationID = UUID()
        self.showAttention(
            route, message: "Signing out of Cloudflare Access…", id: operationID, canSignIn: false)
        let message: String
        do {
            try await retirement.task.value
            message = "Cloudflare Access is signed out for this host. " +
                "Sign in to reconnect gateways using this Access session."
        } catch {
            message = error.localizedDescription
        }
        // Cleanup owns its result even after caller cancellation, but a newer prompt
        // owns the action slot. Publish only for this operation's pending attention.
        guard self.attention?.id == operationID else { return }
        self.showAttention(route, message: message, id: operationID)
    }

    func forget(stableID: String) async throws {
        try Task.checkCancellation()
        let key = GatewayStableIdentifier.Key(stableID)
        let registration = self.routes.removeValue(forKey: key)
        let saved = self.profiles().first { $0.id == key }?.accessOrigin
        let origins = Set([registration.flatMap { try? CloudflareAccessOrigin($0.route.url) }, saved]
            .compactMap(\.self))
        if let registration { self.retireBrowserParticipation(for: registration) }
        let attentionID = self.attention?.id
        guard try await self.depart(stableID: stableID, savedOrigin: saved, origins: origins, registrationID: nil)
        else { return }
        if self.attention?.id == attentionID, GatewayStableIdentifier.matches(self.attention?.stableID, stableID) {
            self.attention = nil
        }
    }

    private func depart(
        stableID: String,
        savedOrigin: CloudflareAccessOrigin?,
        origins: Set<CloudflareAccessOrigin>,
        registrationID: UUID?) async throws -> Bool
    {
        let key = GatewayStableIdentifier.Key(stableID)
        func isCurrent() throws -> Bool {
            // Forget completes admitted cleanup; a changed-route caller still owns
            // an admission that cancellation must fence before publishing its change.
            if registrationID != nil { try Task.checkCancellation() }
            return self.routes[key]?.id == registrationID &&
                self.profiles().first(where: { $0.id == key })?.accessOrigin == savedOrigin
        }
        func hasSibling(_ origin: CloudflareAccessOrigin) -> Bool {
            self.profiles().contains { $0.id != key && $0.accessOrigin == origin }
        }
        try Task.checkCancellation()
        guard try isCurrent() else { return false }
        var retirements: [CloudflareAccessOrigin: CloudflareAccessSessionStore.Retirement] = [:]
        // Reconcile last-owner revocation before draining, reusing any current cleanup. Keep its durable
        // association until acknowledged deletion so failure remains recoverable.
        for origin in origins where !hasSibling(origin) {
            retirements[origin] = self.sessions.reconcileForget(origin)
        }
        if registrationID == nil { await self.retireRequests(profileID: key) }
        while true {
            guard try isCurrent() else { return false }
            for retirement in retirements.values {
                try await retirement.task.value
                guard try isCurrent() else { return false }
            }
            // A sibling may renew and then leave while our continuation is suspended.
            // Reconcile the last departure against that origin's current acknowledgement.
            var renewed = false
            for origin in origins where !hasSibling(origin) {
                if let retirement = retirements[origin], self.sessions.isCurrent(retirement) { continue }
                retirements[origin] = self.sessions.reconcileForget(origin)
                renewed = true
            }
            if renewed { continue }
            // No suspension between final ownership/receipt checks and the durable clear.
            if savedOrigin != nil, !self.saveProfileOrigin(stableID, nil) {
                throw CloudflareAccessError.storageFailed
            }
            for (origin, retirement) in retirements where self.sessions.isCurrent(retirement) {
                self.blockedRevisions.removeValue(forKey: origin)
            }
            return true
        }
    }

    private func admitOrdinary(
        _ registration: Registration,
        previousRevision: UInt64?,
        previousOrdinary: Bool?) async throws
    {
        try self.checkRegistration(registration)
        let key = GatewayStableIdentifier.Key(registration.route.stableID)
        guard self.routes[key]?.managedRevision == previousRevision,
              self.routes[key]?.ordinaryAdmission == previousOrdinary else { throw CancellationError() }
        // Identity rotation retires even completed browser waiters that have not resumed.
        // An already ordinary profile retains its owner through repeated probes.
        var ordinary = self.routes[key]?
            .ordinaryAdmission == true ? registration : Registration(route: registration.route)
        ordinary.managedRevision = nil
        ordinary.ordinaryAdmission = true
        self.routes[key] = ordinary
        // Transfer explicit-departure custody without reviving the old browser participants.
        if self.foregroundIntent?.registrationIDs.remove(registration.id) != nil {
            self.foregroundIntent?.registrationIDs.insert(ordinary.id)
        }
        let attentionID = self.attention?.id
        let pending = self.cancelObsoleteRequests(profileID: key)
        if let intent = self.foregroundIntent {
            self.reconcileBrowser(intentID: intent.id)
        }
        if self.attention?.id == attentionID,
           GatewayStableIdentifier.matches(self.attention?.stableID, registration.route.stableID)
        {
            self.attention = nil
        }
        for task in pending {
            _ = await task.result
        }
        try self.checkRegistration(ordinary)
        guard self.routes[key]?.ordinaryAdmission == true else { throw CancellationError() }
    }

    private func retireRequests(profileID: GatewayStableIdentifier.Key) async {
        for task in self.cancelObsoleteRequests(profileID: profileID) {
            _ = await task.result
        }
    }

    private func cancelObsoleteRequests(profileID: GatewayStableIdentifier.Key) -> [Task<(Data, URLResponse), Error>] {
        let registration = self.routes[profileID]
        // Discovery can precede managed admission. Keep its registration/revision
        // custody until actual settlement, including after a caller deadline returns.
        let pending = self.managedRequests.values.flatMap { requests in
            requests.values.filter { request in
                request.profileID == profileID &&
                    (request.registrationID != registration?.id ||
                        (request.requiresManagedAdmission && request.revision != registration?.managedRevision))
            }.map(\.task)
        }
        // Capture before cancellation or presentation can publish a successor.
        pending.forEach { $0.cancel() }
        return pending
    }

    private func route(stableID: String, origin: CloudflareAccessOrigin) -> Route? {
        let key = GatewayStableIdentifier.Key(stableID)
        if let route = self.routes[key]?.route {
            return route
        }

        guard let profile = self.profiles().first(where: { $0.id == key }),
              profile.accessOrigin == origin
        else { return nil }

        let host: String
        let port: Int
        let contextPath: String?
        let tlsRequired: Bool
        switch profile.kind {
        case .manual:
            guard let savedHost = profile.host, let savedPort = profile.port else { return nil }
            host = savedHost
            port = savedPort
            contextPath = profile.contextPath
            tlsRequired = GatewayConnectionController.manualTransportPresentation(
                host: savedHost,
                requestedTLS: profile.useTLS).effectiveTLS
        case .discovered:
            guard let savedHost = origin.url.host else { return nil }
            host = savedHost
            port = origin.url.port ?? 443
            contextPath = nil
            tlsRequired = true
        }

        let fingerprint = GatewayTLSStore.loadFingerprint(stableID: profile.stableID)
        let tls = tlsRequired || fingerprint != nil
            ? GatewayTLSParams(
                required: true,
                expectedFingerprint: fingerprint,
                allowTOFU: false,
                storeKey: profile.stableID)
            : nil
        guard let url = GatewayConnectEndpoint(
            host: host, port: port, tls: tls?.required == true, contextPath: contextPath).websocketURL,
            (try? CloudflareAccessOrigin(url)) == origin
        else { return nil }
        return Route(url: url, stableID: profile.stableID, tls: tls)
    }

    private func origin(stableID: String) -> CloudflareAccessOrigin? {
        let key = GatewayStableIdentifier.Key(stableID)
        // A replacement route cannot take ownership until the saved grant is retired.
        // Keep lookup and Sign out on that durable origin when retirement fails or suspends.
        if let saved = self.profiles().first(where: { $0.id == key })?.accessOrigin {
            return saved
        }
        if let route = routes[key]?.route {
            return try? CloudflareAccessOrigin(route.url)
        }
        return nil
    }

    private func checkRegistration(_ registration: Registration) throws {
        try Task.checkCancellation()
        let current = self.routes[GatewayStableIdentifier.Key(registration.route.stableID)]
        guard current?.id == registration.id
        else { throw CancellationError() }
    }

    func cancelSignIn(preserving attentionID: UUID? = nil) {
        guard let intent = foregroundIntent else { return }
        let participant = self.liveParticipant(in: intent)
        self.foregroundIntent = nil
        intent.completion.cancel()
        self.sessions.cancelSignIn(for: intent.application.origin)
        let wasSigningIn = self.signingIn
        self.signingIn = false
        guard wasSigningIn else { return }
        if let participant, attentionID == nil || self.attention?.id != attentionID {
            self.showAttention(
                participant.registration.route,
                message: "Sign-in was canceled. Choose Sign in to try again.")
        }
        Task { await self.browser.dismiss(intentID: intent.id) }
    }

    func forget(origin: CloudflareAccessOrigin) async throws {
        if self.foregroundIntent?.application.origin == origin {
            self.cancelSignIn()
        }
        let attentionID = self.attention?.id
        self.routes = self.routes.filter { (try? CloudflareAccessOrigin($0.value.route.url)) != origin }
        try await self.sessions.forget(origin).task.value
        self.blockedRevisions.removeValue(forKey: origin)
        if self.attention?.id == attentionID, self.attention?.origin == origin {
            self.attention = nil
        }
    }

    func foregrounded() {
        // Timers may have been suspended by iOS; reading the store expires grants at this boundary.
        for registration in self.routes.values.sorted(by: { $0.route.stableID < $1.route.stableID }) {
            let route = registration.route
            guard let revision = registration.managedRevision,
                  routes[GatewayStableIdentifier.Key(route.stableID)]?.managedRevision == revision,
                  let origin = try? CloudflareAccessOrigin(route.url)
            else { continue }
            let snapshot = self.sessions.snapshot(for: origin)
            if let snapshot, snapshot.revision == revision {
                self.scheduleExpiry(snapshot)
            } else {
                let retired = self.retireManagedAdmissions(origin: origin, revision: revision)
                if snapshot == nil, self.sessions.state(for: origin) == .reauthenticationRequired, let retired {
                    self.showAttention(retired, message: "Cloudflare Access expired. Sign in again to reconnect.")
                }
            }
        }
    }

    private func signIn(
        _ application: CloudflareAccessApplication,
        registration: Registration,
        attentionID: UUID) async throws -> CloudflareAccessSessionStore.Snapshot
    {
        if self.foregroundIntent?.application != application ||
            self.foregroundIntent.map({ self.liveParticipant(in: $0) == nil }) == true ||
            (!self.signingIn && self.sessions.currentRevision(for: application.origin) == 0)
        {
            // prepare already published this application's prompt. Retiring the old
            // browser must not replace that exact action, even for the same profile.
            self.cancelSignIn(preserving: attentionID)
        }
        let participant = BrowserParticipant(registration: registration)
        if self.foregroundIntent == nil {
            let intentID = UUID()
            let completion = Task { [weak self] in
                guard let self else { throw CancellationError() }
                defer {
                    if self.foregroundIntent?.id == intentID {
                        self.foregroundIntent?.registrationIDs.removeAll()
                    }
                }
                try Task.checkCancellation()
                let task = self.sessions.signIn(application: application) { [weak self] url in
                    guard let self, let intent = self.foregroundIntent, intent.id == intentID,
                          self.liveParticipant(in: intent) != nil else { throw CancellationError() }
                    try await self.browser.open(url, intentID: intentID) { [weak self] in
                        guard let self, let intent = self.foregroundIntent, intent.id == intentID,
                              self.liveParticipant(in: intent) != nil else { return }
                        self.cancelSignIn()
                    }
                }
                do {
                    let snapshot = try await task.value
                    try Task.checkCancellation()
                    guard self.foregroundIntent?.id == intentID else { throw CancellationError() }
                    self.blockedRevisions.removeValue(forKey: application.origin)
                    await self.browser.dismiss(intentID: intentID)
                    try Task.checkCancellation()
                    guard self.foregroundIntent?.id == intentID else { throw CancellationError() }
                    self.signingIn = false
                    return snapshot
                } catch {
                    if let intent = self.foregroundIntent, intent.id == intentID {
                        if let participant = self.liveParticipant(in: intent),
                           self.attention?.id == intent.attentionID
                        {
                            self.showAttention(participant.registration.route, message: error.localizedDescription)
                        }
                        await self.browser.dismiss(intentID: intentID)
                        if self.foregroundIntent?.id == intentID {
                            self.foregroundIntent = nil
                            self.signingIn = false
                        }
                    }
                    throw error
                }
            }
            // Attach before exposing signingIn to synchronous observation callbacks.
            self.foregroundIntent = ForegroundIntent(
                id: intentID,
                application: application,
                route: registration.route,
                completion: completion,
                participants: [participant],
                registrationIDs: [registration.id],
                attentionID: self.attention?.id == attentionID ? attentionID : nil)
            self.signingIn = true
        } else {
            self.foregroundIntent?.participants.append(participant)
            if self.signingIn { self.foregroundIntent?.registrationIDs.insert(registration.id) }
            if self.attention?.id == attentionID { self.foregroundIntent?.attentionID = attentionID }
        }
        guard let intent = foregroundIntent, intent.participants.contains(where: { $0.id == participant.id })
        else { throw CancellationError() }
        defer { self.withdraw(participant, intentID: intent.id) }
        // Canceling a caller withdraws browser eligibility immediately, but Store
        // retains the shared authentication task until an explicit owner retires it.
        return try await withTaskCancellationHandler {
            let snapshot = try await intent.completion.value
            try self.checkRegistration(registration)
            guard !intent.completion.isCancelled else { throw CancellationError() }
            return snapshot
        } onCancel: {
            participant.canceled.withLock { $0 = true }
            Task { @MainActor [weak self] in self?.withdraw(participant, intentID: intent.id) }
        }
    }

    private func liveParticipant(in intent: ForegroundIntent) -> BrowserParticipant? {
        intent.participants.first { participant in
            let current = self.routes[GatewayStableIdentifier.Key(participant.registration.route.stableID)]
            return !participant.canceled.withLock { $0 } && current?.id == participant.registration.id &&
                current?.ordinaryAdmission == false
        }
    }

    private func retireBrowserParticipation(for registration: Registration) {
        guard let intent = foregroundIntent,
              intent.registrationIDs.contains(registration.id) ||
              intent.participants.contains(where: { $0.registration.id == registration.id }) else { return }
        self.foregroundIntent?.registrationIDs.remove(registration.id)
        self.foregroundIntent?.participants.removeAll { $0.registration.id == registration.id }
        // Profile removal retires only its waiters. A coalesced peer still owns the
        // same Store task and presentation, including completion awaiting dismissal.
        if let current = foregroundIntent, liveParticipant(in: current) != nil {
            self.reconcileBrowser(intentID: intent.id)
        } else {
            if self.attention?.id == intent.attentionID {
                self.attention = nil
            }
            self.cancelSignIn()
        }
    }

    private func withdraw(_ participant: BrowserParticipant, intentID: UUID) {
        guard self.foregroundIntent?.id == intentID else { return }
        self.foregroundIntent?.participants.removeAll { $0.id == participant.id }
        self.reconcileBrowser(intentID: intentID)
    }

    private func reconcileBrowser(intentID: UUID) {
        guard let intent = self.foregroundIntent, intent.id == intentID else { return }
        let participant = self.liveParticipant(in: intent)
        if let attention = self.attention, attention.id == intent.attentionID {
            if let participant {
                if !GatewayStableIdentifier.matches(attention.stableID, participant.registration.route.stableID) {
                    self.showAttention(
                        participant.registration.route,
                        message: attention.message,
                        id: attention.id,
                        canSignIn: attention.canSignIn)
                }
            } else {
                self.attention = nil
            }
        }
        if participant == nil, self.signingIn {
            Task { await self.browser.dismiss(intentID: intentID) }
        }
    }

    private func authorization(
        registration: Registration,
        origin: CloudflareAccessOrigin,
        snapshot: CloudflareAccessSessionStore.Snapshot) throws -> GatewayIngressAuthorization
    {
        let revision = snapshot.revision
        let principal = try CloudflareAccessPrincipal.verified(from: snapshot.session, now: self.now())
        return GatewayIngressAuthorization(
            origin: origin,
            principal: principal,
            revision: revision,
            headers: { [weak self] url in
                guard let self else { throw CancellationError() }
                return try await self.headers(for: url, registration: registration, origin: origin, revision: revision)
            },
            isCurrent: { [weak self] in
                self?.isCurrent(registration: registration, origin: origin, revision: revision) == true
            },
            dashboardCookie: { [weak self] url in
                guard let self else { return nil }
                return self.dashboardCookie(for: url, registration: registration, origin: origin, revision: revision)
            },
            checkResponse: { [weak self] response in
                guard let self else { throw CancellationError() }
                try await self.checkResponse(response, registration: registration, origin: origin, revision: revision)
            },
            load: { [weak self] request, operation in
                guard let self else { throw CancellationError() }
                return try await self.load(
                    request,
                    operation: operation,
                    registration: registration,
                    origin: origin,
                    revision: revision)
            })
    }

    private func load(
        _ request: URLRequest,
        operation: @escaping GatewayIngressAuthorization.Request,
        registration: Registration,
        origin: CloudflareAccessOrigin,
        revision: UInt64) async throws -> (Data, URLResponse)
    {
        guard let url = request.url, origin.contains(url), isCurrent(
            registration: registration,
            origin: origin,
            revision: revision)
        else { throw GatewayExternalAuthorizationError() }
        let task = try self.beginRequest(
            request,
            operation: operation,
            registration: registration,
            origin: origin,
            revision: revision,
            requiresManagedAdmission: true)
        let result = try await withTaskCancellationHandler {
            try await task.value
        } onCancel: { task.cancel() }
        try Task.checkCancellation()
        guard self.isCurrent(registration: registration, origin: origin, revision: revision)
        else { throw GatewayExternalAuthorizationError() }
        return result
    }

    private func beginRequest(
        _ request: URLRequest,
        operation: @escaping GatewayIngressAuthorization.Request,
        registration: Registration,
        origin: CloudflareAccessOrigin,
        revision: UInt64,
        requiresManagedAdmission: Bool) throws -> Task<(Data, URLResponse), Error>
    {
        func requireCurrent() throws {
            try self.checkRegistration(registration)
            guard self.isCurrent(origin: origin, revision: revision),
                  !requiresManagedAdmission || self.isCurrent(
                      registration: registration, origin: origin, revision: revision)
            else { throw GatewayExternalAuthorizationError() }
        }
        try requireCurrent()
        let id = UUID()
        let task = Task {
            defer {
                self.managedRequests[origin]?.removeValue(forKey: id)
                if self.managedRequests[origin]?.isEmpty == true {
                    self.managedRequests.removeValue(forKey: origin)
                }
            }
            try requireCurrent()
            let result = try await operation(request)
            // Raw work can ignore cancellation. Retired requests must not publish
            // success that restores managed admission over an ordinary successor.
            try Task.checkCancellation()
            return result
        }
        self.managedRequests[origin, default: [:]][id] = ManagedRequest(
            profileID: GatewayStableIdentifier.Key(registration.route.stableID),
            registrationID: registration.id,
            revision: revision,
            requiresManagedAdmission: requiresManagedAdmission,
            task: task)
        return task
    }

    private func isCurrent(registration: Registration, origin: CloudflareAccessOrigin, revision: UInt64) -> Bool {
        self.routes[GatewayStableIdentifier.Key(registration.route.stableID)]?.id == registration.id &&
            self.routes[GatewayStableIdentifier.Key(registration.route.stableID)]?.managedRevision == revision &&
            self.isCurrent(origin: origin, revision: revision)
    }

    private func isCurrent(origin: CloudflareAccessOrigin, revision: UInt64) -> Bool {
        let current = self.sessions.snapshot(for: origin)?.revision ?? 0
        return current == revision && self.blockedRevisions[origin] != revision
    }

    private func dashboardCookie(
        for url: URL,
        registration: Registration,
        origin: CloudflareAccessOrigin,
        revision: UInt64) -> HTTPCookie?
    {
        guard self.isCurrent(registration: registration, origin: origin, revision: revision),
              let snapshot = self.sessions.snapshot(for: origin),
              snapshot.revision == revision,
              let cookie = snapshot.session.dashboardCookie(for: url, now: self.now()),
              self.isCurrent(registration: registration, origin: origin, revision: revision),
              self.sessions.snapshot(for: origin)?.revision == revision
        else { return nil }
        return cookie
    }

    private func headers(
        for url: URL,
        registration: Registration,
        origin: CloudflareAccessOrigin,
        revision: UInt64) async throws -> [String: String]
    {
        guard origin.contains(url) else { throw CloudflareAccessError.invalidGateway }
        guard self.isCurrent(registration: registration, origin: origin, revision: revision)
        else { throw GatewayExternalAuthorizationError() }
        guard let snapshot = self.sessions.snapshot(for: origin) else { throw GatewayExternalAuthorizationError() }
        let route = registration.route
        let custom = self.customHeaders(route.stableID)
        let application = try await self.client(for: route, owner: DiscoveryOwner(
            registration: registration, snapshot: snapshot, requiresManagedAdmission: true)).discover(
            gatewayURL: route.url,
            session: snapshot.session,
            customHeaders: custom)
        try Task.checkCancellation()
        guard self.isCurrent(registration: registration, origin: origin, revision: revision) else {
            throw GatewayExternalAuthorizationError()
        }
        if application != nil {
            self.invalidate(origin: origin, revision: revision, route: route)
            throw GatewayExternalAuthorizationError()
        }
        var headers = GatewayCustomHeaders.sanitized(custom)
        if let token = snapshot.session.authorizationHeader(for: url, now: now()) {
            headers = headers.filter { $0.key.caseInsensitiveCompare("Cf-Access-Token") != .orderedSame }
            headers["Cf-Access-Token"] = token
        }
        return headers
    }

    private func checkResponse(
        _ response: HTTPURLResponse,
        registration: Registration,
        origin: CloudflareAccessOrigin,
        revision: UInt64) throws
    {
        guard self.isCurrent(registration: registration, origin: origin, revision: revision)
        else { throw GatewayExternalAuthorizationError() }
        if CloudflareAccessClient.isChallenge(response, origin: origin) {
            self.invalidate(origin: origin, revision: revision, route: registration.route)
            throw GatewayExternalAuthorizationError()
        }
    }

    private func invalidate(origin: CloudflareAccessOrigin, revision: UInt64, route: Route? = nil) {
        guard self.sessions.currentRevision(for: origin) == revision,
              self.blockedRevisions[origin] != revision
        else { return }
        // Remove Store currentness in this actor turn. Teardown remains queued
        // because an upgrade/media task must never join its own retirement.
        _ = self.sessions.beginReauthentication(for: origin, revision: revision)
        self.blockedRevisions[origin] = revision
        let managedRoute = self.retireManagedAdmissions(origin: origin, revision: revision)
        if let route = route ?? managedRoute {
            self.showAttention(
                route,
                message: "Cloudflare Access needs sign-in again. Open Gateway settings to continue.")
        }
    }

    private func retireManagedAdmissions(origin: CloudflareAccessOrigin, revision: UInt64) -> Route? {
        let owners = self.routes.filter { $0.value.managedRevision == revision && origin.contains($0.value.route.url) }
        for key in owners.keys {
            self.routes[key]?.managedRevision = nil
        }
        return owners.values.map(\.route).min(by: { $0.stableID < $1.stableID })
    }

    private func scheduleExpiry(_ snapshot: CloudflareAccessSessionStore.Snapshot) {
        let origin = snapshot.session.origin
        self.expiryTasks.removeValue(forKey: origin)?.cancel()
        self.expiryTasks[origin] = Task { [weak self] in
            do {
                guard let self else { return }
                try await Task.sleep(for: .seconds(max(0, snapshot.session.expiresAt.timeIntervalSince(self.now()))))
            } catch { return }
            guard let self else { return }
            self.invalidate(origin: origin, revision: snapshot.revision)
        }
    }

    private func showAttention(_ route: Route, message: String, id: UUID = UUID(), canSignIn: Bool = true) {
        guard let origin = try? CloudflareAccessOrigin(route.url) else { return }
        self.attention = Attention(
            id: id, origin: origin, stableID: route.stableID, message: message, canSignIn: canSignIn)
    }

    private func client(for route: Route, owner: DiscoveryOwner? = nil) -> CloudflareAccessClient {
        let raw = self.requestFactory(route)
        let deadline = self.requestDeadline
        return CloudflareAccessClient { [weak self] request, maximumBytes in
            guard let url = request.url, let origin = try? CloudflareAccessOrigin(route.url), origin.contains(url)
            else { return try await raw(request, maximumBytes) }
            if let owner {
                guard let self else { throw CancellationError() }
                return try await self.discoveryRequest(request, maximumBytes: maximumBytes, raw: raw, owner: owner)
            }
            return try await deadline(min(15, request.timeoutInterval)) { try await raw(request, maximumBytes) }
        }
    }

    private func discoveryRequest(
        _ request: URLRequest,
        maximumBytes: Int,
        raw: @escaping CloudflareAccessClient.Request,
        owner: DiscoveryOwner) async throws -> (Data, HTTPURLResponse)
    {
        let task = try self.beginRequest(
            request,
            operation: { try await raw($0, maximumBytes) },
            registration: owner.registration,
            origin: owner.snapshot.session.origin,
            revision: owner.snapshot.revision,
            requiresManagedAdmission: owner.requiresManagedAdmission)
        // A deadline cancels without joining. The raw task retains the session and
        // registry entry until settlement; explicit retirement joins that same task.
        defer { task.cancel() }
        return try await withTaskCancellationHandler {
            try await self.requestDeadline(min(15, request.timeoutInterval)) {
                try await withTaskCancellationHandler {
                    let (data, response) = try await task.value
                    guard let http = response as? HTTPURLResponse else { throw CloudflareAccessError.connectionFailed }
                    return (data, http)
                } onCancel: { task.cancel() }
            }
        } onCancel: { task.cancel() }
    }

    nonisolated static func withRequestDeadline(
        seconds: TimeInterval,
        operation: @escaping @Sendable () async throws -> (Data, HTTPURLResponse)) async throws
        -> (Data, HTTPURLResponse)
    {
        try await AsyncTimeout.withTimeout(
            seconds: seconds, onTimeout: { CloudflareAccessError.connectionFailed }, operation: operation)
    }

    nonisolated static func request(for route: Route) -> CloudflareAccessClient.Request {
        { request, maximumBytes in
            guard let url = request.url, let origin = try? CloudflareAccessOrigin(route.url),
                  origin.contains(url)
            else {
                return try await CloudflareAccessClient.send(request, maximumBytes: maximumBytes)
            }
            let tls = route.tls ?? GatewayTLSParams(
                required: true,
                expectedFingerprint: nil,
                allowTOFU: false,
                storeKey: nil)
            let session = GatewayTLSPinningSession(params: tls, allowsRedirects: false, allowsStoredCredentials: false)
            defer { session.finishTasksAndInvalidate() }
            let (data, response): (Data, URLResponse)
            if maximumBytes == 0 {
                (data, response) = try await (Data(), session.response(for: request))
            } else {
                (data, response) = try await session.data(for: request, maximumBytes: maximumBytes)
            }
            guard let http = response as? HTTPURLResponse,
                  http.url == request.url else { throw CloudflareAccessError.connectionFailed }
            return (data, http)
        }
    }
}
