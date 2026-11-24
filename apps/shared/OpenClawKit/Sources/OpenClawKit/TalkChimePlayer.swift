#if os(iOS) || os(macOS)
import AVFoundation

/// Uses the current audio route without changing or activating the app's audio session.
@MainActor
public final class TalkChimePlayer {
    public static let startPreferenceKey = "talk.chimes.start"
    public static let endPreferenceKey = "talk.chimes.end"
    public static let replyPreferenceKey = "talk.chimes.reply"

    /// Cue preferences are opt-out: a device that never stored a key (every install from before
    /// the chimes shipped) reads on, and an explicit stored choice always wins.
    public nonisolated static func isEnabled(_ key: String, in defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: key) as? Bool ?? true
    }

    private var player: AVAudioPlayer?

    public init() {}

    public func stop() {
        self.player?.stop()
        self.player = nil
    }

    public func play(_ cue: TalkChimeLifecycle.Cue) async {
        self.stop()
        guard !Task.isCancelled,
              let url = Bundle.module.url(forResource: "chime_\(cue.rawValue)", withExtension: "caf"),
              let player = try? AVAudioPlayer(contentsOf: url),
              player.play()
        else { return }

        self.player = player
        // Keep capture gated through the output buffer and a short acoustic tail.
        try? await Task.sleep(for: .seconds(player.duration + (cue == .bye ? 0 : 0.2)))
        if self.player === player {
            self.stop()
        }
    }
}
#endif
