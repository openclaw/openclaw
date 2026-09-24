import Foundation
import OpenClawKit

enum GatewayBrowserSignInCoordinator {
    static func reconnectGateway(id: String, progress: GatewayBrowserSignInProgress) async throws {
        let profiles = try await MacGatewayProfileStore.shared.catalogProfiles()
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

    static func gatewayURL(from address: String) throws -> URL {
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

    static func connect(
        name: String,
        address: String,
        token: String,
        password: String,
        progress: GatewayBrowserSignInProgress) async throws -> MacGatewayProfile
    {
        let url = try self.gatewayURL(from: address)
        let store = MacGatewayProfileStore.shared
        let attempt = try await store.beginBrowserSignIn(url: url)
        await MainActor.run { progress.gatewayHost = url.host ?? "" }
        return try await withTaskCancellationHandler {
            do {
                try Task.checkCancellation()
                let hasCredentials = !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                    !password.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                if !hasCredentials, url.scheme == "wss" {
                    guard var browserURL = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
                        throw MacGatewayProfileError.invalidURL
                    }
                    browserURL.scheme = "https"
                    guard let discoveryURL = browserURL.url else { throw MacGatewayProfileError.invalidURL }
                    if let application = try await CloudflareAccessLogin.discover(gatewayURL: discoveryURL) {
                        let session = try await CloudflareAccessLogin.signIn(
                            application: application, attempt: attempt, progress: progress)
                        try Task.checkCancellation()
                        return try await store.saveBrowserSession(name: name, session: session, attempt: attempt)
                    }
                }
                try Task.checkCancellation()
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
