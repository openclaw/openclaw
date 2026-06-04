import AVFoundation
import Foundation

/// On-device TTS using Piper (via sherpa-onnx).
/// This is a placeholder implementation that defines the interface.
/// Full sherpa-onnx integration requires adding the SPM dependency and downloading voice models.
@MainActor
public final class PiperTTSSynthesizer {
    public enum PiperError: Error {
        case modelNotDownloaded
        case synthesizeFailed(String)
        case canceled
    }

    public static let shared = PiperTTSSynthesizer()

    /// Whether the voice model has been downloaded and is ready.
    public private(set) var isModelReady: Bool = false

    /// Default voice model identifier.
    public let defaultVoiceModel = "en_US-amy-medium"

    /// Sample rate of Piper output audio.
    public let sampleRate: Double = 22050

    /// Approximate model download size.
    public let modelDownloadSizeMB: Int = 30

    private var modelPath: URL?
    private var isCanceled = false

    private init() {
        // Check if model already exists in Documents
        self.modelPath = Self.localModelURL()
        self.isModelReady = Self.modelExists()
    }

    /// Download the Piper voice model if not already present.
    public func downloadModelIfNeeded(
        progress: ((Double) -> Void)? = nil
    ) async throws {
        guard !self.isModelReady else { return }

        let modelURL = URL(string: "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx")!
        let configURL = URL(string: "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx.json")!

        let destDir = Self.modelDirectory()
        try FileManager.default.createDirectory(at: destDir, withIntermediateDirectories: true)

        // Download model file
        let (modelData, _) = try await URLSession.shared.data(from: modelURL)
        let modelDest = destDir.appendingPathComponent("en_US-amy-medium.onnx")
        try modelData.write(to: modelDest)

        // Download config file
        let (configData, _) = try await URLSession.shared.data(from: configURL)
        let configDest = destDir.appendingPathComponent("en_US-amy-medium.onnx.json")
        try configData.write(to: configDest)

        self.modelPath = modelDest
        self.isModelReady = true
    }

    /// Synthesize text to PCM Float32 audio samples at 22050 Hz.
    /// Returns raw PCM samples suitable for playback via PCMStreamingAudioPlayer.
    public func synthesize(text: String) async throws -> [Float] {
        guard self.isModelReady else {
            throw PiperError.modelNotDownloaded
        }
        self.isCanceled = false

        // TODO: Integration with sherpa-onnx native inference
        // Once the sherpa-onnx SPM dependency is added to Package.swift, this will call:
        //   let config = OfflineTtsConfig(model: modelPath, ...)
        //   let tts = OfflineTts(config: config)
        //   let audio = tts.generate(text: text)
        //   return audio.samples
        //
        // For now, fall back to system voice to keep the build compiling.
        throw PiperError.synthesizeFailed("sherpa-onnx not yet linked — use system fallback")
    }

    /// Speak text using Piper, outputting via AVAudioEngine.
    /// Falls back to system TTS if model is not ready.
    public func speak(text: String) async throws {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        guard self.isModelReady else {
            throw PiperError.modelNotDownloaded
        }

        do {
            let samples = try await self.synthesize(text: trimmed)
            try await self.playSamples(samples)
        } catch PiperError.synthesizeFailed {
            // If synthesis fails, caller should fall back to system voice
            throw PiperError.synthesizeFailed("Piper synthesis unavailable")
        }
    }

    public func stop() {
        self.isCanceled = true
    }

    // MARK: - Private

    private func playSamples(_ samples: [Float]) async throws {
        guard !samples.isEmpty else { return }
        if self.isCanceled { throw PiperError.canceled }
        // Playback will be handled by the existing PCMStreamingAudioPlayer
        // once sherpa-onnx is integrated. For now this is a stub.
    }

    private static func modelDirectory() -> URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return docs.appendingPathComponent("PiperModels", isDirectory: true)
    }

    private static func localModelURL() -> URL? {
        let dir = Self.modelDirectory()
        let path = dir.appendingPathComponent("en_US-amy-medium.onnx")
        return FileManager.default.fileExists(atPath: path.path) ? path : nil
    }

    private static func modelExists() -> Bool {
        let dir = Self.modelDirectory()
        let modelPath = dir.appendingPathComponent("en_US-amy-medium.onnx").path
        let configPath = dir.appendingPathComponent("en_US-amy-medium.onnx.json").path
        return FileManager.default.fileExists(atPath: modelPath)
            && FileManager.default.fileExists(atPath: configPath)
    }
}
