import Foundation
import Observation
import OpenClawKit

struct GatewayIngressAuthorization: Sendable {
    typealias Request = @Sendable (URLRequest) async throws -> (Data, URLResponse)
    let origin: CloudflareAccessOrigin
    let revision: UInt64
    let headers: @Sendable (URL) async throws -> [String: String]
    let isCurrent: @MainActor @Sendable () -> Bool
    let checkResponse: @Sendable (HTTPURLResponse) async throws -> Void
    let load: @Sendable (URLRequest, @escaping Request) async throws -> (Data, URLResponse)
}

/// Owns browser interaction and ingress lifetime across node, operator, fleet and native media.
@MainActor
@Observable
final class GatewayIngressController {
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
    }

    private struct Registration: Sendable {
        let id = UUID()
        let route: Route
    }

    private struct MediaRequest {
        let profileID: GatewayStableIdentifier.Key
        let task: Task<(Data, URLResponse), Error>
    }

    private(set) var attention: Attention?
    private(set) var signingIn = false
    @ObservationIgnored private var routes: [GatewayStableIdentifier.Key: Registration] = [:]
    @ObservationIgnored private var expiryTasks: [CloudflareAccessOrigin: Task<Void, Never>] = [:]
    @ObservationIgnored private var blockedRevisions: [CloudflareAccessOrigin: UInt64] = [:]
    @ObservationIgnored private var mediaRequests: [CloudflareAccessOrigin: [UUID: MediaRequest]] =
        [:]
    @ObservationIgnored private var foregroundIntent: (id: UUID, origin: CloudflareAccessOrigin, route: Route)?
    @ObservationIgnored private let browser: any CloudflareAccessBrowserPresenting
    @ObservationIgnored private let persistence: CloudflareAccessSessionStore.Persistence
    @ObservationIgnored private let authenticate: CloudflareAccessSessionStore.Authenticate?
    @ObservationIgnored private let requestFactory: @Sendable (Route) -> CloudflareAccessClient.Request
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
                guard let self, let intent = self.foregroundIntent, intent.origin == application.origin
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
                let requests = self.mediaRequests.removeValue(forKey: origin) ?? [:]
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
        guard let origin = try? CloudflareAccessOrigin(route.url) else { return nil }
        let key = GatewayStableIdentifier.Key(route.stableID)
        let registration = self.routes[key].flatMap { $0.route == route ? $0 : nil } ?? Registration(route: route)
        let changedRoute = self.routes[key].map { $0.id != registration.id } ?? false
        self.routes[key] = registration
        func checkManagedAdmission() throws {
            try self.checkRegistration(registration)
            guard self.sessions.admits(admissionCheckpoint, for: origin) else { throw CancellationError() }
        }
        if changedRoute {
            await self.retireMedia(profileID: key)
            try self.checkRegistration(registration)
        }
        if let previous = profiles().first(where: { $0.id == key })?.accessOrigin, previous != origin {
            // A changed route releases its previous grant only when no sibling
            // profile still owns that origin. Never move a token between origins.
            if !self.profiles().contains(where: { $0.id != key && $0.accessOrigin == previous }) {
                try await self.sessions.forget(previous).value
            }
            try self.checkRegistration(registration)
            guard self.saveProfileOrigin(route.stableID, nil) else { throw CloudflareAccessError.storageFailed }
        }
        let client = self.client(for: route)
        // A cached host grant must not make an independently admitted profile depend
        // on browser sign-out or expiry. Existing service headers and WARP go first.
        let ordinaryChallenge = try await client.discover(
            gatewayURL: route.url,
            customHeaders: self.customHeaders(route.stableID))
        try self.checkRegistration(registration)
        guard let ordinaryChallenge else {
            if GatewayStableIdentifier.matches(self.attention?.stableID, route.stableID) {
                self.attention = nil
            }
            return nil
        }
        try checkManagedAdmission()
        var snapshot = self.sessions.snapshot(for: origin)
        try await self.sessions.waitForRetirement(of: origin)
        try checkManagedAdmission()
        if let snapshot, !self.isCurrent(origin: origin, revision: snapshot.revision) {
            throw GatewayExternalAuthorizationError()
        }
        var application: CloudflareAccessApplication? = ordinaryChallenge
        if let snapshot {
            application = try await client.discover(
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
                try await self.sessions.forget(origin).value
            }
            throw CloudflareAccessError.storageFailed
        }
        if let application {
            self.showAttention(route, message: "Sign in to Cloudflare Access to connect this gateway.")
            if let snapshot {
                self.blockedRevisions[origin] = snapshot.revision
                // prepare runs before physical connection ownership, so it can await the drain.
                // Upgrade/media rejection instead schedules invalidation to avoid joining itself.
                try await self.sessions.requireReauthentication(for: origin, revision: snapshot.revision)
            }
            guard userInitiated else { throw GatewayExternalAuthorizationError() }
            try checkManagedAdmission()
            snapshot = try await self.signIn(application, route: route)
            try checkManagedAdmission()
        }
        // A managed admission must still own its exact revision after browser dismissal.
        guard let snapshot else { throw GatewayExternalAuthorizationError() }
        guard self.sessions.snapshot(for: origin)?.revision == snapshot.revision else {
            throw GatewayExternalAuthorizationError()
        }
        self.blockedRevisions.removeValue(forKey: origin)
        self.scheduleExpiry(snapshot)
        if GatewayStableIdentifier.matches(self.attention?.stableID, route.stableID) {
            self.attention = nil
        }
        return self.authorization(registration: registration, origin: origin, snapshot: snapshot)
    }

    func signIn(for attention: Attention, admissionCheckpoint: UInt64) async throws {
        guard self.attention?.id == attention.id,
              let route = routes[GatewayStableIdentifier.Key(attention.stableID)]?.route
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
        if self.foregroundIntent?.origin == origin {
            self.cancelSignIn()
        }
        let route = Route(url: origin.url, stableID: stableID, tls: nil)
        do {
            try await self.sessions.forget(origin).value
            self.showAttention(
                route,
                message: "Cloudflare Access is signed out for this host. " +
                    "Sign in to reconnect gateways using this Access session.")
        } catch {
            self.showAttention(route, message: error.localizedDescription)
        }
    }

    func forget(stableID: String) async throws {
        let key = GatewayStableIdentifier.Key(stableID)
        let registration = self.routes.removeValue(forKey: key)
        let saved = self.profiles().first { $0.id == key }?.accessOrigin
        let origins = Set([registration.flatMap { try? CloudflareAccessOrigin($0.route.url) }, saved]
            .compactMap(\.self))
        if GatewayStableIdentifier.matches(self.foregroundIntent?.route.stableID, stableID) {
            self.cancelSignIn()
        }
        // Fence this profile and last-owner admissions before either drain. Siblings
        // retain their capabilities when they still own the shared origin.
        let retirements = origins.filter { origin in
            !self.profiles().contains(where: { $0.id != key && $0.accessOrigin == origin })
        }.map { origin in (origin, self.sessions.forget(origin)) }
        await self.retireMedia(profileID: key)
        for (origin, retirement) in retirements {
            try await retirement.value
            self.blockedRevisions.removeValue(forKey: origin)
        }
        if saved != nil, !self.saveProfileOrigin(stableID, nil) {
            throw CloudflareAccessError.storageFailed
        }
        if GatewayStableIdentifier.matches(self.attention?.stableID, stableID) {
            self.attention = nil
        }
    }

    private func retireMedia(profileID: GatewayStableIdentifier.Key) async {
        var pending: [Task<(Data, URLResponse), Error>] = []
        for (origin, requests) in self.mediaRequests {
            for (id, request) in requests where request.profileID == profileID {
                self.mediaRequests[origin]?.removeValue(forKey: id)
                request.task.cancel()
                pending.append(request.task)
            }
        }
        for task in pending {
            _ = await task.result
        }
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

    func cancelSignIn() {
        guard let intent = foregroundIntent else { return }
        self.foregroundIntent = nil
        self.sessions.cancelSignIn(for: intent.origin)
        self.signingIn = false
        self.showAttention(intent.route, message: "Sign-in was canceled. Choose Sign in to try again.")
        Task { await self.browser.dismiss(intentID: intent.id) }
    }

    func forget(origin: CloudflareAccessOrigin) async throws {
        if self.foregroundIntent?.origin == origin {
            self.cancelSignIn()
        }
        self.routes = self.routes.filter { (try? CloudflareAccessOrigin($0.value.route.url)) != origin }
        try await self.sessions.forget(origin).value
        self.blockedRevisions.removeValue(forKey: origin)
        if self.attention?.origin == origin {
            self.attention = nil
        }
    }

    func foregrounded() {
        // Timers may have been suspended by iOS; reading the store expires grants at this boundary.
        for registration in self.routes.values {
            let route = registration.route
            guard let origin = try? CloudflareAccessOrigin(route.url) else { continue }
            if let snapshot = sessions.snapshot(for: origin) {
                self.scheduleExpiry(snapshot)
            } else if self.sessions.state(for: origin) == .reauthenticationRequired {
                self.showAttention(route, message: "Cloudflare Access expired. Sign in again to reconnect.")
            }
        }
    }

    private func signIn(
        _ application: CloudflareAccessApplication,
        route: Route) async throws -> CloudflareAccessSessionStore
        .Snapshot
    {
        if self.foregroundIntent?.origin != application.origin {
            self.cancelSignIn()
        }
        let intentID = self.foregroundIntent?.id ?? UUID()
        if self.foregroundIntent == nil {
            self.foregroundIntent = (intentID, application.origin, route)
        }
        self.signingIn = true
        let task = self.sessions.signIn(application: application) { [weak self] url in
            guard let self, self.foregroundIntent?.id == intentID else { throw CancellationError() }
            try await self.browser.open(url, intentID: intentID) { [weak self] in
                guard self?.foregroundIntent?.id == intentID else { return }
                self?.cancelSignIn()
            }
        }
        do {
            let snapshot = try await withTaskCancellationHandler {
                try await task.value
            } onCancel: {
                Task { @MainActor [weak self] in
                    guard self?.foregroundIntent?.id == intentID else { return }
                    self?.cancelSignIn()
                }
            }
            try Task.checkCancellation()
            guard self.foregroundIntent?.id == intentID else { throw CancellationError() }
            self.foregroundIntent = nil
            self.signingIn = false
            self.blockedRevisions.removeValue(forKey: application.origin)
            await self.browser.dismiss(intentID: intentID)
            return snapshot
        } catch {
            if self.foregroundIntent?.id == intentID {
                self.foregroundIntent = nil
                self.signingIn = false
                self.showAttention(route, message: error.localizedDescription)
                await self.browser.dismiss(intentID: intentID)
            }
            throw error
        }
    }

    private func authorization(
        registration: Registration,
        origin: CloudflareAccessOrigin,
        snapshot: CloudflareAccessSessionStore.Snapshot) -> GatewayIngressAuthorization
    {
        let revision = snapshot.revision
        return GatewayIngressAuthorization(
            origin: origin,
            revision: revision,
            headers: { [weak self] url in
                guard let self else { throw CancellationError() }
                return try await self.headers(for: url, registration: registration, origin: origin, revision: revision)
            },
            isCurrent: { [weak self] in
                self?.isCurrent(registration: registration, origin: origin, revision: revision) == true
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
        let id = UUID()
        let task = Task { try await operation(request) }
        self.mediaRequests[origin, default: [:]][id] = MediaRequest(
            profileID: GatewayStableIdentifier.Key(registration.route.stableID),
            task: task)
        defer { self.mediaRequests[origin]?.removeValue(forKey: id) }
        let result = try await withTaskCancellationHandler {
            try await task.value
        } onCancel: { task.cancel() }
        try Task.checkCancellation()
        guard self.isCurrent(registration: registration, origin: origin, revision: revision)
        else { throw GatewayExternalAuthorizationError() }
        return result
    }

    private func isCurrent(registration: Registration, origin: CloudflareAccessOrigin, revision: UInt64) -> Bool {
        self.routes[GatewayStableIdentifier.Key(registration.route.stableID)]?.id == registration.id &&
            self.isCurrent(origin: origin, revision: revision)
    }

    private func isCurrent(origin: CloudflareAccessOrigin, revision: UInt64) -> Bool {
        let current = self.sessions.snapshot(for: origin)?.revision ?? 0
        return current == revision && self.blockedRevisions[origin] != revision
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
        let snapshot = self.sessions.snapshot(for: origin)
        let route = registration.route
        let custom = self.customHeaders(route.stableID)
        let application = try await client(for: route).discover(
            gatewayURL: route.url,
            session: snapshot?.session,
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
        if let token = snapshot?.session.authorizationHeader(for: url, now: now()) {
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
        self.blockedRevisions[origin] = revision
        if let route = route ?? routes.values.map(\.route).sorted(by: { $0.stableID < $1.stableID })
            .first(where: { origin.contains($0.url) })
        {
            self.showAttention(
                route,
                message: "Cloudflare Access needs sign-in again. Open Gateway settings to continue.")
        }
        // Never await teardown from an upgrade/media task: retirement joins those same tasks.
        Task { [weak self] in
            guard let self else { return }
            try? await self.sessions.requireReauthentication(for: origin, revision: revision)
        }
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

    private func showAttention(_ route: Route, message: String) {
        guard let origin = try? CloudflareAccessOrigin(route.url) else { return }
        self.attention = Attention(id: UUID(), origin: origin, stableID: route.stableID, message: message)
    }

    private func client(for route: Route) -> CloudflareAccessClient {
        CloudflareAccessClient(request: self.requestFactory(route))
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
            let (data, response) = try await AsyncTimeout.withTimeout(
                seconds: min(15, request.timeoutInterval),
                onTimeout: { CloudflareAccessError.connectionFailed },
                operation: {
                    if maximumBytes == 0 {
                        return try await (Data(), session.response(for: request))
                    }
                    return try await session.data(for: request, maximumBytes: maximumBytes)
                })
            guard let http = response as? HTTPURLResponse,
                  http.url == request.url else { throw CloudflareAccessError.connectionFailed }
            return (data, http)
        }
    }
}
