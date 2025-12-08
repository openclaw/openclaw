import AppKit
import Foundation

enum VoiceWakeChime: Codable, Equatable {
    case none
    case system(name: String)
    case custom(displayName: String, bookmark: Data)

    var systemName: String? {
        if case let .system(name) = self {
            return name
        }
        return nil
    }

    var displayLabel: String {
        switch self {
        case .none:
            return "No Sound"
        case let .system(name):
            return VoiceWakeChimeCatalog.displayName(for: name)
        case let .custom(displayName, _):
            return displayName
        }
    }
}

struct VoiceWakeChimeCatalog {
    /// Options shown in the picker.
    static let systemOptions: [String] = [
        "Glass", // default
        "Ping",
        "Pop",
        "Frog",
        "Submarine",
        "Funk",
        "Tink",
    ]

    static func displayName(for raw: String) -> String {
        return raw
    }
}

enum VoiceWakeChimePlayer {
    @MainActor
    static func play(_ chime: VoiceWakeChime) {
        guard let sound = self.sound(for: chime) else { return }
        sound.play()
    }

    private static func sound(for chime: VoiceWakeChime) -> NSSound? {
        switch chime {
        case .none:
            return nil
        case let .system(name):
            return NSSound(named: NSSound.Name(name))

        case let .custom(_, bookmark):
            var stale = false
            guard let url = try? URL(
                resolvingBookmarkData: bookmark,
                options: [.withoutUI, .withSecurityScope],
                bookmarkDataIsStale: &stale)
            else { return nil }

            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            return NSSound(contentsOf: url, byReference: false)
        }
    }
}
