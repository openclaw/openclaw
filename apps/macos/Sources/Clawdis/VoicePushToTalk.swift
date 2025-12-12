import AppKit
import AVFoundation
import OSLog
import Speech

/// Observes right Option and starts a push-to-talk capture while it is held.
@MainActor
final class VoicePushToTalkHotkey {
    static let shared = VoicePushToTalkHotkey()

    private var globalMonitor: Any?
    private var localMonitor: Any?
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
        guard self.globalMonitor == nil, self.localMonitor == nil else { return }
        // Listen-only global monitor; we rely on Input Monitoring permission to receive events.
        self.globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            guard let self else { return }
            self.updateModifierState(from: event)
        }
        // Also listen locally so we still catch events when the app is active/focused.
        self.localMonitor = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            self?.updateModifierState(from: event)
            return event
        }
    }

    private func stopMonitoring() {
        if let globalMonitor {
            NSEvent.removeMonitor(globalMonitor)
            self.globalMonitor = nil
        }
        if let localMonitor {
            NSEvent.removeMonitor(localMonitor)
            self.localMonitor = nil
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
        if chordActive, !self.active {
            self.active = true
            Task {
                Logger(subsystem: "com.steipete.clawdis", category: "voicewake.ptt")
                    .info("ptt hotkey down")
                await VoicePushToTalk.shared.begin()
            }
        } else if !chordActive, self.active {
            self.active = false
            Task {
                Logger(subsystem: "com.steipete.clawdis", category: "voicewake.ptt")
                    .info("ptt hotkey up")
                await VoicePushToTalk.shared.end()
            }
        }
    }
}

