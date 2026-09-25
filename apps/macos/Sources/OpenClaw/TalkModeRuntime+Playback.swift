import Foundation
import OpenClawKit
import OpenClawProtocol

extension TalkModeRuntime {
    static func makeTalkSpeakParams(
        text: String,
        voiceId: String?,
        modelId: String?,
        outputFormat: String?,
        directive: TalkDirective?) -> [String: AnyCodable]
    {
        var params: [String: AnyCodable] = ["text": AnyCodable(text)]

        func addString(_ key: String, _ value: String?) {
            let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !trimmed.isEmpty else { return }
            params[key] = AnyCodable(trimmed)
        }

        addString("voiceId", voiceId)
        addString("modelId", directive?.modelId ?? modelId)
        addString("outputFormat", directive?.outputFormat ?? outputFormat)
        if let speed = directive?.speed {
            params["speed"] = AnyCodable(speed)
        }
        if let rateWPM = directive?.rateWPM {
            params["rateWpm"] = AnyCodable(rateWPM)
        }
        if let stability = directive?.stability {
            params["stability"] = AnyCodable(stability)
        }
        if let similarity = directive?.similarity {
            params["similarity"] = AnyCodable(similarity)
        }
        if let style = directive?.style {
            params["style"] = AnyCodable(style)
        }
        if let speakerBoost = directive?.speakerBoost {
            params["speakerBoost"] = AnyCodable(speakerBoost)
        }
        if let seed = directive?.seed {
            params["seed"] = AnyCodable(seed)
        }
        addString("normalize", directive?.normalize)
        addString("language", directive?.language)
        if let latencyTier = directive?.latencyTier {
            params["latencyTier"] = AnyCodable(latencyTier)
        }

        return params
    }

    // MARK: - Audio playback (MainActor helpers)

    @MainActor
    func performCurrentPlayback<Result: Sendable>(
        generation: Int,
        operation: @MainActor () async throws -> Result) async throws -> Result
    {
        let generation = UInt64(truncatingIfNeeded: generation)
        // Admit on the player's actor, so a late synthesis result cannot replace
        // successor audio after the runtime-side check and MainActor hop.
        guard self.lifecycleDeliveryGate.isActive(generation), !Task.isCancelled else { throw CancellationError() }
        let result = try await operation()
        guard self.lifecycleDeliveryGate.isActive(generation), !Task.isCancelled else { throw CancellationError() }
        return result
    }

    @MainActor
    func playPCM(
        stream: AsyncThrowingStream<Data, Error>,
        sampleRate: Double,
        generation: Int) async throws -> StreamingPlaybackResult
    {
        try await self.performCurrentPlayback(generation: generation) {
            await TalkPCMPlayback.shared.play(stream: stream, sampleRate: sampleRate)
        }
    }

    /// MP3 streaming has no metering hook; the wave falls back to its floor.
    @MainActor
    func playMP3(
        stream: AsyncThrowingStream<Data, Error>,
        generation: Int) async throws -> StreamingPlaybackResult
    {
        try await self.performCurrentPlayback(generation: generation) {
            await StreamingAudioPlayer.shared.play(stream: stream)
        }
    }

    @MainActor
    func stopPCM() -> Double? {
        TalkPCMPlayback.shared.stop()
    }

    @MainActor
    func stopMP3() -> Double? {
        StreamingAudioPlayer.shared.stop()
    }

    @MainActor
    func playTalkAudio(data: Data, generation: Int) async throws -> StreamingPlaybackResult {
        try await self.performCurrentPlayback(generation: generation) {
            _ = TalkPCMPlayback.shared.stop()
            _ = StreamingAudioPlayer.shared.stop()
            TalkBufferedAudioPlayer.shared.setLevelHandler { level in
                TalkModeController.shared.updateSpeakingLevel(level)
            }
            return await TalkBufferedAudioPlayer.shared.play(data: data)
        }
    }

    @MainActor
    func stopTalkAudio() -> Double? {
        TalkBufferedAudioPlayer.shared.stop()
    }

    func streamMLXVoice(
        text: String,
        modelRepo: String?,
        language: String?,
        voicePreset: String?,
        referenceAudioPath: String?,
        referenceText: String?,
        stallTimeoutSeconds: Double) async throws -> MLXTTSPlaybackStream
    {
        try await TalkMLXSpeechSynthesizer.shared.synthesizeStream(
            text: text,
            modelRepo: modelRepo,
            language: language,
            voicePreset: voicePreset,
            referenceAudioPath: referenceAudioPath,
            referenceText: referenceText,
            stallTimeoutSeconds: stallTimeoutSeconds)
    }

    func stopMLXVoice() async {
        await TalkMLXSpeechSynthesizer.shared.cancelCurrent()
    }
}
