import AVFAudio
import Foundation
import Speech

private func makeAudioTapEnqueueCallback(queue: AudioBufferQueue) -> AVAudioNodeTapBlock {
    { buffer, _ in
        // This callback is invoked on a realtime audio thread/queue. Keep it tiny and nonisolated.
        queue.enqueueCopy(of: buffer)
    }
}

private final class AudioBufferQueue: @unchecked Sendable {
    private let lock = NSLock()
    private var buffers: [AVAudioPCMBuffer] = []

    func enqueueCopy(of buffer: AVAudioPCMBuffer) {
        guard let copy = buffer.deepCopy() else { return }
        self.lock.lock()
        self.buffers.append(copy)
        self.lock.unlock()
    }

    func drain() -> [AVAudioPCMBuffer] {
        self.lock.lock()
        let drained = self.buffers
        self.buffers.removeAll(keepingCapacity: true)
        self.lock.unlock()
        return drained
    }

    func clear() {
        self.lock.lock()
        self.buffers.removeAll(keepingCapacity: false)
        self.lock.unlock()
    }
}

extension AVAudioPCMBuffer {
    fileprivate func deepCopy() -> AVAudioPCMBuffer? {
        let format = self.format
        let frameLength = self.frameLength
        guard let copy = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameLength) else {
            return nil
        }
        copy.frameLength = frameLength

        if let src = self.floatChannelData, let dst = copy.floatChannelData {
            let channels = Int(format.channelCount)
            let frames = Int(frameLength)
            for ch in 0..<channels {
                dst[ch].update(from: src[ch], count: frames)
            }
            return copy
        }

        if let src = self.int16ChannelData, let dst = copy.int16ChannelData {
            let channels = Int(format.channelCount)
            let frames = Int(frameLength)
            for ch in 0..<channels {
                dst[ch].update(from: src[ch], count: frames)
            }
            return copy
        }

        if let src = self.int32ChannelData, let dst = copy.int32ChannelData {
            let channels = Int(format.channelCount)
            let frames = Int(frameLength)
            for ch in 0..<channels {
                dst[ch].update(from: src[ch], count: frames)
            }
            return copy
        }

        return nil
    }
}

@MainActor
final class VoiceWakeManager: NSObject, ObservableObject {
    @Published var isEnabled: Bool = false
    @Published var isListening: Bool = false
    @Published var statusText: String = "Off"

    private let audioEngine = AVAudioEngine()
    private var speechRecognizer: SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var tapQueue: AudioBufferQueue?
    private var tapDrainTask: Task<Void, Never>?

    private var lastDispatched: String?
    private var onCommand: (@Sendable (String) async -> Void)?

    func configure(onCommand: @escaping @Sendable (String) async -> Void) {
        self.onCommand = onCommand
    }

    func setEnabled(_ enabled: Bool) {
        self.isEnabled = enabled
        if enabled {
            Task { await self.start() }
        } else {
            self.stop()
        }
    }

    func start() async {
        guard self.isEnabled else { return }
        if self.isListening { return }

        self.statusText = "Requesting permissions…"

        let micOk = await Self.requestMicrophonePermission()
        guard micOk else {
            self.statusText = "Microphone permission denied"
            self.isListening = false
            return
        }

        let speechOk = await Self.requestSpeechPermission()
        guard speechOk else {
            self.statusText = "Speech recognition permission denied"
            self.isListening = false
            return
        }

        self.speechRecognizer = SFSpeechRecognizer()
        guard self.speechRecognizer != nil else {
            self.statusText = "Speech recognizer unavailable"
            self.isListening = false
            return
        }

        do {
            try Self.configureAudioSession()
            try self.startRecognition()
            self.isListening = true
            self.statusText = "Listening"
        } catch {
            self.isListening = false
            self.statusText = "Start failed: \(error.localizedDescription)"
        }
    }

