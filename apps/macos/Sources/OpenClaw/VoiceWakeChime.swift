import AppKit
import Foundation

enum VoiceWakeChime: Codable, Equatable {
    case none
    case system(name: String)
    case custom(displayName: String, bookmark: Data)

    var displayLabel: String {
        switch self {
        case .none:
            "No Sound"
        case let .system(name):
            name
        case let .custom(displayName, _):
            displayName
        }
    }
}

@MainActor
enum VoiceWakeChimePlayer {
    static func play(_ chime: VoiceWakeChime) {
        let sound: NSSound? = switch chime {
        case .none: nil
        case let .system(name): SoundEffectPlayer.sound(named: name)
        case let .custom(_, bookmark): SoundEffectPlayer.sound(from: bookmark)
        }
        guard let sound else { return }
        SoundEffectPlayer.play(sound)
    }
}
