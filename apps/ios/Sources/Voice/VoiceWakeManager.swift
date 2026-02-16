import AVFAudio
import Foundation
import Observation
import OpenClawKit
import Speech
import SwabbleKit

private func makeAudioTapEnqueueCallback(queue: AudioBufferQueue) -> @Sendable (AVAudioPCMBuffer, AVAudioTime) -> Void {
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
@Observable
final class VoiceWakeManager: NSObject {
    var isEnabled: Bool = false
    var isListening: Bool = false
    var statusText: String = "Off"
    var triggerWords: [String] = VoiceWakePreferences.loadTriggerWords()
    var lastTriggeredCommand: String?

    private let audioEngine = AVAudioEngine()
    private var speechRecognizer: SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var tapQueue: AudioBufferQueue?
    private var tapDrainTask: Task<Void, Never>?

    private var lastDispatched: String?
    private var onCommand: (@Sendable (String) async -> Void)?
    private var userDefaultsObserver: NSObjectProtocol?
    private var suppressedByTalk: Bool = false

    override init() {
        super.init()
        self.triggerWords = VoiceWakePreferences.loadTriggerWords()
        self.userDefaultsObserver = NotificationCenter.default.addObserver(
            forName: UserDefaults.didChangeNotification,
            object: UserDefaults.standard,
            queue: .main,
            using: { [weak self] _ in
                Task { @MainActor in
                    self?.handleUserDefaultsDidChange()
                }
            })
    }

    @MainActor deinit {
        if let userDefaultsObserver = self.userDefaultsObserver {
            NotificationCenter.default.removeObserver(userDefaultsObserver)
        }
    }

    var activeTriggerWords: [String] {
        VoiceWakePreferences.sanitizeTriggerWords(self.triggerWords)
    }

    private func handleUserDefaultsDidChange() {
        let updated = VoiceWakePreferences.loadTriggerWords()
        if updated != self.triggerWords {
            self.triggerWords = updated
        }
    }

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

    func setSuppressedByTalk(_ suppressed: Bool) {
        self.suppressedByTalk = suppressed
        if suppressed {
            _ = self.suspendForExternalAudioCapture()
            if self.isEnabled {
                self.statusText = "Paused"
            }
        } else {
            if self.isEnabled {
                Task { await self.start() }
            }
        }
    }

    func start() async {
        guard self.isEnabled else { return }
        if self.isListening { return }
        guard !self.suppressedByTalk else {
            self.isListening = false
            self.statusText = "Paused"
            return
        }

        if ProcessInfo.processInfo.environment["SIMULATOR_DEVICE_NAME"] != nil ||
            ProcessInfo.processInfo.environment["SIMULATOR_UDID"] != nil
        {
            // The iOS Simulator’s audio stack is unreliable for long-running microphone capture.
            // (We’ve observed CoreAudio deadlocks after TCC permission prompts.)
            self.isListening = false
            self.statusText = "Voice Wake isn’t supported on Simulator"
            return
        }

        self.statusText = "Requesting permissions…"

        let micOk = await Self.requestMicrophonePermission()
        guard micOk else {
            self.statusText = Self.permissionMessage(
                kind: "Microphone",
                status: AVAudioSession.sharedInstance().recordPermission)
            self.isListening = false
            return
        }

        let speechOk = await Self.requestSpeechPermission()
        guard speechOk else {
            self.statusText = Self.permissionMessage(
                kind: "Speech recognition",
                status: SFSpeechRecognizer.authorizationStatus())
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

    /// Temporarily releases the microphone so other subsystems (e.g. camera video capture) can record audio.
    /// Returns `true` when listening was active and was suspended.
    func suspendForExternalAudioCapture() -> Bool {
        guard self.isEnabled, self.isListening else { return false }

        self.isListening = false
        self.statusText = "Paused"

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
        return true
    }

    func resumeAfterExternalAudioCapture(wasSuspended: Bool) {
        guard wasSuspended else { return }
        Task { await self.start() }
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
        let tapBlock: @Sendable (AVAudioPCMBuffer, AVAudioTime) -> Void = makeAudioTapEnqueueCallback(queue: queue)
        inputNode.installTap(
            onBus: 0,
            bufferSize: 1024,
            format: recordingFormat,
            block: tapBlock)

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
            let segments = result.flatMap { result in
                transcript.map { WakeWordSpeechSegments.from(transcription: result.bestTranscription, transcript: $0) }
            } ?? []
            let errorText = error?.localizedDescription

            Task { @MainActor in
                self?.handleRecognitionCallback(transcript: transcript, segments: segments, errorText: errorText)
            }
        }
    }

    private func handleRecognitionCallback(transcript: String?, segments: [WakeWordSegment], errorText: String?) {
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
        guard let cmd = self.extractCommand(from: transcript, segments: segments) else { return }

        if cmd == self.lastDispatched { return }
        self.lastDispatched = cmd
        self.lastTriggeredCommand = cmd
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

    private func extractCommand(from transcript: String, segments: [WakeWordSegment]) -> String? {
        Self.extractCommand(from: transcript, segments: segments, triggers: self.activeTriggerWords)
    }

    nonisolated static func extractCommand(
        from transcript: String,
        segments: [WakeWordSegment],
        triggers: [String],
        minPostTriggerGap: TimeInterval = 0.45) -> String?
    {
        let config = WakeWordGateConfig(triggers: triggers, minPostTriggerGap: minPostTriggerGap)
        return WakeWordGate.match(transcript: transcript, segments: segments, config: config)?.command
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
        let session = AVAudioSession.sharedInstance()
        switch session.recordPermission {
        case .granted:
            return true
        case .denied:
            return false
        case .undetermined:
            break
        @unknown default:
            return false
        }

        return await self.requestPermissionWithTimeout { completion in
            AVAudioSession.sharedInstance().requestRecordPermission { ok in
                completion(ok)
            }
        }
    }

    private nonisolated static func requestSpeechPermission() async -> Bool {
        let status = SFSpeechRecognizer.authorizationStatus()
        switch status {
        case .authorized:
            return true
        case .denied, .restricted:
            return false
        case .notDetermined:
            break
        @unknown default:
            return false
        }

        return await self.requestPermissionWithTimeout { completion in
            SFSpeechRecognizer.requestAuthorization { authStatus in
                completion(authStatus == .authorized)
            }
        }
    }

    private nonisolated static func requestPermissionWithTimeout(
        _ operation: @escaping @Sendable (@escaping (Bool) -> Void) -> Void) async -> Bool
    {
        do {
            return try await AsyncTimeout.withTimeout(
                seconds: 8,
                onTimeout: { NSError(domain: "VoiceWake", code: 6, userInfo: [
                    NSLocalizedDescriptionKey: "permission request timed out",
                ]) },
                operation: {
                    await withCheckedContinuation(isolation: nil) { cont in
                        Task { @MainActor in
                            operation { ok in
                                cont.resume(returning: ok)
                            }
                        }
                    }
                })
        } catch {
            return false
        }
    }

    private static func permissionMessage(
        kind: String,
        status: AVAudioSession.RecordPermission) -> String
    {
        switch status {
        case .denied:
            return "\(kind) permission denied"
        case .undetermined:
            return "\(kind) permission not granted"
        case .granted:
            return "\(kind) permission denied"
        @unknown default:
            return "\(kind) permission denied"
        }
    }

    private static func permissionMessage(
        kind: String,
        status: SFSpeechRecognizerAuthorizationStatus) -> String
    {
        switch status {
        case .denied:
            return "\(kind) permission denied"
        case .restricted:
            return "\(kind) permission restricted"
        case .notDetermined:
            return "\(kind) permission not granted"
        case .authorized:
            return "\(kind) permission denied"
        @unknown default:
            return "\(kind) permission denied"
        }
    }
}

#if DEBUG
extension VoiceWakeManager {
    func _test_handleRecognitionCallback(transcript: String?, segments: [WakeWordSegment], errorText: String?) {
        self.handleRecognitionCallback(transcript: transcript, segments: segments, errorText: errorText)
    }
}
#endif