    func stop() {
        self.isEnabled = false
        self.isListening = false
        self.statusText = "Off"

        self.tapDrainTask?.cancel()
        self.tapDrainTask = nil
        self.tapQueue?.clear()
        self.tapQueue = nil

        self.recognitionTask?.cancel()
        self.recognitionTask = nil
        self.recognitionRequest = nil

        if self.audioEngine.isRunning {
            self.audioEngine.stop()
            self.audioEngine.inputNode.removeTap(onBus: 0)
        }

        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func startRecognition() throws {
        self.recognitionTask?.cancel()
        self.recognitionTask = nil
        self.tapDrainTask?.cancel()
        self.tapDrainTask = nil
        self.tapQueue?.clear()
        self.tapQueue = nil

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        self.recognitionRequest = request

        let inputNode = self.audioEngine.inputNode
        inputNode.removeTap(onBus: 0)

        let recordingFormat = inputNode.outputFormat(forBus: 0)

        let queue = AudioBufferQueue()
        self.tapQueue = queue
        inputNode.installTap(
            onBus: 0,
            bufferSize: 1024,
            format: recordingFormat,
            block: makeAudioTapEnqueueCallback(queue: queue))

        self.audioEngine.prepare()
        try self.audioEngine.start()

        let handler = self.makeRecognitionResultHandler()
        self.recognitionTask = self.speechRecognizer?.recognitionTask(with: request, resultHandler: handler)

        self.tapDrainTask = Task { [weak self] in
            guard let self, let queue = self.tapQueue else { return }
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 40_000_000)
                let drained = queue.drain()
                if drained.isEmpty { continue }
                for buf in drained {
                    request.append(buf)
                }
            }
        }
    }

    private nonisolated func makeRecognitionResultHandler() -> @Sendable (SFSpeechRecognitionResult?, Error?) -> Void {
        { [weak self] result, error in
            let transcript = result?.bestTranscription.formattedString
            let errorText = error?.localizedDescription

            Task { @MainActor in
                self?.handleRecognitionCallback(transcript: transcript, errorText: errorText)
            }
        }
    }

    private func handleRecognitionCallback(transcript: String?, errorText: String?) {
        if let errorText {
            self.statusText = "Recognizer error: \(errorText)"
            self.isListening = false

            let shouldRestart = self.isEnabled
            if shouldRestart {
                Task {
                    try? await Task.sleep(nanoseconds: 700_000_000)
                    await self.start()
                }
            }
            return
        }

        guard let transcript else { return }
        guard let cmd = self.extractCommand(from: transcript) else { return }

        if cmd == self.lastDispatched { return }
        self.lastDispatched = cmd
        self.statusText = "Triggered"

        Task { [weak self] in
            guard let self else { return }
            await self.onCommand?(cmd)
            await self.startIfEnabled()
        }
    }

    private func startIfEnabled() async {
        let shouldRestart = self.isEnabled
        if shouldRestart {
            await self.start()
        }
    }

    private func extractCommand(from transcript: String) -> String? {
        let lower = transcript.lowercased()
        guard let range = lower.range(of: "clawdis", options: .backwards) else { return nil }
        let after = lower[range.upperBound...]
        let trimmed = after.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        return trimmed
    }

    private static func configureAudioSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .measurement, options: [
            .duckOthers,
            .mixWithOthers,
            .allowBluetoothHFP,
            .defaultToSpeaker,
        ])
        try session.setActive(true, options: [])
    }

    private nonisolated static func requestMicrophonePermission() async -> Bool {
        await withCheckedContinuation(isolation: nil) { cont in
            AVAudioApplication.requestRecordPermission { ok in
                cont.resume(returning: ok)
            }
        }
    }

    private nonisolated static func requestSpeechPermission() async -> Bool {
        await withCheckedContinuation(isolation: nil) { cont in
            SFSpeechRecognizer.requestAuthorization { status in
                cont.resume(returning: status == .authorized)
            }
        }
    }
}
