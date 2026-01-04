import Foundation

extension ProcessInfo {
    var isPreview: Bool {
        self.environment["XCODE_RUNNING_FOR_PREVIEWS"] == "1"
    }

    var isNixMode: Bool {
        if self.environment["CLAWDBOT_NIX_MODE"] == "1" { return true }
        return UserDefaults.standard.bool(forKey: "clawdbot.nixMode")
    }

    var isRunningTests: Bool {
        // SwiftPM tests load one or more `.xctest` bundles. With Swift Testing, `Bundle.main` is not
        // guaranteed to be the `.xctest` bundle, so check all loaded bundles.
        if Bundle.allBundles.contains(where: { $0.bundleURL.pathExtension == "xctest" }) { return true }
        if Bundle.main.bundleURL.pathExtension == "xctest" { return true }

        // Backwards-compatible fallbacks for runners that still set XCTest env vars.
        return self.environment["XCTestConfigurationFilePath"] != nil
            || self.environment["XCTestBundlePath"] != nil
            || self.environment["XCTestSessionIdentifier"] != nil
    }
}
