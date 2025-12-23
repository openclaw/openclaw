import AVFoundation
import Foundation
import OSLog
import Speech
import SwabbleKit

enum VoiceWakeTestState: Equatable {
    case idle
    case requesting
    case listening
    case hearing(String)
    case detected(String)
    case failed(String)
}

final class VoiceWakeTester {
    private let recognizer: SFSpeechRecognizer?
    private let audioEngine = AVAudioEngine()
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var isStopping = false
    private var detectionStart: Date?
    private var lastHeard: Date?
    private var holdingAfterDetect = false
    private var detectedText: String?
    private let logger = Logger(subsystem: "com.steipete.clawdis", category: "voicewake")
    private let silenceWindow: TimeInterval = 1.0

    init(locale: Locale = .current) {
        self.recognizer = SFSpeechRecognizer(locale: locale)
    }

    func start(
        triggers: [String],
        micID: String?,
        localeID: String?,
        onUpdate: @escaping @Sendable (VoiceWakeTestState) -> Void) async throws
    {
        guard self.recognitionTask == nil else { return }
        self.isStopping = false
        let chosenLocale = localeID.flatMap { Locale(identifier: $0) } ?? Locale.current
        let recognizer = SFSpeechRecognizer(locale: chosenLocale)
        guard let recognizer, recognizer.isAvailable else {
            throw NSError(
                domain: "VoiceWakeTester",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Speech recognition unavailable"])
        }

        guard Self.hasPrivacyStrings else {
            throw NSError(
                domain: "VoiceWakeTester",
                code: 3,
                userInfo: [
                    NSLocalizedDescriptionKey: """
                    Missing mic/speech privacy strings. Rebuild the mac app (scripts/restart-mac.sh) \
                    to include usage descriptions.
                    """,
                ])
        }

        let granted = try await Self.ensurePermissions()
        guard granted else {
            throw NSError(
                domain: "VoiceWakeTester",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Microphone or speech permission denied"])
        }

        self.configureSession(preferredMicID: micID)

        self.recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        self.recognitionRequest?.shouldReportPartialResults = true
        let request = self.recognitionRequest

        let inputNode = self.audioEngine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        inputNode.removeTap(onBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak request] buffer, _ in
            request?.append(buffer)
        }

        self.audioEngine.prepare()
        try self.audioEngine.start()
        DispatchQueue.main.async {
            onUpdate(.listening)
        }

        self.detectionStart = Date()
        self.lastHeard = self.detectionStart

        guard let request = recognitionRequest else { return }

        self.recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self, !self.isStopping else { return }
            let text = result?.bestTranscription.formattedString ?? ""
            let segments = result.map { WakeWordSpeechSegments.from(transcription: $0.bestTranscription, transcript: text) } ?? []
            let gateConfig = WakeWordGateConfig(triggers: triggers)
            let match = WakeWordGate.match(transcript: text, segments: segments, config: gateConfig)
            let isFinal = result?.isFinal ?? false
            let errorMessage = error?.localizedDescription

            Task { [weak self] in
                guard let self, !self.isStopping else { return }
                await self.handleResult(
                    match: match,
                    text: text,
                    isFinal: isFinal,
                    errorMessage: errorMessage,
                    onUpdate: onUpdate)
            }
        }
    }

    func stop() {
        self.isStopping = true
        self.audioEngine.stop()
        self.recognitionRequest?.endAudio()
        self.recognitionTask?.cancel()
        self.recognitionTask = nil
        self.recognitionRequest = nil
        self.audioEngine.inputNode.removeTap(onBus: 0)
    }

    private func handleResult(
        match: WakeWordGateMatch?,
        text: String,
        isFinal: Bool,
        errorMessage: String?,
        onUpdate: @escaping @Sendable (VoiceWakeTestState) -> Void) async
    {
        if !text.isEmpty {
            self.lastHeard = Date()
        }
        if let match, !match.command.isEmpty {
            self.holdingAfterDetect = true
            self.detectedText = match.command
            self.logger.info("voice wake detected; forwarding (len=\(match.command.count))")
            await MainActor.run { AppStateStore.shared.triggerVoiceEars(ttl: nil) }
            Task.detached {
                await VoiceWakeForwarder.forward(transcript: match.command)
            }
            Task { @MainActor in onUpdate(.detected(match.command)) }
            self.holdUntilSilence(onUpdate: onUpdate)
            return
        }
        if let errorMessage {
            self.stop()
            Task { @MainActor in onUpdate(.failed(errorMessage)) }
            return
        }
        if isFinal {
            self.stop()
            let state: VoiceWakeTestState = text.isEmpty
                ? .failed("No speech detected")
                : .failed("No trigger heard: “\(text)”")
            Task { @MainActor in onUpdate(state) }
        } else {
            let state: VoiceWakeTestState = text.isEmpty ? .listening : .hearing(text)
            Task { @MainActor in onUpdate(state) }
        }
    }

    private func holdUntilSilence(onUpdate: @escaping @Sendable (VoiceWakeTestState) -> Void) {
        Task { [weak self] in
            guard let self else { return }
            let detectedAt = Date()
            let hardStop = detectedAt.addingTimeInterval(6) // cap overall listen after trigger

            while !self.isStopping {
                let now = Date()
                if now >= hardStop { break }
                if let last = self.lastHeard, now.timeIntervalSince(last) >= silenceWindow {
                    break
                }
                try? await Task.sleep(nanoseconds: 200_000_000)
            }
            if !self.isStopping {
                self.stop()
                await MainActor.run { AppStateStore.shared.stopVoiceEars() }
                if let detectedText {
                    self.logger.info("voice wake hold finished; len=\(detectedText.count)")
                    Task { @MainActor in onUpdate(.detected(detectedText)) }
                }
            }
        }
    }

    private func configureSession(preferredMicID: String?) {
        _ = preferredMicID
    }

    private nonisolated static func ensurePermissions() async throws -> Bool {
        let speechStatus = SFSpeechRecognizer.authorizationStatus()
        if speechStatus == .notDetermined {
            let granted = await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { status in
                    continuation.resume(returning: status == .authorized)
                }
            }
            guard granted else { return false }
        } else if speechStatus != .authorized {
            return false
        }

        let micStatus = AVCaptureDevice.authorizationStatus(for: .audio)
        switch micStatus {
        case .authorized: return true

        case .notDetermined:
            return await withCheckedContinuation { continuation in
                AVCaptureDevice.requestAccess(for: .audio) { granted in
                    continuation.resume(returning: granted)
                }
            }

        default:
            return false
        }
    }

    private static var hasPrivacyStrings: Bool {
        let speech = Bundle.main.object(forInfoDictionaryKey: "NSSpeechRecognitionUsageDescription") as? String
        let mic = Bundle.main.object(forInfoDictionaryKey: "NSMicrophoneUsageDescription") as? String
        return speech?.isEmpty == false && mic?.isEmpty == false
    }
}

extension VoiceWakeTester: @unchecked Sendable {}
