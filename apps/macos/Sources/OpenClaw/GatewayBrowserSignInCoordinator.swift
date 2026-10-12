import AppKit
import Foundation
import OpenClawKit
import OSLog

@MainActor
final class GatewayBrowserSignInCoordinator {
    static let shared = GatewayBrowserSignInCoordinator()
    private static let logger = Logger(subsystem: "ai.openclaw", category: "gateway.browser-sign-in")
    private var renewals: [String: Task<Void, Never>] = [:]
    private var observers: [NSObjectProtocol] = []
    private var periodicCheck: Task<Void, Never>?

    static var userIsPresent: Bool {
        NSApplication.shared.isActive && (SystemPresenceInfo.lastHardwareInputSeconds() ?? .max) < 5 * 60
    }

    func start() {
        guard self.observers.isEmpty else { return }
        self.observers = [NSApplication.didBecomeActiveNotification, NSWindow.didBecomeKeyNotification].map { name in
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in await self?.checkForRenewal() }
            }
        }
        self.periodicCheck = Task { [weak self] in
            while !Task.isCancelled {
                await self?.checkForRenewal()
                // A third of the shortest (15-minute) window, which also catches a return from idle.
                do { try await Task.sleep(for: .seconds(5 * 60)) } catch { return }
            }
        }
    }

    func checkForRenewal() async {
        guard Self.userIsPresent else { return }
        let bound = await MacGatewayConnectionFleet.shared.boundProfileIDs()
        let open = Set(DashboardManager.shared.dashboardControllers().compactMap { instance -> String? in
            guard instance.controller.isWindowOpen, case let .profile(id) = instance.target else { return nil }
            return id
        })
        for id in bound.union(open).sorted() {
            guard Self.userIsPresent else { return }
            guard self.renewals[id] == nil,
                  let (profile, attempt) = await MacGatewayProfileStore.shared.beginAutomaticBrowserRenewal(
                      profileID: id, now: Date(), userPresent: Self.userIsPresent, inUse: true)
            else { continue }
            let progress = GatewayBrowserSignInProgress()
            self.renewals[id] = Task { [weak self] in
                defer { self?.renewals[id] = nil }
                do {
                    _ = try await Self.finishSignIn(
                        name: profile.name,
                        token: "",
                        password: "",
                        attempt: attempt,
                        progress: progress,
                        automatic: true)
                    if let connection = await MacGatewayConnectionFleet.shared.existingConnection(profileID: id) {
                        _ = try await connection.acquireServerLease()
                    }
                    Self.logger.info("automatic browser renewal completed profile=\(id, privacy: .public)")
                } catch {
                    // URLs and localized helper errors can carry private sign-in material.
                    let outcome = switch error {
                    case is CancellationError, GatewayBrowserSessionError.superseded: "cancelled or superseded"
                    case CloudflareAccessLogin.LoginError.timedOut: "timed out"
                    default: "failed"
                    }
                    Self.logger.info(
                        "automatic browser renewal \(outcome, privacy: .public) profile=\(id, privacy: .public)")
                }
            }
        }
    }

    private func cancelAutomaticRenewal(profileID: String) async {
        guard let task = self.renewals[profileID] else { return }
        task.cancel()
        // Join cloudflared before a user-owned attempt starts its replacement helper.
        await task.value
    }

    nonisolated static func reconnectGateway(id: String, progress: GatewayBrowserSignInProgress) async throws {
        let profiles = try await MacGatewayProfileStore.shared.catalogProfiles(retryKeychainAccess: true)
        guard let profile = profiles.first(where: { $0.profile.id == id }) else {
            throw MacGatewayProfileError.profileNotFound
        }
        try Task.checkCancellation()
        if profile.usesBrowserIdentity {
            _ = try await GatewayBrowserSignInCoordinator.connect(
                name: profile.profile.name,
                address: profile.profile.url.absoluteString,
                token: "",
                password: "",
                progress: progress)
        } else {
            let binding = try await MacGatewayConnectionFleet.shared.binding(profileID: id)
            try Task.checkCancellation()
            await binding.connection.shutdown(ifCurrent: { !Task.isCancelled })
            try Task.checkCancellation()
            _ = try await binding.connection.acquireServerLease()
        }
    }

    nonisolated static func gatewayURL(from address: String) throws -> URL {
        let address = address.trimmingCharacters(in: .whitespacesAndNewlines)
        let input = address.contains("://") ? address : "https://\(address)"
        guard !address.isEmpty,
              let components = URLComponents(string: input),
              ["https", "http", "wss", "ws"].contains(components.scheme?.lowercased() ?? ""),
              let link = GatewayConnectDeepLink.fromSetupInput(input),
              let url = link.websocketURL
        else { throw MacGatewayProfileError.invalidURL }
        return try MacGatewayProfileStore.canonicalURL(url)
    }

    nonisolated static func connect(
        name: String,
        address: String,
        token: String,
        password: String,
        progress: GatewayBrowserSignInProgress) async throws -> MacGatewayProfile
    {
        let url = try self.gatewayURL(from: address)
        let store = MacGatewayProfileStore.shared
        await self.shared.cancelAutomaticRenewal(profileID: MacGatewayProfileStore.profileID(url: url))
        let attempt = try await store.beginBrowserSignIn(url: url)
        return try await self.finishSignIn(
            name: name, token: token, password: password, attempt: attempt, progress: progress, automatic: false)
    }

    private nonisolated static func finishSignIn(
        name: String,
        token: String,
        password: String,
        attempt: MacGatewayProfileStore.BrowserSignInAttempt,
        progress: GatewayBrowserSignInProgress,
        automatic: Bool) async throws -> MacGatewayProfile
    {
        let store = MacGatewayProfileStore.shared
        let url = attempt.url
        await MainActor.run { progress.gatewayHost = url.host ?? "" }
        return try await withTaskCancellationHandler {
            do {
                try Task.checkCancellation()
                let hasCredentials = token.nonEmpty != nil || password.nonEmpty != nil
                if !hasCredentials, url.scheme == "wss" {
                    guard var browserURL = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
                        throw MacGatewayProfileError.invalidURL
                    }
                    browserURL.scheme = "https"
                    guard let discoveryURL = browserURL.url else { throw MacGatewayProfileError.invalidURL }
                    if let application = try await CloudflareAccessLogin.discover(gatewayURL: discoveryURL) {
                        // An automatic renewal must not open a browser once the user has left.
                        if automatic, await !Self.userIsPresent { throw CancellationError() }
                        let session = try await CloudflareAccessLogin.signIn(
                            application: application, attempt: attempt, progress: progress)
                        try Task.checkCancellation()
                        return try await store.saveBrowserSession(
                            name: name, session: session, attempt: attempt, renewingOnly: automatic)
                    }
                }
                try Task.checkCancellation()
                guard !automatic else { throw CloudflareAccessLogin.LoginError.invalidApplication }
                return try await store.saveConnection(name: name, token: token, password: password, attempt: attempt)
            } catch {
                await store.cancelBrowserSignIn(attempt)
                throw error
            }
        } onCancel: {
            // Retained native actions must stop synchronously, before actor cleanup can resume.
            attempt.revoke()
        }
    }
}
