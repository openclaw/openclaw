import Foundation

/// Single reader and writer of the node capability preferences that gate advertised and invoked commands.
enum NodeCapabilityPreferences {
    static let cameraEnabledKey = "camera.enabled"
    private static let onboardingCompleteKey = "gateway.onboardingComplete"

    /// Resolves once and persists. A missing value means the app predates this preference or is freshly installed:
    /// installs that already completed onboarding keep camera on so an update does not change behavior, and fresh
    /// installs start off. Mirrors Android `SecurePrefs.loadCameraEnabled`, which keys on pre-existing prefs.
    static func isCameraEnabled(defaults: UserDefaults = .standard) -> Bool {
        if let stored = defaults.object(forKey: self.cameraEnabledKey) as? Bool { return stored }
        let migrated = defaults.bool(forKey: self.onboardingCompleteKey)
        defaults.set(migrated, forKey: self.cameraEnabledKey)
        return migrated
    }

    static func setCameraEnabled(_ enabled: Bool, defaults: UserDefaults = .standard) {
        defaults.set(enabled, forKey: self.cameraEnabledKey)
    }
}
