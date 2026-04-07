import Foundation
import OSLog
import MLXAudioTTS
import MLXAudioCore

/// Local speech synthesizer using MLX Audio for on-device TTS.
@MainActor
public final class TalkMLXSpeechSynthesizer {
    public enum SynthesizeError: Error {
        case canceled
        case modelNotLoaded
        case synthesisTimeout
        case noAudioGenerated
        case audioPlaybackFailed
    }

    public static let shared = TalkMLXSpeechSynthesizer()

    private let logger = Logger(subsystem: "ai.openclaw", category: "talk.mlx")
    private var model: SopranoModel?
    private var currentToken = UUID()
    private var watchdog: Task<Void, Never>?
    private var modelLoaded = false
    
    private init() {
        // Model will be loaded on first use
    }

    /// Load the MLX TTS model. Should be called before first use.
    public func loadModel() async throws {
        guard !modelLoaded else { return }
        
        self.logger.info("talk mlx loading model...")
//
//        #if canImport(MLXAudio)
        // Initialize the MLX Audio synthesizer
        // The package should support various TTS models
        do {
            // Load a TTS model from HuggingFace
            self.model = try await SopranoModel.fromPretrained("mlx-community/Soprano-80M-bf16")
            
//            self.synthesizer = try await MLXAudioSynthesizer(
//                modelConfiguration: .defaultTTS()
//            )
            self.modelLoaded = true
            self.logger.info("talk mlx model loaded successfully")
        } catch {
            self.logger.error("talk mlx model load failed: \(error.localizedDescription, privacy: .public)")
            throw error
        }
//        #else
//        self.logger.error("talk mlx not available: MLXAudio package not installed")
//        throw NSError(
//            domain: "MLXAudio",
//            code: -1,
//            userInfo: [NSLocalizedDescriptionKey: "MLXAudio package not installed"]
//        )
//        #endif
    }

    /// Stop any ongoing synthesis and playback.
    public func stop() {
        self.currentToken = UUID()
        self.watchdog?.cancel()
        self.watchdog = nil
        // Cancel any ongoing synthesis
    }

    /// Synthesize and speak text using the local MLX model.
    /// - Parameters:
    ///   - text: The text to synthesize
    ///   - language: Optional language code (e.g., "en", "es")
    ///   - speed: Speech speed multiplier (0.5-2.0)
    ///   - voicePreset: Optional voice preset name
    public func speak(
        text: String,
        language: String? = nil,
        speed: Double? = nil,
        voicePreset: String? = nil
    ) async throws {
        // https://github.com/Blaizzy/mlx-audio-swift/blob/b76c81fa3d15600e68323b94d740bb346f3455ef/Sources/MLXAudioTTS/Generation.swift#L24
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        let token = self.currentToken

        // Ensure model is loaded
        if !modelLoaded {
            try await self.loadModel()
        }

        guard let model = self.model else {
            throw SynthesizeError.modelNotLoaded
        }

        guard self.currentToken == token else {
            throw SynthesizeError.canceled
        }

        // Generate audio using streaming for lower latency
        self.logger.info("talk mlx generating audio stream for \(trimmed)")
        
        try await self.playAudioStream(model: model, text: trimmed, token: token)
    }

    private func playAudio(data: Data, token: UUID) async throws {
        guard self.currentToken == token else {
            throw SynthesizeError.canceled
        }

        // Use the existing TalkAudioPlayer for playback
        let result = await TalkAudioPlayer.shared.play(data: data)
        
        guard self.currentToken == token else {
            throw SynthesizeError.canceled
        }

        if !result.finished && result.interruptedAt == nil {
            throw SynthesizeError.audioPlaybackFailed
        }
    }
    
    /// Stream audio generation and playback for lower latency
    private func playAudioStream(model: SopranoModel, text: String, token: UUID) async throws {
        let streamingPlayer = TalkStreamingAudioPlayer()
        defer {
            Task { @MainActor in
                streamingPlayer.stop()
            }
        }
        
        let sampleRate = Double(model.sampleRate)
        var totalSamples = 0
        
        self.logger.info("talk mlx starting streaming synthesis")
        
        // Use generateStream for streaming synthesis
        let audioStream = try await model.generateStream(text: text)
        
        for try await audioChunk in audioStream {
            guard self.currentToken == token else {
                throw SynthesizeError.canceled
            }
            
            // Handle the AudioGeneration enum cases
            switch audioChunk {
            case .audio(let mlxArray):
                // Convert MLXArray to Float samples
                let samples = mlxArray.asArray(Float.self)
                totalSamples += samples.count
                
                // Create WAV data for this chunk
                let audioData = Self.makeWAVData(samples: samples, sampleRate: sampleRate)
                self.logger.info("talk mlx streaming chunk: \(samples.count) samples, \(audioData.count) bytes")
                
                // Queue this chunk for playback
                try streamingPlayer.queueAudio(data: audioData, sampleRate: sampleRate)
                
            case .token(let tokenId):
                self.logger.debug("talk mlx generated token: \(tokenId)")
                
            case .info(let info):
                self.logger.info("talk mlx generation info: \(String(describing: info))")
            }
        }
        
        self.logger.info("talk mlx streaming complete: \(totalSamples) total samples")
        
        // Wait for all audio to finish playing
        await streamingPlayer.waitForCompletion()
        
        guard self.currentToken == token else {
            throw SynthesizeError.canceled
        }
    }
}

// MARK: - WAV Helpers

extension TalkMLXSpeechSynthesizer {
    /// Build a WAV file in memory from raw 32-bit float PCM samples (mono, IEEE float format).
    /// This mirrors what `saveAudioArray` writes to disk but avoids any file I/O.
    private static func makeWAVData(samples: [Float], sampleRate: Double) -> Data {
        let numChannels: UInt16 = 1
        let bitsPerSample: UInt16 = 32
        let sampleRateInt = UInt32(sampleRate)
        let byteRate: UInt32 = sampleRateInt * UInt32(numChannels) * UInt32(bitsPerSample) / 8
        let blockAlign: UInt16 = numChannels * bitsPerSample / 8
        let dataSize = UInt32(samples.count) * 4  // 4 bytes per Float32
        let chunkSize: UInt32 = 36 + dataSize

        var data = Data(capacity: Int(44 + dataSize))

        // Appends an integer as little-endian bytes
        func write<T: FixedWidthInteger>(_ value: T) {
            var v = value.littleEndian
            withUnsafeBytes(of: &v) { data.append(contentsOf: $0) }
        }

        // RIFF header
        data.append(contentsOf: "RIFF".utf8)
        write(chunkSize)
        data.append(contentsOf: "WAVE".utf8)

        // fmt sub-chunk (IEEE float, tag = 3)
        data.append(contentsOf: "fmt ".utf8)
        write(UInt32(16))       // sub-chunk size
        write(UInt16(3))        // audio format: IEEE float
        write(numChannels)
        write(sampleRateInt)
        write(byteRate)
        write(blockAlign)
        write(bitsPerSample)

        // data sub-chunk
        data.append(contentsOf: "data".utf8)
        write(dataSize)
        samples.withUnsafeBytes { data.append(contentsOf: $0) }

        return data
    }
}

// MARK: - MLX Audio Configuration Extensions

/// Configuration for MLX synthesis
public struct MLXSynthesisConfiguration {
    /// Language code (ISO 639-1)
    public var language: String?
    /// Speech speed multiplier (0.5-2.0)
    public var speed: Double = 1.0
    /// Voice preset identifier
    public var voicePreset: String?
    /// Sample rate for output audio
    public var sampleRate: Int = 44100
    
    public init() {}
}
