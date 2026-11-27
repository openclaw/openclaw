#if os(iOS) || os(macOS)
import AVFoundation

/// Uses the current audio route without changing or activating the app's audio session.
@MainActor
public final class TalkChimePlayer {
    public static let startPreferenceKey = "talk.chimes.start"
    public static let endPreferenceKey = "talk.chimes.end"
    public static let replyPreferenceKey = "talk.chimes.reply"

    /// Cue preferences are opt-out: a device that never stored a key (every install from before
    /// the chimes shipped) reads on, and an explicit stored choice always wins. A device that
    /// explicitly turned off `inheritingOptOutFrom` (macOS "Phase sounds") and never stored the
    /// key reads off. Reading never writes.
    public nonisolated static func isEnabled(
        _ key: String,
        in defaults: UserDefaults = .standard,
        inheritingOptOutFrom legacyKey: String? = nil) -> Bool
    {
        if let stored = defaults.object(forKey: key) as? Bool { return stored }
        if let legacyKey, defaults.object(forKey: legacyKey) as? Bool == false { return false }
        return true
    }

    private final class Completion: NSObject, AVAudioPlayerDelegate {
        let finished: @Sendable () -> Void

        init(finished: @escaping @Sendable () -> Void) {
            self.finished = finished
        }

        func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
            self.finished()
        }

        func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: (any Error)?) {
            self.finished()
        }
    }

    private var player: AVAudioPlayer?
    private var playbackCompletion: Completion?

    public init() {}

    public func stop() {
        self.player?.stop()
        self.player = nil
        let completion = self.playbackCompletion
        self.playbackCompletion = nil
        completion?.finished()
    }

    public func play(
        _ cue: TalkChimeLifecycle.Cue,
        onPlaybackFinished: (@Sendable () -> Void)? = nil) async
    {
        self.stop()
        guard !Task.isCancelled,
              let url = Bundle.module.url(forResource: "chime_\(cue.rawValue)", withExtension: "caf"),
              let player = try? AVAudioPlayer(contentsOf: url)
        else { return }

        if let onPlaybackFinished {
            let signal = AsyncStream<Void>.makeStream()
            let completion = Completion {
                onPlaybackFinished()
                signal.continuation.finish()
            }
            self.playbackCompletion = completion
            player.delegate = completion
            self.player = player
            if player.play() {
                // An interrupted player may never deliver its completion callback.
                let timeout = Task {
                    try await Task.sleep(for: .seconds(player.duration + 0.2))
                    if self.player === player { self.stop() }
                }
                for await _ in signal.stream {}
                timeout.cancel()
            }
        } else {
            guard player.play() else { return }
            self.player = player
            // Realtime routes keep their existing acoustic tail.
            try? await Task.sleep(for: .seconds(player.duration + (cue == .bye ? 0 : 0.2)))
        }
        if self.player === player {
            self.stop()
        }
    }
}
#endif
