import Foundation
import MLXAudioTTS
import OSLog

// swiftformat:disable wrap wrapMultilineStatementBraces trailingCommas redundantSelf extensionAccessControl
/// Runtime access stays serialized through `TalkModeRuntime` actor helper methods.
final class TalkMLXSpeechSynthesizer {
    enum SynthesizeError: Error {
        case canceled
        case modelLoadFailed(String)
        case audioGenerationFailed
        case audioPlaybackFailed
        case timedOut
    }

    static let shared = TalkMLXSpeechSynthesizer()
    static let defaultModelRepo = "mlx-community/Soprano-80M-bf16"

    private let logger = Logger(subsystem: "ai.openclaw", category: "talk.mlx")
    private var currentToken = UUID()
    private var modelRepo: String?
    private var model: (any SpeechGenerationModel)?

    private init() {}

    func stop() {
        self.currentToken = UUID()
    }

    func synthesize(
        text: String,
        modelRepo: String?,
        language: String?,
        voicePreset: String?) async throws -> Data {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return Data() }

        self.stop()
        let token = UUID()
        self.currentToken = token

        let resolvedRepo = Self.resolvedModelRepo(modelRepo)
        let rawModel = try await self.loadModel(
            modelRepo: resolvedRepo,
            token: token)
        let model = UncheckedSpeechModel(raw: rawModel)
        guard self.currentToken == token else {
            throw SynthesizeError.canceled
        }

        let audioData: Data
        do {
            let audio = try await model.generateAudio(
                text: trimmed,
                voice: voicePreset,
                language: language)
            audioData = Self.makeWavData(
                samples: audio,
                sampleRate: Double(model.sampleRateValue()))
        } catch {
            self.logger.error(
                "talk mlx generation failed: \(error.localizedDescription, privacy: .public)")
            throw SynthesizeError.audioGenerationFailed
        }

        guard self.currentToken == token else {
            throw SynthesizeError.canceled
        }
        return audioData
    }

    private func loadModel(
        modelRepo: String,
        token: UUID) async throws -> any SpeechGenerationModel {
        if let model = self.model, self.modelRepo == modelRepo {
            return model
        }

        self.logger.info("talk mlx loading modelRepo=\(modelRepo, privacy: .public)")
        do {
            let model = try await TTS.loadModel(modelRepo: modelRepo)
            guard self.currentToken == token else {
                throw SynthesizeError.canceled
            }
            self.model = model
            self.modelRepo = modelRepo
            return model
        } catch is CancellationError {
            throw SynthesizeError.canceled
        } catch {
            self.logger.error(
                "talk mlx load failed: \(error.localizedDescription, privacy: .public)")
            throw SynthesizeError.modelLoadFailed(modelRepo)
        }
    }

    private static func resolvedModelRepo(_ modelRepo: String?) -> String {
        let trimmed = modelRepo?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? Self.defaultModelRepo : trimmed
    }

    private static func makeWavData(samples: [Float], sampleRate: Double) -> Data {
        let channels: UInt16 = 1
        let bitsPerSample: UInt16 = 16
        let blockAlign = channels * (bitsPerSample / 8)
        let sampleRateInt = UInt32(sampleRate.rounded())
        let byteRate = sampleRateInt * UInt32(blockAlign)
        let dataSize = UInt32(samples.count) * UInt32(blockAlign)

        var data = Data(capacity: Int(44 + dataSize))
        data.append(contentsOf: [0x52, 0x49, 0x46, 0x46]) // RIFF
        data.appendLEUInt32(36 + dataSize)
        data.append(contentsOf: [0x57, 0x41, 0x56, 0x45]) // WAVE

        data.append(contentsOf: [0x66, 0x6D, 0x74, 0x20]) // fmt
        data.appendLEUInt32(16)
        data.appendLEUInt16(1)
        data.appendLEUInt16(channels)
        data.appendLEUInt32(sampleRateInt)
        data.appendLEUInt32(byteRate)
        data.appendLEUInt16(blockAlign)
        data.appendLEUInt16(bitsPerSample)

        data.append(contentsOf: [0x64, 0x61, 0x74, 0x61]) // data
        data.appendLEUInt32(dataSize)

        for sample in samples {
            let clamped = max(-1.0, min(1.0, sample))
            let scaled = Int16((clamped * Float(Int16.max)).rounded())
            data.appendLEInt16(scaled)
        }
        return data
    }
}

extension TalkMLXSpeechSynthesizer: @unchecked Sendable {}

private struct UncheckedSpeechModel {
    let raw: any SpeechGenerationModel

    func sampleRateValue() -> Int {
        raw.sampleRate
    }

    func generateAudio(
        text: String,
        voice: String?,
        language: String?) async throws -> [Float] {
        let generatedAudio = try await raw.generate(
            text: text,
            voice: voice,
            refAudio: nil,
            refText: nil,
            language: language)
        return generatedAudio.asArray(Float.self)
    }
}

extension UncheckedSpeechModel: @unchecked Sendable {}

extension Data {
    fileprivate mutating func appendLEUInt16(_ value: UInt16) {
        var littleEndian = value.littleEndian
        Swift.withUnsafeBytes(of: &littleEndian) { append(contentsOf: $0) }
    }

    fileprivate mutating func appendLEUInt32(_ value: UInt32) {
        var littleEndian = value.littleEndian
        Swift.withUnsafeBytes(of: &littleEndian) { append(contentsOf: $0) }
    }

    fileprivate mutating func appendLEInt16(_ value: Int16) {
        var littleEndian = value.littleEndian
        Swift.withUnsafeBytes(of: &littleEndian) { append(contentsOf: $0) }
    }
}

// swiftformat:enable wrap wrapMultilineStatementBraces trailingCommas redundantSelf extensionAccessControl
