import AVFoundation
import Foundation
import OSLog
@preconcurrency import ScreenCaptureKit
import WhisperKit

enum TranscriptionEngine: String, CaseIterable, Identifiable {
    case whisper = "whisper"
    case apple = "apple"

    var id: String { self.rawValue }

    var displayName: String {
        switch self {
        case .whisper: "Whisper (Local)"
        case .apple: "Apple Speech"
        }
    }
}

enum WhisperModelState: Sendable {
    case idle
    case downloading(Double) // 0.0–1.0
    case loading
    case ready
    case error(String)
}

/// Captures mic + system audio and transcribes using WhisperKit in ~5-second chunks.
actor WhisperTranscriber {
    private let logger = Logger(subsystem: "ai.openclaw", category: "meeting.whisper")

    // WhisperKit isn't Sendable but we only use it within the actor's serialized context.
    // The `transcribe` call is async, which triggers a sending diagnostic — suppress it here.
    nonisolated(unsafe) private var whisperKit: WhisperKit?
    private var micEngine: AVAudioEngine?
    private var systemStream: SCStream?
    private var systemStreamOutput: WhisperSystemAudioOutput?

    // Audio buffer accumulation
    private var audioBuffer: [Float] = []
    private var sampleRate: Double = 16000
    private let chunkInterval: TimeInterval = 5.0
    private var chunkTimer: Task<Void, Never>?

    // Mic RMS tracking for speaker attribution
    private nonisolated(unsafe) var micIsSpeaking = false
    private let micRMSThreshold: Float = -40.0 // dBFS

    private var isRunning = false
    private var onSegment: (@MainActor (Speaker, String, Bool) -> Void)?

    // Observable state (read from MainActor via nonisolated)
    nonisolated(unsafe) private(set) var modelState: WhisperModelState = .idle
    nonisolated(unsafe) private(set) var currentModelName: String = ""
    nonisolated(unsafe) private(set) var downloadedModels: Set<String> = []
    private var downloadedModelPaths: [String: URL] = [:]

    static let supportedModels = [
        "openai_whisper-tiny.en",
        "openai_whisper-base.en",
        "openai_whisper-small.en",
        "openai_whisper-medium.en",
        "openai_whisper-large-v3",
    ]

    private static let downloadBase: URL = OpenClawPaths.stateDirURL
        .appendingPathComponent("whisper-models", isDirectory: true)

    func start(onSegment: @MainActor @escaping (Speaker, String, Bool) -> Void) async {
        guard !self.isRunning else { return }
        self.isRunning = true
        self.onSegment = onSegment

        let modelName = UserDefaults.standard.string(forKey: "whisperModelSize") ?? "openai_whisper-base.en"
        await self.ensureModelLoaded(modelName: modelName)

        guard self.whisperKit != nil else {
            self.logger.error("whisper: model not loaded, cannot start")
            return
        }

        await self.startCapture()
        self.startChunkTimer()
    }

    func stop() async {
        self.isRunning = false
        self.chunkTimer?.cancel()
        self.chunkTimer = nil
        self.onSegment = nil

        // Transcribe any remaining audio
        await self.transcribeCurrentChunk()

        await self.stopCapture()
        self.audioBuffer.removeAll()
    }

    // MARK: - Model management

    /// Scan the download directory to find which models are already on disk.
    func refreshDownloadedModels() {
        let (found, paths) = Self.scanDownloadedModels()
        self.downloadedModels = found
        self.downloadedModelPaths = paths
    }

    /// Synchronous scan — can be called from any isolation context.
    nonisolated static func scanDownloadedModels() -> (Set<String>, [String: URL]) {
        let fm = FileManager.default
        let modelsDir = downloadBase.appendingPathComponent("models", isDirectory: true)
        guard let enumerator = fm.enumerator(
            at: modelsDir, includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]) else {
            return ([], [:])
        }
        var found = Set<String>()
        var paths = [String: URL]()
        for case let url as URL in enumerator {
            let melSpec = url.appendingPathComponent("MelSpectrogram.mlmodelc")
            if fm.fileExists(atPath: melSpec.path) {
                let name = url.lastPathComponent
                found.insert(name)
                paths[name] = url
            }
        }
        return (found, paths)
    }

    /// Reset model state (e.g. when switching to a model that isn't downloaded yet).
    func resetState() {
        self.modelState = .idle
        self.whisperKit = nil
        self.currentModelName = ""
    }

    /// Download and load a model proactively (e.g. from settings UI).
    func downloadModel(named modelName: String) async {
        await self.ensureModelLoaded(modelName: modelName)
    }

    private func ensureModelLoaded(modelName: String) async {
        if self.whisperKit != nil, self.currentModelName == modelName {
            return
        }

        self.currentModelName = modelName
        self.logger.info("whisper: preparing model \(modelName, privacy: .public)")

        // Check if already downloaded on disk
        self.refreshDownloadedModels()
        let modelFolder: URL

        if let existingPath = self.downloadedModelPaths[modelName] {
            self.logger.info("whisper: model \(modelName, privacy: .public) found on disk")
            modelFolder = existingPath
        } else {
            // Download with progress
            self.modelState = .downloading(0)
            do {
                modelFolder = try await WhisperKit.download(
                    variant: modelName,
                    downloadBase: Self.downloadBase
                ) { [weak self] progress in
                    self?.modelState = .downloading(progress.fractionCompleted)
                }
            } catch {
                self.modelState = .error(error.localizedDescription)
                self.logger.error("whisper: download failed: \(error.localizedDescription, privacy: .public)")
                return
            }
            self.refreshDownloadedModels()
        }

        // Load model into WhisperKit
        self.modelState = .loading
        do {
            let kit = try await WhisperKit(
                modelFolder: modelFolder.path,
                download: false
            )
            self.whisperKit = kit
            self.modelState = .ready
            self.logger.info("whisper: model \(modelName, privacy: .public) ready")
        } catch {
            self.modelState = .error(error.localizedDescription)
            self.logger.error("whisper: model load failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: - Audio capture

    private func startCapture() async {
        let micStarted = self.startMicEngine()
        self.logger.info("whisper: mic capture started=\(micStarted, privacy: .public)")

        await self.startSystemAudioCapture()
    }

    private func stopCapture() async {
        self.stopMicEngine()
        await self.stopSystemAudioCapture()
    }

    private func startMicEngine() -> Bool {
        let engine = AVAudioEngine()
        self.micEngine = engine

        let input = engine.inputNode
        let nativeFormat = input.outputFormat(forBus: 0)
        guard nativeFormat.channelCount > 0, nativeFormat.sampleRate > 0 else {
            self.logger.error("whisper: no audio input available")
            return false
        }

        self.sampleRate = nativeFormat.sampleRate

        // Target format: mono Float32 at native sample rate (WhisperKit resamples internally)
        let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: nativeFormat.sampleRate,
            channels: 1,
            interleaved: false)!

        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 4096, format: targetFormat) { [weak self] buffer, _ in
            guard let self else { return }
            // RMS for speaker attribution
            if let rms = Self.rmsLevel(buffer: buffer) {
                self.micIsSpeaking = rms > self.micRMSThreshold
            }
            // Append samples to buffer
            if let channelData = buffer.floatChannelData {
                let count = Int(buffer.frameLength)
                let samples = Array(UnsafeBufferPointer(start: channelData[0], count: count))
                Task { await self.appendSamples(samples) }
            }
        }

        engine.prepare()
        do {
            try engine.start()
            return true
        } catch {
            self.logger.error("whisper: mic engine start failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    private func stopMicEngine() {
        self.micEngine?.inputNode.removeTap(onBus: 0)
        self.micEngine?.stop()
        self.micEngine = nil
    }

    /// Temporarily stop the mic engine so external code can probe whether
    /// another app is still using the hardware microphone.
    func pauseMic() {
        self.micEngine?.stop()
    }

    /// Re-start the mic engine after a `pauseMic()` probe.
    func resumeMic() {
        guard let engine = self.micEngine else { return }
        do {
            try engine.start()
        } catch {
            self.logger.error("whisper: mic resume failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func appendSamples(_ samples: [Float]) {
        guard self.isRunning else { return }
        self.audioBuffer.append(contentsOf: samples)
    }

    // MARK: - System audio (ScreenCaptureKit)

    private func startSystemAudioCapture() async {
        do {
            let content = try await SCShareableContent.current
            guard let display = content.displays.first else {
                self.logger.warning("whisper: no displays for system audio")
                return
            }

            let filter = SCContentFilter(display: display, excludingWindows: [])
            let config = SCStreamConfiguration()
            config.capturesAudio = true
            config.excludesCurrentProcessAudio = true
            config.width = 2
            config.height = 2

            let output = WhisperSystemAudioOutput { [weak self] samples in
                Task { await self?.appendSamples(samples) }
            }
            self.systemStreamOutput = output

            let stream = SCStream(filter: filter, configuration: config, delegate: nil)
            try stream.addStreamOutput(output, type: .audio, sampleHandlerQueue: output.queue)
            self.systemStream = stream

            try await stream.startCapture()
            self.logger.info("whisper: system audio capture started")
        } catch {
            self.logger.warning("whisper: system audio unavailable: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func stopSystemAudioCapture() async {
        if let stream = self.systemStream {
            try? await stream.stopCapture()
        }
        self.systemStream = nil
        self.systemStreamOutput = nil
    }

    // MARK: - Chunked transcription

    private func startChunkTimer() {
        self.chunkTimer?.cancel()
        self.chunkTimer = Task { [weak self] in
            while let self, !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(self.chunkInterval * 1_000_000_000))
                guard !Task.isCancelled else { break }
                await self.transcribeCurrentChunk()
            }
        }
    }

    private func transcribeCurrentChunk() async {
        guard let whisperKit = self.whisperKit else { return }

        let samples = self.audioBuffer
        self.audioBuffer.removeAll(keepingCapacity: true)

        // Need at least 0.5 seconds of audio
        let minSamples = Int(self.sampleRate * 0.5)
        guard samples.count >= minSamples else { return }

        // Resample to 16kHz if needed (WhisperKit expects 16kHz)
        let audio: [Float]
        if abs(self.sampleRate - 16000) > 1 {
            audio = Self.resample(samples, from: self.sampleRate, to: 16000)
        } else {
            audio = samples
        }

        let speaker: Speaker = self.micIsSpeaking ? .me : .other

        do {
            let results = try await whisperKit.transcribe(audioArray: audio)
            for result in results {
                let text = result.text.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
                guard !text.isEmpty else { continue }
                let onSegment = self.onSegment
                Task { @MainActor in
                    onSegment?(speaker, text, true)
                }
            }
        } catch {
            self.logger.warning("whisper: transcription error: \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: - Helpers

    private static func rmsLevel(buffer: AVAudioPCMBuffer) -> Float? {
        guard let channelData = buffer.floatChannelData else { return nil }
        let channelDataValue = channelData.pointee
        let count = Int(buffer.frameLength)
        guard count > 0 else { return nil }
        var sum: Float = 0
        for i in 0..<count {
            let sample = channelDataValue[i]
            sum += sample * sample
        }
        let rms = sqrt(sum / Float(count))
        let db = 20 * log10(max(rms, 1e-10))
        return db
    }

    /// Simple linear resampling from one sample rate to another.
    private static func resample(_ samples: [Float], from sourceSR: Double, to targetSR: Double) -> [Float] {
        let ratio = targetSR / sourceSR
        let outputCount = Int(Double(samples.count) * ratio)
        guard outputCount > 0 else { return [] }
        var output = [Float](repeating: 0, count: outputCount)
        for i in 0..<outputCount {
            let srcIndex = Double(i) / ratio
            let low = Int(srcIndex)
            let high = min(low + 1, samples.count - 1)
            let frac = Float(srcIndex - Double(low))
            output[i] = samples[low] * (1 - frac) + samples[high] * frac
        }
        return output
    }
}

// MARK: - System audio stream output for WhisperKit

private final class WhisperSystemAudioOutput: NSObject, SCStreamOutput, @unchecked Sendable {
    let queue = DispatchQueue(label: "ai.openclaw.meeting.whisper.systemAudio")
    private let onSamples: @Sendable ([Float]) -> Void

    init(onSamples: @escaping @Sendable ([Float]) -> Void) {
        self.onSamples = onSamples
        super.init()
    }

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType)
    {
        guard type == .audio, CMSampleBufferDataIsReady(sampleBuffer) else { return }

        guard let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc)
        else { return }

        guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
        let frameCount = CMSampleBufferGetNumSamples(sampleBuffer)
        guard frameCount > 0 else { return }

        var dataPointer: UnsafeMutablePointer<Int8>?
        var totalLength: Int = 0
        let status = CMBlockBufferGetDataPointer(
            blockBuffer, atOffset: 0, lengthAtOffsetOut: nil,
            totalLengthOut: &totalLength, dataPointerOut: &dataPointer)
        guard status == kCMBlockBufferNoErr, let dataPointer else { return }

        let channelCount = Int(asbd.pointee.mChannelsPerFrame)
        let sampleCount = frameCount * channelCount
        let floatPointer = UnsafeRawPointer(dataPointer).bindMemory(to: Float.self, capacity: sampleCount)
        let floatBuffer = UnsafeBufferPointer(start: floatPointer, count: sampleCount)

        // Mix to mono if multi-channel
        var mono = [Float](repeating: 0, count: frameCount)
        if channelCount == 1 {
            mono = Array(floatBuffer)
        } else {
            for i in 0..<frameCount {
                var sum: Float = 0
                for ch in 0..<channelCount {
                    sum += floatBuffer[i * channelCount + ch]
                }
                mono[i] = sum / Float(channelCount)
            }
        }

        self.onSamples(mono)
    }
}
