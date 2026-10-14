import AppKit
import Foundation
import OSLog

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
    private static let logger = Logger(subsystem: "ai.openclaw", category: "voicewake.chime")

    static func play(_ chime: VoiceWakeChime, reason: String) {
        let sound: NSSound? = switch chime {
        case .none: nil
        case let .system(name): SoundEffectPlayer.sound(named: name)
        case let .custom(_, bookmark): SoundEffectPlayer.sound(from: bookmark)
        }
        guard let sound else { return }
        self.logger.log(level: .info, "chime play reason=\(reason, privacy: .public)")
        DiagnosticsFileLog.shared.log(category: "voicewake.chime", event: "play", fields: [
            "reason": reason,
            "chime": chime.displayLabel,
            "systemName": chime.systemName ?? "",
        ])
        SoundEffectPlayer.play(sound)
    }
}
