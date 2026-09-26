import AVFoundation
import Foundation
import Speech
import SwabbleKit

enum VoiceWakeTestState: Equatable {
    case idle
    case requesting
    case listening
    case hearing(String)
    case finalizing
    case detected(String)
    case failed(String)
}

final class VoiceWakeTester {
    private var audioEngine: AVAudioEngine?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var isStopping = false
    private var isFinalizing = false
    private var lastLoggedText: String?
    private var lastLoggedAt: Date?
    private var lastTranscript: String?
    private var lastTranscriptAt: Date?
    private var silenceTask: Task<Void, Never>?
    private var currentTriggers: [String] = []
    private var holdingAfterDetect = false
    private let logger = Logger(subsystem: "ai.openclaw", category: "voicewake")
    private let silenceWindow: TimeInterval = 1.0

    func start(
        triggers: [String],
        micID: String?,
        localeID: String?,
        onUpdate: @escaping @Sendable (VoiceWakeTestState) -> Void) async throws
    {
        guard self.recognitionTask == nil else { return }
        self.isStopping = false
        self.isFinalizing = false
        self.holdingAfterDetect = false
        self.lastLoggedText = nil
        self.lastLoggedAt = nil
        self.lastTranscript = nil
        self.lastTranscriptAt = nil
        self.silenceTask?.cancel()
        self.silenceTask = nil
        self.currentTriggers = triggers
        let chosenLocale = localeID.flatMap { Locale(identifier: $0) } ?? Locale.current
        let recognizer = SFSpeechRecognizer(locale: chosenLocale)
        guard let recognizer, recognizer.isAvailable else {
            throw NSError(
                domain: "VoiceWakeTester",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Speech recognition unavailable"])
        }
        guard recognizer.supportsOnDeviceRecognition else {
            throw SpeechRecognitionRequestPolicy.PolicyError.onDeviceRecognitionUnavailable
        }
        recognizer.defaultTaskHint = .dictation

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
        // The test panel may close while a system permission prompt is open.
        try Task.checkCancellation()
        guard granted else {
            throw NSError(
                domain: "VoiceWakeTester",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Microphone or speech permission denied"])
        }

        self.logInputSelection(preferredMicID: micID)

        guard AudioInputDeviceObserver.hasUsableDefaultInputDevice() else {
            self.audioEngine = nil
            throw NSError(
                domain: "VoiceWakeTester",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "No usable audio input device available"])
        }

        let engine = AVAudioEngine()
        self.audioEngine = engine

        let request = SFSpeechAudioBufferRecognitionRequest()
        self.recognitionRequest = request
        try SpeechRecognitionRequestPolicy.configurePassiveVoiceWake(
            request,
            supportsOnDeviceRecognition: recognizer.supportsOnDeviceRecognition)

        let inputNode = engine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        guard format.channelCount > 0, format.sampleRate > 0 else {
            self.audioEngine = nil
            throw NSError(
                domain: "VoiceWakeTester",
                code: 4,
                userInfo: [NSLocalizedDescriptionKey: "No audio input available"])
        }
        inputNode.removeTap(onBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak request] buffer, _ in
            request?.append(SpeechAudioBufferNormalizer.speechCompatibleBuffer(from: buffer))
        }

        engine.prepare()
        try engine.start()
        DispatchQueue.main.async {
            onUpdate(.listening)
        }

        guard let activeRequest = recognitionRequest else { return }

        self.recognitionTask = recognizer.recognitionTask(with: activeRequest) { [weak self] result, error in
            guard let self, !self.isStopping else { return }
            let text = result?.bestTranscription.formattedString ?? ""
            let segments = result.map { WakeWordSpeechSegments.from(
                transcription: $0.bestTranscription,
                transcript: text) } ?? []
            let isFinal = result?.isFinal ?? false
            let gateConfig = WakeWordGateConfig(triggers: triggers)
            var match = WakeWordGate.match(transcript: text, segments: segments, config: gateConfig)
            if match == nil, isFinal {
                match = VoiceWakeRecognitionDebugSupport.textOnlyFallbackMatch(
                    transcript: text,
                    triggers: triggers,
                    config: gateConfig,
                    trimWake: WakeWordGate.stripWake)
            }
            self.maybeLogDebug(
                transcript: text,
                segments: segments,
                triggers: triggers,
                match: match,
                isFinal: isFinal)
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

    func finalize(timeout: TimeInterval = 1.5) {
        guard self.recognitionTask != nil else {
            self.stop()
            return
        }
        self.isFinalizing = true
        self.recognitionRequest?.endAudio()
        if let engine = self.audioEngine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            if !self.isStopping {
                self.stop()
            }
        }
    }

    func stop() {
        self.isStopping = true
        self.isFinalizing = false
        self.recognitionRequest?.endAudio()
        self.recognitionTask?.cancel()
        self.recognitionTask = nil
        self.recognitionRequest = nil
        if let engine = self.audioEngine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        self.audioEngine = nil
        self.holdingAfterDetect = false
        self.lastLoggedText = nil
        self.lastLoggedAt = nil
        self.lastTranscript = nil
        self.lastTranscriptAt = nil
        self.silenceTask?.cancel()
        self.silenceTask = nil
        self.currentTriggers = []
    }

    private func handleResult(
        match: WakeWordGateMatch?,
        text: String,
        isFinal: Bool,
        errorMessage: String?,
        onUpdate: @escaping @Sendable (VoiceWakeTestState) -> Void) async
    {
        if !text.isEmpty {
            self.lastTranscript = text
            self.lastTranscriptAt = Date()
        }
        if self.holdingAfterDetect {
            return
        }
        let triggerOnlyMatch = match == nil
            ? VoiceWakeRecognitionDebugSupport.triggerOnlyFallbackMatch(
                transcript: text,
                triggers: self.currentTriggers,
                trimWake: WakeWordGate.stripWake)
            : nil
        let acceptedMatch = match.flatMap { $0.command.isEmpty ? nil : $0 } ?? triggerOnlyMatch
        if let match = acceptedMatch {
            self.holdingAfterDetect = true
            let detectedText = match.command.isEmpty ? (match.trigger ?? text) : match.command
            self.logger.info("voice wake detected (test) (len=\(detectedText.count))")
            await MainActor.run { AppStateStore.shared.startVoiceEars() }
            self.stop()
            await MainActor.run {
                AppStateStore.shared.stopVoiceEars()
                onUpdate(.detected(detectedText))
            }
            return
        }
        if !isFinal, !text.isEmpty {
            self.scheduleSilenceCheck(
                triggers: self.currentTriggers,
                onUpdate: onUpdate)
        }
        if self.isFinalizing {
            Task { @MainActor in onUpdate(.finalizing) }
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

    private func maybeLogDebug(
        transcript: String,
        segments: [WakeWordSegment],
        triggers: [String],
        match: WakeWordGateMatch?,
        isFinal: Bool)
    {
        guard VoiceWakeRecognitionDebugSupport.shouldLogTranscript(
            transcript: transcript,
            isFinal: isFinal,
            loggerLevel: self.logger.logLevel,
            lastLoggedText: &self.lastLoggedText,
            lastLoggedAt: &self.lastLoggedAt)
        else { return }

        let summary = VoiceWakeRecognitionDebugSupport.transcriptSummary(
            transcript: transcript,
            triggers: triggers,
            segments: segments)
        let matchSummary = VoiceWakeRecognitionDebugSupport.matchSummary(match)

        self.logger.debug(
            "voicewake test transcript='\(transcript, privacy: .private)' textOnly=\(summary.textOnly) " +
                "isFinal=\(isFinal) timing=\(summary.timingCount)/\(segments.count) " +
                "\(matchSummary) " +
                "gaps=[\(Self.debugCandidateGaps(triggers: triggers, segments: segments), privacy: .private)] " +
                "segments=[\(VoiceWakeRecognitionDebugSupport.segmentSummary(segments), privacy: .private)]")
    }

    private static func debugCandidateGaps(triggers: [String], segments: [WakeWordSegment]) -> String {
        let tokens = self.normalizeSegments(segments)
        guard !tokens.isEmpty else { return "" }
        let triggerTokens = triggers.map(VoiceWakeTextUtils.normalizedTokens)
        var gaps: [String] = []

        for trigger in triggerTokens {
            let count = trigger.count
            guard count > 0, tokens.count > count else { continue }
            for i in 0...(tokens.count - count - 1) {
                let matched = (0..<count).allSatisfy { tokens[i + $0].normalized == trigger[$0] }
                if !matched { continue }
                let triggerEnd = tokens[i + count - 1].end
                let nextToken = tokens[i + count]
                let gap = nextToken.start - triggerEnd
                let formatted = String(format: "%.2f", gap)
                gaps.append("\(trigger.joined(separator: " ")):\(formatted)s")
            }
        }
        return gaps.joined(separator: ", ")
    }

    private struct DebugToken {
        let normalized: String
        let start: TimeInterval
        let end: TimeInterval
    }

    private static func normalizeSegments(_ segments: [WakeWordSegment]) -> [DebugToken] {
        segments.compactMap { segment in
            let normalized = VoiceWakeTextUtils.normalizeToken(segment.text)
            guard !normalized.isEmpty else { return nil }
            return DebugToken(
                normalized: normalized,
                start: segment.start,
                end: segment.end)
        }
    }

    private func scheduleSilenceCheck(
        triggers: [String],
        onUpdate: @escaping @Sendable (VoiceWakeTestState) -> Void)
    {
        self.silenceTask?.cancel()
        let lastSeenAt = self.lastTranscriptAt
        let lastText = self.lastTranscript
        self.silenceTask = Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(nanoseconds: UInt64(self.silenceWindow * 1_000_000_000))
            guard !Task.isCancelled else { return }
            guard !self.isStopping, !self.holdingAfterDetect else { return }
            guard let lastSeenAt, let lastText else { return }
            guard self.lastTranscriptAt == lastSeenAt, self.lastTranscript == lastText else { return }
            let gateConfig = WakeWordGateConfig(triggers: triggers)
            let match = VoiceWakeRecognitionDebugSupport.textOnlyFallbackMatch(
                transcript: lastText,
                triggers: triggers,
                config: gateConfig,
                trimWake: WakeWordGate.stripWake)
                ?? VoiceWakeRecognitionDebugSupport.triggerOnlyFallbackMatch(
                    transcript: lastText,
                    triggers: triggers,
                    trimWake: WakeWordGate.stripWake)
            guard let match else { return }
            self.holdingAfterDetect = true
            let detectedText = match.command.isEmpty ? (match.trigger ?? lastText) : match.command
            self.logger.info("voice wake detected (test, silence) (len=\(detectedText.count))")
            await MainActor.run { AppStateStore.shared.startVoiceEars() }
            self.stop()
            await MainActor.run {
                AppStateStore.shared.stopVoiceEars()
                onUpdate(.detected(detectedText))
            }
        }
    }

    private func logInputSelection(preferredMicID: String?) {
        let preferred = (preferredMicID?.isEmpty == false) ? preferredMicID! : "system-default"
        self.logger.info(
            "voicewake test input preferred=\(preferred, privacy: .public) " +
                "\(AudioInputDeviceObserver.defaultInputDeviceSummary(), privacy: .public)")
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
