import AppKit
import AVFoundation
import OSLog
import Speech

/// Observes right Option and starts a push-to-talk capture while it is held.
@MainActor
final class VoicePushToTalkHotkey {
    static let shared = VoicePushToTalkHotkey()

    private var monitor: Any?
    private var optionDown = false // right option only
    private var active = false

    func setEnabled(_ enabled: Bool) {
        if enabled {
            self.startMonitoring()
        } else {
            self.stopMonitoring()
        }
    }

    private func startMonitoring() {
        guard self.monitor == nil else { return }
        // Listen-only global monitor; we rely on Input Monitoring permission to receive events.
        self.monitor = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            guard let self else { return }
            self.updateModifierState(from: event)
        }
    }

    private func stopMonitoring() {
        if let monitor {
            NSEvent.removeMonitor(monitor)
            self.monitor = nil
        }
        self.optionDown = false
        self.active = false
    }

    private func updateModifierState(from event: NSEvent) {
        // Right Option (keyCode 61) acts as a hold-to-talk modifier.
        if event.keyCode == 61 {
            self.optionDown = event.modifierFlags.contains(.option)
        }

        let chordActive = self.optionDown
        if chordActive && !self.active {
            self.active = true
            Task {
                await VoicePushToTalk.shared.begin()
            }
        } else if !chordActive && self.active {
            self.active = false
            Task {
                await VoicePushToTalk.shared.end()
            }
        }
    }
}

