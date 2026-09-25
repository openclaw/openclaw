import Foundation
import OpenClawKit

/// Owns the classic Talk PCM producer, device playback, and its UI envelope.
/// Realtime Talk injects its duplex graph into the same bounded player separately.
@MainActor
final class TalkPCMPlayback {
    static let shared = TalkPCMPlayback(
        player: RealtimePCMStreamingAudioPlayer(),
        onLevel: { TalkModeController.shared.updateSpeakingLevel($0) })

    private let player: any PCMStreamingAudioPlaying
    private let onLevel: @MainActor (Double?) -> Void
    private var envelope: PCMPlaybackEnvelope?
    private var generation: UInt64 = 0

    init(player: any PCMStreamingAudioPlaying, onLevel: @escaping @MainActor (Double?) -> Void) {
        self.player = player
        self.onLevel = onLevel
    }

    func play(stream: AsyncThrowingStream<Data, Error>, sampleRate: Double) async -> StreamingPlaybackResult {
        guard !Task.isCancelled else { return .init(finished: false, interruptedAt: nil) }
        _ = self.stop()
        let generation = self.generation
        let envelope = PCMPlaybackEnvelope { [weak self] level in
            guard let self, self.generation == generation else { return }
            self.onLevel(level)
        }
        self.envelope = envelope
        let metered = envelope.metering(stream, sampleRate: sampleRate)
        return await withTaskCancellationHandler {
            let result = await self.player.play(stream: metered, sampleRate: sampleRate)
            // A stopped call can return after replacement playback has begun.
            // Its private envelope must never clear the successor's meter.
            if self.generation == generation {
                self.envelope = nil
                envelope.cancel()
            }
            return result
        } onCancel: {
            Task { @MainActor [weak self] in
                guard let self, self.generation == generation else { return }
                _ = self.stop()
            }
        }
    }

    @discardableResult
    func stop() -> Double? {
        self.generation &+= 1
        self.envelope?.cancel()
        self.envelope = nil
        self.onLevel(nil)
        return self.player.stop()
    }
}
