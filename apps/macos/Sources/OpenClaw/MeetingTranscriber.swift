import AVFoundation
import Foundation
import OSLog
@preconcurrency import ScreenCaptureKit
import Speech

/// Captures mic audio, feeds it to a single SFSpeechRecognizer, and optionally captures
/// system audio via ScreenCaptureKit.
///
/// Apple's SFSpeechRecognizer only supports **one active recognition task per process**,
/// so we use a single recognizer for mic input. System audio is captured separately via
/// ScreenCaptureKit and mixed into the same recognition request so both sides of the
/// conversation are transcribed together.
actor MeetingTranscriber {
    private let logger = Logger(subsystem: "ai.openclaw", category: "meeting.transcriber")

    // Single recognizer + request (Apple only allows one active task per process)
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?

    // Mic capture
    private var micEngine: AVAudioEngine?

    // System audio capture (ScreenCaptureKit)
    private var systemStream: SCStream?
    private var systemStreamOutput: SystemAudioStreamOutput?

    // Mic RMS tracking for speaker attribution (accessed from audio tap callback)
    private nonisolated(unsafe) var micIsSpeaking = false
    private let micRMSThreshold: Float = -40.0 // dBFS

    private var isRunning = false
    private var generation: Int = 0
    private var onSegment: (@MainActor (Speaker, String, Bool) -> Void)?

    func start(onSegment: @MainActor @escaping (Speaker, String, Bool) -> Void) async {
        guard !self.isRunning else { return }
        self.isRunning = true
        self.generation &+= 1
        self.onSegment = onSegment

        await self.startCapture()
    }

    func stop() async {
        self.isRunning = false
        self.generation &+= 1
        self.onSegment = nil

        await self.stopCapture()
    }

    // MARK: - Combined capture

    private func startCapture() async {
        let gen = self.generation

        let recognizer = SFSpeechRecognizer(locale: Locale.current)
        guard let recognizer, recognizer.isAvailable else {
            self.logger.error("meeting recognizer unavailable (locale=\(Locale.current.identifier, privacy: .public))")
            return
        }
        self.recognizer = recognizer

        // Check if on-device recognition is available
        let supportsOnDevice = recognizer.supportsOnDeviceRecognition
        self.logger.info("meeting recognizer: locale=\(Locale.current.identifier, privacy: .public) onDevice=\(supportsOnDevice, privacy: .public)")

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        // Don't force on-device — let the system choose
        self.request = request

        // Start mic audio engine FIRST, before creating the recognition task
        let micStarted = self.startMicEngine(request: request)
        if !micStarted {
            self.logger.error("meeting mic engine failed to start")
            return
        }

        // Create recognition task IMMEDIATELY after mic engine starts
        // (before system audio setup which requires async/await and could delay things)
        let currentSpeaker = { [weak self] () -> Speaker in
            guard let self else { return .unknown }
            // Heuristic: if mic RMS is above threshold, it's you speaking
            return self.micIsSpeaking ? .me : .other
        }

        let onSegment = self.onSegment
        self.logger.info("meeting creating recognition task...")
        self.task = recognizer.recognitionTask(with: request) { [weak self, gen] result, error in
            guard let self else { return }
            if let error {
                self.logger.warning("meeting recognition error: \(error.localizedDescription, privacy: .public)")
            }
            let transcript = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            guard let transcript, !transcript.isEmpty else { return }
            let speaker = currentSpeaker()
            Task { @MainActor in
                onSegment?(speaker, transcript, isFinal)
            }
            if isFinal {
                Task { await self.restartRecognitionIfNeeded(gen) }
            }
        }
        self.logger.info("meeting capture started (mic=\(micStarted, privacy: .public))")

        // System audio capture (optional — requires screen recording permission)
        await self.startSystemAudioStream(request: request)
    }

    private func restartRecognitionIfNeeded(_ gen: Int) async {
        guard self.isRunning, gen == self.generation else { return }
        // Stop and restart everything for a fresh recognition task
        await self.stopCapture()
        await self.startCapture()
    }

    private func stopCapture() async {
        self.task?.cancel()
        self.task = nil
        self.request?.endAudio()
        self.request = nil
        self.recognizer = nil

        self.stopMicEngine()
        await self.stopSystemAudioStream()
    }

    // MARK: - Mic engine

    private func startMicEngine(request: SFSpeechAudioBufferRecognitionRequest) -> Bool {
        let engine = AVAudioEngine()
        self.micEngine = engine

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.channelCount > 0, format.sampleRate > 0 else {
            self.logger.error("meeting mic: no audio input available (channels=\(format.channelCount) rate=\(format.sampleRate))")
            return false
        }

        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self, weak request] buffer, _ in
            request?.append(buffer)
            if let rms = Self.rmsLevel(buffer: buffer) {
                self?.micIsSpeaking = rms > (self?.micRMSThreshold ?? -40.0)
            }
        }

        engine.prepare()
        do {
            try engine.start()
            self.logger.info("meeting mic engine started (format: \(format.sampleRate)Hz \(format.channelCount)ch)")
            return true
        } catch {
            self.logger.error("meeting mic engine start failed: \(error.localizedDescription, privacy: .public)")
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
            self.logger.error("meeting: mic resume failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: - System audio (ScreenCaptureKit)

    private func startSystemAudioStream(request: SFSpeechAudioBufferRecognitionRequest) async {
        do {
            let content = try await SCShareableContent.current
            guard let display = content.displays.first else {
                self.logger.warning("meeting system audio: no displays available")
                return
            }

            let filter = SCContentFilter(display: display, excludingWindows: [])
            let config = SCStreamConfiguration()
            config.capturesAudio = true
            config.excludesCurrentProcessAudio = true
            config.width = 2
            config.height = 2

            let output = SystemAudioStreamOutput(request: request, logger: self.logger)
            self.systemStreamOutput = output

            let stream = SCStream(filter: filter, configuration: config, delegate: nil)
            try stream.addStreamOutput(output, type: .audio, sampleHandlerQueue: output.queue)
            self.systemStream = stream

            try await stream.startCapture()
            self.logger.info("meeting system audio capture started")
        } catch {
            self.logger.warning("meeting system audio unavailable: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func stopSystemAudioStream() async {
        if let stream = self.systemStream {
            try? await stream.stopCapture()
        }
        self.systemStream = nil
        self.systemStreamOutput = nil
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
}

private final class SystemAudioStreamOutput: NSObject, SCStreamOutput, @unchecked Sendable {
    let queue = DispatchQueue(label: "ai.openclaw.meeting.systemAudio")
    private let request: SFSpeechAudioBufferRecognitionRequest
    private let logger: Logger

    init(request: SFSpeechAudioBufferRecognitionRequest, logger: Logger) {
        self.request = request
        self.logger = logger
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

        let format = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: asbd.pointee.mSampleRate,
            channels: AVAudioChannelCount(asbd.pointee.mChannelsPerFrame),
            interleaved: false)
        guard let format else { return }

        guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
        let frameCount = CMSampleBufferGetNumSamples(sampleBuffer)
        guard frameCount > 0 else { return }

        guard let pcmBuffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frameCount))
        else { return }
        pcmBuffer.frameLength = AVAudioFrameCount(frameCount)

        var dataPointer: UnsafeMutablePointer<Int8>?
        var totalLength: Int = 0
        let status = CMBlockBufferGetDataPointer(blockBuffer, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &totalLength, dataPointerOut: &dataPointer)
        guard status == kCMBlockBufferNoErr, let dataPointer else { return }

        if let channelData = pcmBuffer.floatChannelData {
            let byteCount = min(totalLength, Int(pcmBuffer.frameLength) * MemoryLayout<Float>.size * Int(format.channelCount))
            memcpy(channelData[0], dataPointer, byteCount)
        }

        self.request.append(pcmBuffer)
    }
}