/// Short-lived speech recognizer that records while the hotkey is held.
actor VoicePushToTalk {
    static let shared = VoicePushToTalk()

    private var recognizer: SFSpeechRecognizer?
    private var audioEngine = AVAudioEngine()
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?

    private var committed: String = ""
    private var volatile: String = ""
    private var activeConfig: Config?
    private var isCapturing = false
    private var triggerChimePlayed = false

    private struct Config {
        let micID: String?
        let localeID: String?
        let forwardConfig: VoiceWakeForwardConfig
        let triggerChime: VoiceWakeChime
        let sendChime: VoiceWakeChime
    }

    func begin() async {
        guard voiceWakeSupported else { return }
        guard !self.isCapturing else { return }

        // Ensure permissions up front.
        let granted = await PermissionManager.ensureVoiceWakePermissions(interactive: true)
        guard granted else { return }

        let config = await MainActor.run { self.makeConfig() }
        self.activeConfig = config
        self.isCapturing = true
        self.triggerChimePlayed = false
        if config.triggerChime != .none {
            self.triggerChimePlayed = true
            await MainActor.run { VoiceWakeChimePlayer.play(config.triggerChime) }
        }
        // Pause the always-on wake word recognizer so both pipelines don't fight over the mic tap.
        await VoiceWakeRuntime.shared.pauseForPushToTalk()
        await MainActor.run {
            VoiceWakeOverlayController.shared.showPartial(transcript: "")
        }

        do {
            try await self.startRecognition(localeID: config.localeID)
        } catch {
            await MainActor.run {
                VoiceWakeOverlayController.shared.dismiss()
            }
            self.isCapturing = false
        }
    }

    func end() async {
        guard self.isCapturing else { return }
        self.isCapturing = false

        self.recognitionTask?.cancel()
        self.recognitionRequest?.endAudio()
        self.recognitionRequest = nil
        self.recognitionTask = nil
        self.audioEngine.inputNode.removeTap(onBus: 0)
        self.audioEngine.stop()

        let finalText = (self.committed + self.volatile).trimmingCharacters(in: .whitespacesAndNewlines)
        let attributed = Self.makeAttributed(committed: self.committed, volatile: self.volatile, isFinal: true)
        let forward: VoiceWakeForwardConfig
        if let cached = self.activeConfig?.forwardConfig {
            forward = cached
        } else {
            forward = await MainActor.run { AppStateStore.shared.voiceWakeForwardConfig }
        }

        let chime = finalText.isEmpty ? .none : (self.activeConfig?.sendChime ?? .none)

        await MainActor.run {
            if finalText.isEmpty {
                VoiceWakeOverlayController.shared.dismiss(reason: .empty)
            } else {
                VoiceWakeOverlayController.shared.presentFinal(
                    transcript: finalText,
                    forwardConfig: forward,
                    autoSendAfter: nil,
                    sendChime: chime,
                    attributed: attributed)
                VoiceWakeOverlayController.shared.sendNow(sendChime: chime)
            }
        }

        self.committed = ""
        self.volatile = ""
        self.activeConfig = nil
        self.triggerChimePlayed = false

        // Resume the wake-word runtime after push-to-talk finishes.
        _ = await MainActor.run {
            Task {
                await VoiceWakeRuntime.shared.refresh(state: AppStateStore.shared)
            }
        }
    }

    // MARK: - Private

    private func startRecognition(localeID: String?) async throws {
        let locale = localeID.flatMap { Locale(identifier: $0) } ?? Locale(identifier: Locale.current.identifier)
        self.recognizer = SFSpeechRecognizer(locale: locale)
        guard let recognizer, recognizer.isAvailable else {
            throw NSError(domain: "VoicePushToTalk", code: 1, userInfo: [NSLocalizedDescriptionKey: "Recognizer unavailable"])
        }

        self.recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        self.recognitionRequest?.shouldReportPartialResults = true
        guard let request = self.recognitionRequest else { return }

        let input = self.audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        // Pipe raw mic buffers into the Speech request while the chord is held.
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak request] buffer, _ in
            request?.append(buffer)
        }

        self.audioEngine.prepare()
        try self.audioEngine.start()

        self.recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            if let error {
                Logger(subsystem: "com.steipete.clawdis", category: "voicewake.ptt")
                    .debug("push-to-talk error: \(error.localizedDescription, privacy: .public)")
            }
            let transcript = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            // Hop to a Task so UI updates stay off the Speech callback thread.
            Task.detached { [weak self, transcript, isFinal] in
                guard let self else { return }
                await self.handle(transcript: transcript, isFinal: isFinal)
            }
        }
    }

    private func handle(transcript: String?, isFinal: Bool) async {
        guard let transcript else { return }
        if isFinal {
            self.committed = transcript
            self.volatile = ""
        } else {
            self.volatile = Self.delta(after: self.committed, current: transcript)
        }

        let snapshot = self.committed + self.volatile
        let attributed = Self.makeAttributed(committed: self.committed, volatile: self.volatile, isFinal: isFinal)
        await MainActor.run {
            VoiceWakeOverlayController.shared.showPartial(transcript: snapshot, attributed: attributed)
        }
    }

    @MainActor
    private func makeConfig() -> Config {
        let state = AppStateStore.shared
        return Config(
            micID: state.voiceWakeMicID.isEmpty ? nil : state.voiceWakeMicID,
            localeID: state.voiceWakeLocaleID,
            forwardConfig: state.voiceWakeForwardConfig,
            triggerChime: state.voiceWakeTriggerChime,
            sendChime: state.voiceWakeSendChime)
    }

    // MARK: - Test helpers

    static func _testDelta(committed: String, current: String) -> String {
        self.delta(after: committed, current: current)
    }

    static func _testAttributedColors(isFinal: Bool) -> (NSColor, NSColor) {
        let sample = self.makeAttributed(committed: "a", volatile: "b", isFinal: isFinal)
        let committedColor = sample.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? NSColor ?? .clear
        let volatileColor = sample.attribute(.foregroundColor, at: 1, effectiveRange: nil) as? NSColor ?? .clear
        return (committedColor, volatileColor)
    }

    private static func delta(after committed: String, current: String) -> String {
        if current.hasPrefix(committed) {
            let start = current.index(current.startIndex, offsetBy: committed.count)
            return String(current[start...])
        }
        return current
    }

    private static func makeAttributed(committed: String, volatile: String, isFinal: Bool) -> NSAttributedString {
        let full = NSMutableAttributedString()
        let committedAttr: [NSAttributedString.Key: Any] = [
            .foregroundColor: NSColor.labelColor,
            .font: NSFont.systemFont(ofSize: 13, weight: .regular),
        ]
        full.append(NSAttributedString(string: committed, attributes: committedAttr))
        let volatileColor: NSColor = isFinal ? .labelColor : NSColor.tertiaryLabelColor
        let volatileAttr: [NSAttributedString.Key: Any] = [
            .foregroundColor: volatileColor,
            .font: NSFont.systemFont(ofSize: 13, weight: .regular),
        ]
        full.append(NSAttributedString(string: volatile, attributes: volatileAttr))
        return full
    }
}