/// Short-lived speech recognizer that records while the hotkey is held.
actor VoicePushToTalk {
    static let shared = VoicePushToTalk()

    private let logger = Logger(subsystem: "com.steipete.clawdis", category: "voicewake.ptt")

    private var recognizer: SFSpeechRecognizer?
    private var audioEngine = AVAudioEngine()
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?

    // Session token used to drop stale callbacks when a new capture starts.
    private var sessionID = UUID()

    private var committed: String = ""
    private var volatile: String = ""
    private var activeConfig: Config?
    private var isCapturing = false
    private var triggerChimePlayed = false
    private var finalized = false
    private var timeoutTask: Task<Void, Never>?
    private var overlayToken: UUID?
    private var adoptedPrefix: String = ""

    private struct Config {
        let micID: String?
        let localeID: String?
        let triggerChime: VoiceWakeChime
        let sendChime: VoiceWakeChime
    }

    func begin() async {
        guard voiceWakeSupported else { return }
        guard !self.isCapturing else { return }

        // Start a fresh session and invalidate any in-flight callbacks tied to an older one.
        let sessionID = UUID()
        self.sessionID = sessionID

        // Ensure permissions up front.
        let granted = await PermissionManager.ensureVoiceWakePermissions(interactive: true)
        guard granted else { return }

        let config = await MainActor.run { self.makeConfig() }
        self.activeConfig = config
        self.isCapturing = true
        self.triggerChimePlayed = false
        self.finalized = false
        self.timeoutTask?.cancel(); self.timeoutTask = nil
        let snapshot = await MainActor.run { VoiceSessionCoordinator.shared.snapshot() }
        self.adoptedPrefix = snapshot.visible ? snapshot.text.trimmingCharacters(in: .whitespacesAndNewlines) : ""
        self.logger.info("ptt begin adopted_prefix_len=\(self.adoptedPrefix.count, privacy: .public)")
        if config.triggerChime != .none {
            self.triggerChimePlayed = true
            await MainActor.run { VoiceWakeChimePlayer.play(config.triggerChime, reason: "ptt.trigger") }
        }
        // Pause the always-on wake word recognizer so both pipelines don't fight over the mic tap.
        await VoiceWakeRuntime.shared.pauseForPushToTalk()
        let adoptedPrefix = self.adoptedPrefix
        let adoptedAttributed: NSAttributedString? = adoptedPrefix.isEmpty ? nil : Self.makeAttributed(
            committed: adoptedPrefix,
            volatile: "",
            isFinal: false)
        self.overlayToken = await MainActor.run {
            VoiceSessionCoordinator.shared.startSession(
                source: .pushToTalk,
                text: adoptedPrefix,
                attributed: adoptedAttributed,
                forwardEnabled: true)
        }

        do {
            try await self.startRecognition(localeID: config.localeID, sessionID: sessionID)
        } catch {
            await MainActor.run {
                VoiceWakeOverlayController.shared.dismiss()
            }
            self.isCapturing = false
            // If push-to-talk fails to start after pausing wake-word, ensure we resume listening.
            await VoiceWakeRuntime.shared.applyPushToTalkCooldown()
            await VoiceWakeRuntime.shared.refresh(state: AppStateStore.shared)
        }
    }

    func end() async {
        guard self.isCapturing else { return }
        self.isCapturing = false
        let sessionID = self.sessionID

        self.recognitionRequest?.endAudio()
        self.audioEngine.inputNode.removeTap(onBus: 0)
        self.audioEngine.stop()

        // If we captured nothing, dismiss immediately when the user lets go.
        if self.committed.isEmpty, self.volatile.isEmpty, self.adoptedPrefix.isEmpty {
            await self.finalize(transcriptOverride: "", reason: "emptyOnRelease", sessionID: sessionID)
            return
        }

        // Otherwise, give Speech a brief window to deliver the final result; then fall back.
        self.timeoutTask?.cancel()
        self.timeoutTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_500_000_000) // 1.5s grace period to await final result
            await self?.finalize(transcriptOverride: nil, reason: "timeout", sessionID: sessionID)
        }
    }

    // MARK: - Private

    private func startRecognition(localeID: String?, sessionID: UUID) async throws {
        let locale = localeID.flatMap { Locale(identifier: $0) } ?? Locale(identifier: Locale.current.identifier)
        self.recognizer = SFSpeechRecognizer(locale: locale)
        guard let recognizer, recognizer.isAvailable else {
            throw NSError(
                domain: "VoicePushToTalk",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Recognizer unavailable"])
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
                self.logger.debug("push-to-talk error: \(error.localizedDescription, privacy: .public)")
            }
            let transcript = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            // Hop to a Task so UI updates stay off the Speech callback thread.
            Task.detached { [weak self, transcript, isFinal, sessionID] in
                guard let self else { return }
                await self.handle(transcript: transcript, isFinal: isFinal, sessionID: sessionID)
            }
        }
    }

    private func handle(transcript: String?, isFinal: Bool, sessionID: UUID) async {
        guard sessionID == self.sessionID else {
            self.logger.debug("push-to-talk drop transcript for stale session")
            return
        }
        guard let transcript else { return }
        if isFinal {
            self.committed = transcript
            self.volatile = ""
        } else {
            self.volatile = Self.delta(after: self.committed, current: transcript)
        }

        let committedWithPrefix = Self.join(self.adoptedPrefix, self.committed)
        let snapshot = Self.join(committedWithPrefix, self.volatile)
        let attributed = Self.makeAttributed(committed: committedWithPrefix, volatile: self.volatile, isFinal: isFinal)
        if let token = self.overlayToken {
            await MainActor.run {
                VoiceSessionCoordinator.shared.updatePartial(
                    token: token,
                    text: snapshot,
                    attributed: attributed)
            }
        }
    }

    private func finalize(transcriptOverride: String?, reason: String, sessionID: UUID?) async {
        if self.finalized { return }
        if let sessionID, sessionID != self.sessionID {
            self.logger.debug("push-to-talk drop finalize for stale session")
            return
        }
        self.finalized = true
        self.isCapturing = false
        self.timeoutTask?.cancel(); self.timeoutTask = nil

        let finalRecognized: String = {
            if let override = transcriptOverride?.trimmingCharacters(in: .whitespacesAndNewlines) {
                return override
            }
            return (self.committed + self.volatile).trimmingCharacters(in: .whitespacesAndNewlines)
        }()
        let finalText = Self.join(self.adoptedPrefix, finalRecognized)
        let chime = finalText.isEmpty ? .none : (self.activeConfig?.sendChime ?? .none)

        let token = self.overlayToken
        let logger = self.logger
        await MainActor.run {
            logger.info("ptt finalize reason=\(reason, privacy: .public) len=\(finalText.count, privacy: .public)")
            if let token {
                VoiceSessionCoordinator.shared.finalize(
                    token: token,
                    text: finalText,
                    sendChime: chime,
                    autoSendAfter: nil)
                VoiceSessionCoordinator.shared.sendNow(token: token, reason: reason)
            } else if !finalText.isEmpty {
                if chime != .none {
                    VoiceWakeChimePlayer.play(chime, reason: "ptt.fallback_send")
                }
                Task.detached {
                    await VoiceWakeForwarder.forward(transcript: finalText)
                }
            }
        }

        self.recognitionTask?.cancel()
        self.recognitionRequest = nil
        self.recognitionTask = nil
        self.audioEngine.inputNode.removeTap(onBus: 0)
        self.audioEngine.stop()

        self.committed = ""
        self.volatile = ""
        self.activeConfig = nil
        self.triggerChimePlayed = false
        self.overlayToken = nil
        self.adoptedPrefix = ""

        // Resume the wake-word runtime after push-to-talk finishes.
        await VoiceWakeRuntime.shared.applyPushToTalkCooldown()
        _ = await MainActor.run { Task { await VoiceWakeRuntime.shared.refresh(state: AppStateStore.shared) } }
    }

    @MainActor
    private func makeConfig() -> Config {
        let state = AppStateStore.shared
        return Config(
            micID: state.voiceWakeMicID.isEmpty ? nil : state.voiceWakeMicID,
            localeID: state.voiceWakeLocaleID,
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

    private static func join(_ prefix: String, _ suffix: String) -> String {
        if prefix.isEmpty { return suffix }
        if suffix.isEmpty { return prefix }
        return "\(prefix) \(suffix)"
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
