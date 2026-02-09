import Foundation

/// Nix deployments may write macOS defaults into a stable suite (e.g. `ai.openclaw.mac`)
/// even when the shipped app bundle identifier (and therefore `UserDefaults.standard` domain)
/// differs.
///
/// When running in Nix mode, copy selected keys from the stable suite into
/// `UserDefaults.standard` so the rest of the app can keep using standard defaults.
@MainActor
enum NixDefaultsBridge {
    private static let keysToBridge: [String] = [
        "openclaw.nixMode",
        showDockIconKey,
        "openclaw.gateway.attachExistingOnly",
        "gatewayPort",
    ]

    static func applyIfNeeded() {
        guard ProcessInfo.processInfo.isNixMode else { return }
        guard let nixSuite = UserDefaults(suiteName: nixDefaultsSuiteName) else { return }

        for key in self.keysToBridge {
            guard let value = nixSuite.object(forKey: key) else { continue }
            UserDefaults.standard.set(value, forKey: key)
        }
    }
}
