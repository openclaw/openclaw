import AppKit

@MainActor
enum WallboardDisplayResolver {
    /// Returns the best available screen for the wallboard.
    /// Preference order: preferred display by localized name → first external (non-main) screen
    /// → `NSScreen.main` → first screen.
    static func resolve(preferredDisplayName: String? = nil,
                        screens: [NSScreen] = NSScreen.screens,
                        mainScreen: NSScreen? = NSScreen.main) -> NSScreen? {
        if let name = preferredDisplayName?.trimmingCharacters(in: .whitespacesAndNewlines),
           !name.isEmpty,
           let match = screens.first(where: { $0.localizedName == name }) {
            return match
        }
        if let external = screens.first(where: { $0 != mainScreen }) {
            return external
        }
        return mainScreen ?? screens.first
    }
}
