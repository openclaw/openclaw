import Foundation
import OpenClawKit

extension ProcessInfo {
    var isPreview: Bool {
        guard let raw = getenv("XCODE_RUNNING_FOR_PREVIEWS") else { return false }
        return String(cString: raw) == "1"
    }

    static func resolveStableNixSuiteName(bundleIdentifier: String?, isAppBundle: Bool) -> String? {
        // The app's own defaults domain is already represented by AppDefaults.standard.
        // Passing that same identifier to suiteName triggers Foundation's nonsensical-suite warning.
        guard isAppBundle, bundleIdentifier != launchdLabel else { return nil }
        return launchdLabel
    }

    /// Nix deployments may write defaults into a stable suite (`ai.openclaw.mac`) even if the shipped
    /// app bundle identifier changes (and therefore `AppDefaults.standard` domain changes).
    static func resolveNixMode(
        environment: [String: String],
        standard: UserDefaults,
        stableSuite: UserDefaults?,
        isAppBundle: Bool) -> Bool
    {
        // Only consult the stable suite when running as a .app bundle.
        // This avoids local developer machines accidentally influencing unit tests.
        environment["OPENCLAW_NIX_MODE"] == "1" || standard.bool(forKey: "openclaw.nixMode") ||
            (isAppBundle && stableSuite?.bool(forKey: "openclaw.nixMode") == true)
    }

    var isNixMode: Bool {
        let isAppBundle = Bundle.main.bundleURL.pathExtension == "app"
        let stableSuite = Self.resolveStableNixSuiteName(
            bundleIdentifier: Bundle.main.bundleIdentifier,
            isAppBundle: isAppBundle).flatMap { UserDefaults(suiteName: $0) }
        return Self.resolveNixMode(
            environment: self.environment,
            standard: AppDefaults.standard,
            stableSuite: stableSuite,
            isAppBundle: isAppBundle)
    }

    var isRunningTests: Bool {
        OpenClawProcessInfo.isRunningTests
    }
}
