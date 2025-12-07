import AVFoundation
import Foundation
import OSLog
import Speech

/// Background listener that keeps the voice-wake pipeline alive outside the settings test view.
actor VoiceWakeRuntime {
    static let shared = VoiceWakeRuntime()

    private let logger = Logger(subsystem: "com.steipete.clawdis", category: "voicewake.runtime")

    private var recognizer: SFSpeechRecognizer?
    private var audioEngine = AVAudioEngine()
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var lastHeard: Date?
    private var cooldownUntil: Date?
    private var currentConfig: RuntimeConfig?

    struct RuntimeConfig: Equatable {
        let triggers: [String]
        let micID: String?
        let localeID: String?
    }

    func refresh(state: AppState) async {
        let snapshot = await MainActor.run { () -> (Bool, RuntimeConfig) in
            let enabled = state.swabbleEnabled
            let config = RuntimeConfig(
                triggers: state.swabbleTriggerWords,
                micID: state.voiceWakeMicID.isEmpty ? nil : state.voiceWakeMicID,
                localeID: state.voiceWakeLocaleID.isEmpty ? nil : state.voiceWakeLocaleID)
            return (enabled, config)
        }

        guard voiceWakeSupported, snapshot.0 else {
            stop()
            return
        }

        guard PermissionManager.voiceWakePermissionsGranted() else {
            logger.debug("voicewake runtime not starting: permissions missing")
            stop()
            return
        }

        let config = snapshot.1

        if config == currentConfig, recognitionTask != nil {
            return
        }

        stop()
        await start(with: config)
    }

    private func start(with config: RuntimeConfig) async {
        do {
            configureSession(localeID: config.localeID)

            self.recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
            self.recognitionRequest?.shouldReportPartialResults = true
            guard let request = self.recognitionRequest else { return }

            let input = audioEngine.inputNode
            let format = input.outputFormat(forBus: 0)
            input.removeTap(onBus: 0)
            input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak request] buffer, _ in
                request?.append(buffer)
            }

            audioEngine.prepare()
            try audioEngine.start()

            currentConfig = config
            lastHeard = Date()
            cooldownUntil = nil

            self.recognitionTask = recognizer?.recognitionTask(with: request) { [weak self] result, error in
                guard let self else { return }
                let transcript = result?.bestTranscription.formattedString
                Task { await self.handleRecognition(transcript: transcript, error: error, config: config) }
            }

            logger.info("voicewake runtime started")
        } catch {
            logger.error("voicewake runtime failed to start: \(error.localizedDescription, privacy: .public)")
            stop()
        }
    }

    private func stop() {
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest?.endAudio()
        recognitionRequest = nil
        audioEngine.inputNode.removeTap(onBus: 0)
        audioEngine.stop()
        currentConfig = nil
        logger.debug("voicewake runtime stopped")
    }

    private func configureSession(localeID: String?) {
        let locale = localeID.flatMap { Locale(identifier: $0) } ?? Locale(identifier: Locale.current.identifier)
        self.recognizer = SFSpeechRecognizer(locale: locale)
    }

    private func handleRecognition(
        transcript: String?,
        error: Error?,
        config: RuntimeConfig) async {
        if let error {
            logger.debug("voicewake recognition error: \(error.localizedDescription, privacy: .public)")
        }

        guard let transcript else { return }
        if !transcript.isEmpty { lastHeard = Date() }

        if Self.matches(text: transcript, triggers: config.triggers) {
            let now = Date()
            if let cooldown = cooldownUntil, now < cooldown {
                return
            }
            cooldownUntil = now.addingTimeInterval(2.5)
            await MainActor.run { AppStateStore.shared.triggerVoiceEars() }
            let forwardConfig = await MainActor.run { AppStateStore.shared.voiceWakeForwardConfig }
            if forwardConfig.enabled {
                Task.detached {
                    await VoiceWakeForwarder.forward(transcript: transcript, config: forwardConfig)
                }
            }
        }
    }

    private static func matches(text: String, triggers: [String]) -> Bool {
        guard !text.isEmpty else { return false }
        let normalized = text.lowercased()
        for trigger in triggers {
            let t = trigger.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
            if t.isEmpty { continue }
            if normalized.contains(t) { return true }
        }
        return false
    }

#if DEBUG
    static func _testMatches(text: String, triggers: [String]) -> Bool {
        Self.matches(text: text, triggers: triggers)
    }
#endif
}
