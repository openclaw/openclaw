import AppKit
import Foundation
import OSLog

enum VoiceWakeChime: Codable, Equatable, Sendable {
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
    static let systemOptions: [String] = {
        let discovered = Self.discoveredSoundMap.keys
        let fallback: [String] = [
            "Glass", // default
            "Ping",
            "Pop",
            "Frog",
            "Submarine",
            "Funk",
            "Tink",
            "Basso",
            "Blow",
            "Bottle",
            "Hero",
            "Morse",
            "Purr",
            "Sosumi",
            "Mail Sent",
            "New Mail",
            "Mail Scheduled",
            "Mail Fetch Error",
        ]

        // Keep Glass first, then present the rest alphabetically without duplicates.
        var names = Set(discovered).union(fallback)
        names.remove("Glass")
        let sorted = names.sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
        return ["Glass"] + sorted
    }()

    static func displayName(for raw: String) -> String {
        return raw
    }

    static func url(for name: String) -> URL? {
        return self.discoveredSoundMap[name]
    }

    private static let allowedExtensions: Set<String> = [
        "aif", "aiff", "caf", "wav", "m4a", "mp3",
    ]

    private static let searchRoots: [URL] = [
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Sounds"),
        URL(fileURLWithPath: "/Library/Sounds"),
        URL(fileURLWithPath: "/System/Applications/Mail.app/Contents/Resources"), // Mail “swoosh”
        URL(fileURLWithPath: "/System/Library/Sounds"),
    ]

    private static let discoveredSoundMap: [String: URL] = {
        var map: [String: URL] = [:]
        for root in self.searchRoots {
            guard let contents = try? FileManager.default.contentsOfDirectory(
                at: root,
                includingPropertiesForKeys: nil,
                options: [.skipsHiddenFiles])
            else { continue }

            for url in contents where self.allowedExtensions.contains(url.pathExtension.lowercased()) {
                let name = url.deletingPathExtension().lastPathComponent
                // Preserve the first match in priority order.
                if map[name] == nil {
                    map[name] = url
                }
            }
        }
        return map
    }()
}

@MainActor
enum VoiceWakeChimePlayer {
    private static let logger = Logger(subsystem: "com.steipete.clawdis", category: "voicewake.chime")
    private static var lastSound: NSSound?

    @MainActor
    static func play(_ chime: VoiceWakeChime) {
        guard let sound = self.sound(for: chime) else { return }
        self.logger.log(level: .info, "chime play type=\(String(describing: chime), privacy: .public) name=\(sound.name ?? "", privacy: .public)")
        self.lastSound = sound
        sound.stop()
        sound.play()
    }

    private static func sound(for chime: VoiceWakeChime) -> NSSound? {
        switch chime {
        case .none:
            return nil
        case let .system(name):
            if let named = NSSound(named: NSSound.Name(name)) {
                return named
            }
            if let url = VoiceWakeChimeCatalog.url(for: name) {
                return NSSound(contentsOf: url, byReference: false)
            }
            return nil

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
