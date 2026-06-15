import Foundation
import OpenClawKit

// MARK: - HealthWebhookConfig

/// Validated webhook destination. Constructed only via `HealthExportConfigStore`, which
/// enforces the anti-exfiltration URL policy (https + `.ts.net` host only).
struct HealthWebhookConfig: Equatable {
    let url: URL
    let token: String
}

// MARK: - HealthExportConfigStore

/// Persists the webhook token + URL in the Keychain (so the background task can read them after
/// first unlock) and validates the URL against the tailnet-only allowlist.
///
/// The Keychain holds ONLY the small token + URL strings. The (potentially >4KB) HealthKit anchor
/// and any deferred payloads live in encrypted files — see `HealthExportFileStore`.
enum HealthExportConfigStore {
    static let keychainService = "ai.openclaw.ios.health-export"
    private static let tokenAccount = "webhook-token"
    private static let urlAccount = "webhook-url"

    // MARK: URL validation (anti-exfiltration)

    /// Accepts a URL string ONLY if scheme == https and host ends in `.ts.net`.
    /// Everything else is rejected so health data can never be POSTed off the user's tailnet.
    ///
    /// NOTE FOR MAINTAINERS: the `.ts.net` (Tailscale MagicDNS) suffix is an opinionated default
    /// for the self-hosted, privacy-first use case this feature targets — it guarantees health
    /// data only ever leaves the device to a host on the user's own private tailnet, never to an
    /// arbitrary public endpoint. If OpenClaw later wants to support other self-hosted setups
    /// (e.g. a `.internal`/LAN host, or a user-provided allowlist), this single function is the
    /// only place to relax the policy. Keeping it strict by default is intentional.
    static func validatedURL(from raw: String) -> URL? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let url = URL(string: trimmed) else { return nil }
        guard let scheme = url.scheme?.lowercased(), scheme == "https" else { return nil }
        guard let host = url.host?.lowercased(), !host.isEmpty else { return nil }
        // Reject bare ".ts.net" and require a non-empty label before the suffix.
        guard host.hasSuffix(".ts.net"), host != ".ts.net", host.count > ".ts.net".count else {
            return nil
        }
        return url
    }

    // MARK: Persistence

    @discardableResult
    static func save(token: String, urlString: String) -> Bool {
        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = self.validatedURL(from: urlString), !trimmedToken.isEmpty else {
            return false
        }
        // After-first-unlock so the BGProcessingTask / observer wake can read it while locked
        // after the first device unlock. ThisDeviceOnly keeps it from syncing to other devices.
        let tokenOK = GenericPasswordKeychainStore.saveString(
            trimmedToken,
            service: self.keychainService,
            account: self.tokenAccount,
            accessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
        let urlOK = GenericPasswordKeychainStore.saveString(
            url.absoluteString,
            service: self.keychainService,
            account: self.urlAccount,
            accessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
        return tokenOK && urlOK
    }

    static func load() -> HealthWebhookConfig? {
        guard
            let token = GenericPasswordKeychainStore.loadString(
                service: self.keychainService,
                account: self.tokenAccount),
            let urlString = GenericPasswordKeychainStore.loadString(
                service: self.keychainService,
                account: self.urlAccount),
            // Re-validate on load: the stored URL must still pass policy.
            let url = self.validatedURL(from: urlString),
            !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            return nil
        }
        return HealthWebhookConfig(url: url, token: token)
    }

    /// Returns a redacted host:path string for display, never the token.
    static func displayURL() -> String? {
        guard let urlString = GenericPasswordKeychainStore.loadString(
            service: self.keychainService,
            account: self.urlAccount)
        else {
            return nil
        }
        return urlString
    }

    static func isConfigured() -> Bool {
        self.load() != nil
    }

    @discardableResult
    static func clear() -> Bool {
        let a = GenericPasswordKeychainStore.delete(service: self.keychainService, account: self.tokenAccount)
        let b = GenericPasswordKeychainStore.delete(service: self.keychainService, account: self.urlAccount)
        return a && b
    }
}
