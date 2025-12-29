import AVFoundation
import Foundation
import OSLog

@MainActor
final class TalkAudioPlayer: NSObject, @preconcurrency AVAudioPlayerDelegate {
    static let shared = TalkAudioPlayer()

    private let logger = Logger(subsystem: "com.steipete.clawdis", category: "talk.tts")
    private var player: AVAudioPlayer?
    private var continuation: CheckedContinuation<TalkPlaybackResult, Never>?

    func play(data: Data) async -> TalkPlaybackResult {
        self.stopInternal(interrupted: true)
        do {
            let player = try AVAudioPlayer(data: data)
            self.player = player
            player.delegate = self
            player.prepareToPlay()
            player.play()
            return await withCheckedContinuation { continuation in
                self.continuation = continuation
            }
        } catch {
            self.logger.error("talk audio player failed: \(error.localizedDescription, privacy: .public)")
            return TalkPlaybackResult(finished: false, interruptedAt: nil)
        }
    }

    func stop() -> Double? {
        guard let player else { return nil }
        let time = player.currentTime
        self.stopInternal(interrupted: true, interruptedAt: time)
        return time
    }

    func audioPlayerDidFinishPlaying(_: AVAudioPlayer, successfully flag: Bool) {
        self.stopInternal(interrupted: !flag)
    }

    private func stopInternal(interrupted: Bool, interruptedAt: Double? = nil) {
        self.player?.stop()
        self.player = nil
        if let continuation {
            self.continuation = nil
            continuation.resume(returning: TalkPlaybackResult(finished: !interrupted, interruptedAt: interruptedAt))
        }
    }
}

struct TalkPlaybackResult: Sendable {
    let finished: Bool
    let interruptedAt: Double?
}
