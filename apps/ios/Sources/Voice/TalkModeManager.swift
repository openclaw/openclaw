import AVFAudio
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import Foundation
import Observation
import OSLog
import Speech

// This file intentionally centralizes talk mode state + behavior.
// It's large, and splitting would force `private` -> `fileprivate` across many members.
// We'll refactor into smaller files when the surface stabilizes.
// swiftlint:disable type_body_length
@MainActor
@Observable
final class TalkModeManager: NSObject {
    private typealias SpeechRequest = SFSpeechAudioBufferRecognitionRequest
    private static let defaultModelIdFallback = "eleven_v3"
    var isEnabled: Bool = false
    var isListening: Bool = false
    var isSpeaking: Bool = false
    var isPushToTalkActive: Bool = false
    var statusText: String = "Off"
    /// 0..1-ish (not calibrated). Intended for UI feedback only.
    var micLevel: Double = 0

    private enum CaptureMode {
        case idle
        case continuous
        case pushToTalk
    }

    private var captureMode: CaptureMode = .idle
    private var resumeContinuousAfterPTT: Bool = false
    private var activePTTCaptureId: String?
    private var pttAutoStopEnabled: Bool = false
    private var pttCompletion: CheckedContinuation<OpenClawTalkPTTStopPayload, Never>?
    private var pttTimeoutTask: Task<Void, Never>?

    private let allowSimulatorCapture: Bool
    /// When true, the audio session is kept alive during background to prevent iOS suspension.
    var backgroundKeepAlive: Bool = false
    private var backgroundAudioPlayer: AVAudioPlayer?

    private let audioEngine = AVAudioEngine()
    private var inputTapInstalled = false
    private var audioTapDiagnostics: AudioTapDiagnostics?
    private var speechRecognizer: SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var silenceTask: Task<Void, Never>?

    private var lastHeard: Date?
    private var lastTranscript: String = ""
    private var loggedPartialThisCycle: Bool = false
    private var lastSpokenText: String?
    private var allSpokenText: String = ""
    /// Rolling average of mic level during TTS playback (speaker bleed baseline).
    private var ttsAudioBaseline: Double = 0
    /// When TTS started, used for grace period before allowing interrupts.
    private var ttsStartedAt: Date?
    private var lastInterruptedAtSeconds: Double?

    private var defaultVoiceId: String?
    private var currentVoiceId: String?
    private var defaultModelId: String?
    private var currentModelId: String?
    private var voiceOverrideActive = false
    private var modelOverrideActive = false
    private var defaultOutputFormat: String?
    private var apiKey: String?
    private var voiceAliases: [String: String] = [:]
    private var interruptOnSpeech: Bool = true
    private var mainSessionKey: String = "main"
    private var fallbackVoiceId: String?
    private var lastPlaybackWasPCM: Bool = false
    var pcmPlayer: PCMStreamingAudioPlaying = PCMStreamingAudioPlayer.shared
    var mp3Player: StreamingAudioPlaying = StreamingAudioPlayer.shared

    private var gateway: GatewayNodeSession?
    private var gatewayConnected = false
    private let silenceWindow: TimeInterval = 0.6
    private var lastAudioActivity: Date?
    private var noiseFloorSamples: [Double] = []
    private var noiseFloor: Double?
    private var noiseFloorReady: Bool = false

    private var chatSubscribedSessionKeys = Set<String>()
    private var incrementalSpeechQueue: [String] = []
    private var incrementalSpeechTask: Task<Void, Never>?
    private var incrementalSpeechActive = false
    private var incrementalSpeechUsed = false
    private var incrementalSpeechLanguage: String?
    private var incrementalSpeechBuffer = IncrementalSpeechBuffer()
    private var incrementalSpeechContext: IncrementalSpeechContext?
    private var incrementalSpeechDirective: TalkDirective?

    private let logger = Logger(subsystem: "bot.molt", category: "TalkMode")
    private var routeChangeObserver: NSObjectProtocol?
    private var interruptionObserver: NSObjectProtocol?
    private var lastConfigReload: Date?
    private var thinkingSoundURL: URL?
    private var startupSoundURL: URL?
    private var pushSpeechQueue: [String] = []
    private var pushSpeechTask: Task<Void, Never>?

    init(allowSimulatorCapture: Bool = false) {
        self.allowSimulatorCapture = allowSimulatorCapture
        super.init()
        self.observeAudioRouteChanges()
        self.prepareThinkingSound()
        self.prepareStartupSound()
    }

    func attachGateway(_ gateway: GatewayNodeSession) {
        self.gateway = gateway
    }

    func updateGatewayConnected(_ connected: Bool) {
        self.gatewayConnected = connected
        if connected {
            // If talk mode is enabled before the gateway connects (common on cold start),
            // kick recognition once we're online so the UI doesn’t stay “Offline”.
            if self.isEnabled, !self.isListening, self.captureMode != .pushToTalk {
                Task { await self.start() }
            }
        } else {
            if self.isEnabled, !self.isSpeaking {
                self.statusText = "Offline"
            }
        }
    }

    func updateMainSessionKey(_ sessionKey: String?) {
        let trimmed = (sessionKey ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if trimmed == self.mainSessionKey { return }
        self.mainSessionKey = trimmed
        if self.gatewayConnected, self.isEnabled {
            Task { await self.subscribeChatIfNeeded(sessionKey: trimmed) }
        }
    }

    func setEnabled(_ enabled: Bool) {
        self.isEnabled = enabled
        if enabled {
            self.logger.info("enabled")
            Task { await self.start() }
        } else {
            self.logger.info("disabled")
            self.stop()
        }
    }

    func start() async {
        guard self.isEnabled else { return }
        guard self.captureMode != .pushToTalk else { return }
        if self.isListening { return }
        guard self.gatewayConnected else {
            self.statusText = "Offline"
            return
        }

        self.logger.info("start")
        let needsPrompt = AVAudioSession.sharedInstance().recordPermission == .undetermined
            || SFSpeechRecognizer.authorizationStatus() == .notDetermined
        if needsPrompt {
            self.statusText = "Requesting permissions…"
        }
        let micOk = await Self.requestMicrophonePermission()
        guard micOk else {
            self.logger.warning("start blocked: microphone permission denied")
            self.statusText = Self.permissionMessage(
                kind: "Microphone",
                status: AVAudioSession.sharedInstance().recordPermission)
            return
        }
        let speechOk = await Self.requestSpeechPermission()
        guard speechOk else {
            self.logger.warning("start blocked: speech permission denied")
            self.statusText = Self.permissionMessage(
                kind: "Speech recognition",
                status: SFSpeechRecognizer.authorizationStatus())
            return
        }

        await self.reloadConfig(force: self.lastConfigReload == nil)
        do {
            try Self.configureAudioSession()
            // Set this before starting recognition so any early speech errors are classified correctly.
            self.captureMode = .continuous
            try self.startRecognition()
            self.isListening = true
            self.statusText = "Listening"
            self.startSilenceMonitor()
            await self.subscribeChatIfNeeded(sessionKey: self.mainSessionKey)
            self.playStartupSound()
            self.logger.info("listening")
        } catch {
            self.isListening = false
            self.statusText = "Start failed: \(error.localizedDescription)"
            self.logger.error("start failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    func stop() {
        self.isEnabled = false
        self.isListening = false
        self.isPushToTalkActive = false
        self.captureMode = .idle
        self.statusText = "Off"
        self.lastTranscript = ""
        self.lastHeard = nil
        self.silenceTask?.cancel()
        self.silenceTask = nil
        self.stopRecognition()
        self.stopSpeaking()
        self.lastInterruptedAtSeconds = nil
        let pendingPTT = self.pttCompletion != nil
        let pendingCaptureId = self.activePTTCaptureId ?? UUID().uuidString
        self.pttTimeoutTask?.cancel()
        self.pttTimeoutTask = nil
        self.pttAutoStopEnabled = false
        if pendingPTT {
            let payload = OpenClawTalkPTTStopPayload(
                captureId: pendingCaptureId,
                transcript: nil,
                status: "cancelled")
            self.finishPTTOnce(payload)
        }
        self.resumeContinuousAfterPTT = false
        self.activePTTCaptureId = nil
        TalkSystemSpeechSynthesizer.shared.stop()
        self.backgroundKeepAlive = false
        self.stopBackgroundAudioKeepAlive()
        do {
            try AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        } catch {
            self.logger.warning("audio session deactivate failed: \(error.localizedDescription, privacy: .public)")
        }
        Task { await self.unsubscribeAllChats() }
    }

    /// Suspends microphone usage without disabling Talk Mode.
    /// Used when the app backgrounds (or when we need to temporarily release the mic).
    /// When `keepActiveInBackground` is true, the audio session and recognition remain
    /// alive so Talk Mode continues working while the app is in the background.
    func suspendForBackground(keepActive: Bool = false) -> Bool {
        guard self.isEnabled else { return false }
        let wasActive = self.isListening || self.isSpeaking || self.isPushToTalkActive

        if keepActive {
            // Keep Talk Mode running in the background. Start a silent audio loop so iOS
            // doesn't suspend us between recognition/TTS cycles (UIBackgroundModes=audio+voip).
            // KEY INSIGHT: We must keep the AVAudioEngine running continuously to prevent
            // iOS from suspending the app. Never stop the engine while in background mode.
            self.backgroundKeepAlive = true
            self.startBackgroundAudioKeepAlive()
            self.logger.info("backgrounding with talk mode active (keepActive=true)")
            GatewayDiagnostics.log("talk: background keepActive=true listening=\(self.isListening) engineRunning=\(self.audioEngine.isRunning)")
            return wasActive
        }

        self.isListening = false
        self.isPushToTalkActive = false
        self.captureMode = .idle
        self.statusText = "Paused"
        self.lastTranscript = ""
        self.lastHeard = nil
        self.silenceTask?.cancel()
        self.silenceTask = nil

        self.stopRecognition()
        self.stopSpeaking()
        self.lastInterruptedAtSeconds = nil
        TalkSystemSpeechSynthesizer.shared.stop()

        do {
            try AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        } catch {
            self.logger.warning("audio session deactivate failed: \(error.localizedDescription, privacy: .public)")
        }

        Task { await self.unsubscribeAllChats() }
        return wasActive
    }

    func resumeAfterBackground(wasSuspended: Bool, wasKeptActive: Bool = false) async {
        guard wasSuspended else { return }
        guard self.isEnabled else { return }
        // If talk mode was kept active in the background, stop the keepalive and continue.
        if wasKeptActive {
            self.backgroundKeepAlive = false
            self.stopBackgroundAudioKeepAlive()
            self.logger.info("foregrounding with talk mode still active (wasKeptActive=true)")
            GatewayDiagnostics.log("talk: foregrounding wasKeptActive=true engineRunning=\(self.audioEngine.isRunning)")
            
            // If the engine is still running, we're in good shape
            if self.audioEngine.isRunning {
                // Make sure we're in the right state
                if !self.isListening && self.captureMode != .pushToTalk {
                    await self.resumeRecognitionOnly()
                }
            } else {
                // Engine died somehow, restart everything
                self.logger.warning("foregrounding: engine not running despite keepActive, restarting")
                await self.start()
            }
            return
        }
        await self.start()
    }

    func userTappedOrb() {
        self.stopSpeaking()
    }

    func beginPushToTalk() async throws -> OpenClawTalkPTTStartPayload {
        guard self.gatewayConnected else {
            self.statusText = "Offline"
            throw NSError(domain: "TalkMode", code: 7, userInfo: [
                NSLocalizedDescriptionKey: "Gateway not connected",
            ])
        }
        if self.isPushToTalkActive, let captureId = self.activePTTCaptureId {
            return OpenClawTalkPTTStartPayload(captureId: captureId)
        }

        self.stopSpeaking(storeInterruption: false)
        self.pttTimeoutTask?.cancel()
        self.pttTimeoutTask = nil
        self.pttAutoStopEnabled = false

        self.resumeContinuousAfterPTT = self.isEnabled && self.captureMode == .continuous
        self.silenceTask?.cancel()
        self.silenceTask = nil
        self.stopRecognition()
        self.isListening = false

        let captureId = UUID().uuidString
        self.activePTTCaptureId = captureId
        self.lastTranscript = ""
        self.lastHeard = nil

        self.statusText = "Requesting permissions…"
        if !self.allowSimulatorCapture {
            let micOk = await Self.requestMicrophonePermission()
            guard micOk else {
                self.statusText = Self.permissionMessage(
                    kind: "Microphone",
                    status: AVAudioSession.sharedInstance().recordPermission)
                throw NSError(domain: "TalkMode", code: 4, userInfo: [
                    NSLocalizedDescriptionKey: "Microphone permission denied",
                ])
            }
            let speechOk = await Self.requestSpeechPermission()
            guard speechOk else {
                self.statusText = Self.permissionMessage(
                    kind: "Speech recognition",
                    status: SFSpeechRecognizer.authorizationStatus())
                throw NSError(domain: "TalkMode", code: 5, userInfo: [
                    NSLocalizedDescriptionKey: "Speech recognition permission denied",
                ])
            }
        }

        do {
            try Self.configureAudioSession()
            self.captureMode = .pushToTalk
            try self.startRecognition()
            self.isListening = true
            self.isPushToTalkActive = true
            self.statusText = "Listening (PTT)"
        } catch {
            self.isListening = false
            self.isPushToTalkActive = false
            self.captureMode = .idle
            self.statusText = "Start failed: \(error.localizedDescription)"
            throw error
        }

        return OpenClawTalkPTTStartPayload(captureId: captureId)
    }

    func endPushToTalk() async -> OpenClawTalkPTTStopPayload {
        let captureId = self.activePTTCaptureId ?? UUID().uuidString
        guard self.isPushToTalkActive else {
            let payload = OpenClawTalkPTTStopPayload(
                captureId: captureId,
                transcript: nil,
                status: "idle")
            self.finishPTTOnce(payload)
            return payload
        }

        self.isPushToTalkActive = false
        self.isListening = false
        self.captureMode = .idle
        self.stopRecognition()
        self.pttTimeoutTask?.cancel()
        self.pttTimeoutTask = nil
        self.pttAutoStopEnabled = false

        let transcript = self.lastTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        self.lastTranscript = ""
        self.lastHeard = nil

        guard !transcript.isEmpty else {
            self.statusText = "Ready"
            if self.resumeContinuousAfterPTT {
                await self.start()
            }
            self.resumeContinuousAfterPTT = false
            self.activePTTCaptureId = nil
            let payload = OpenClawTalkPTTStopPayload(
                captureId: captureId,
                transcript: nil,
                status: "empty")
            self.finishPTTOnce(payload)
            return payload
        }

        guard self.gatewayConnected else {
            self.statusText = "Gateway not connected"
            if self.resumeContinuousAfterPTT {
                await self.start()
            }
            self.resumeContinuousAfterPTT = false
            self.activePTTCaptureId = nil
            let payload = OpenClawTalkPTTStopPayload(
                captureId: captureId,
                transcript: transcript,
                status: "offline")
            self.finishPTTOnce(payload)
            return payload
        }

        self.statusText = "Thinking…"
        Task { @MainActor in
            await self.processTranscript(transcript, restartAfter: self.resumeContinuousAfterPTT)
        }
        self.resumeContinuousAfterPTT = false
        self.activePTTCaptureId = nil
        let payload = OpenClawTalkPTTStopPayload(
            captureId: captureId,
            transcript: transcript,
            status: "queued")
        self.finishPTTOnce(payload)
        return payload
    }

    func runPushToTalkOnce(maxDurationSeconds: TimeInterval = 12) async throws -> OpenClawTalkPTTStopPayload {
        if self.pttCompletion != nil {
            _ = await self.cancelPushToTalk()
        }

        if self.isPushToTalkActive {
            let captureId = self.activePTTCaptureId ?? UUID().uuidString
            return OpenClawTalkPTTStopPayload(
                captureId: captureId,
                transcript: nil,
                status: "busy")
        }

        _ = try await self.beginPushToTalk()

        return await withCheckedContinuation { cont in
            self.pttCompletion = cont
            self.pttAutoStopEnabled = true
            self.startSilenceMonitor()
            self.schedulePTTTimeout(seconds: maxDurationSeconds)
        }
    }

    func cancelPushToTalk() async -> OpenClawTalkPTTStopPayload {
        let captureId = self.activePTTCaptureId ?? UUID().uuidString
        guard self.isPushToTalkActive else {
            let payload = OpenClawTalkPTTStopPayload(
                captureId: captureId,
                transcript: nil,
                status: "idle")
            self.finishPTTOnce(payload)
            self.pttAutoStopEnabled = false
            self.pttTimeoutTask?.cancel()
            self.pttTimeoutTask = nil
            self.resumeContinuousAfterPTT = false
            self.activePTTCaptureId = nil
            return payload
        }

        let shouldResume = self.resumeContinuousAfterPTT
        self.isPushToTalkActive = false
        self.isListening = false
        self.captureMode = .idle
        self.stopRecognition()
        self.lastTranscript = ""
        self.lastHeard = nil
        self.pttAutoStopEnabled = false
        self.pttTimeoutTask?.cancel()
        self.pttTimeoutTask = nil
        self.resumeContinuousAfterPTT = false
        self.activePTTCaptureId = nil
        self.statusText = "Ready"

        let payload = OpenClawTalkPTTStopPayload(
            captureId: captureId,
            transcript: nil,
            status: "cancelled")
        self.finishPTTOnce(payload)

        if shouldResume {
            await self.start()
        }
        return payload
    }

    private func startRecognition() throws {
        #if targetEnvironment(simulator)
            if !self.allowSimulatorCapture {
                throw NSError(domain: "TalkMode", code: 2, userInfo: [
                    NSLocalizedDescriptionKey: "Talk mode is not supported on the iOS simulator",
                ])
            } else {
                self.recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
                self.recognitionRequest?.shouldReportPartialResults = true
                return
            }
        #endif

        self.stopRecognition()
        self.speechRecognizer = SFSpeechRecognizer()
        guard let recognizer = self.speechRecognizer else {
            throw NSError(domain: "TalkMode", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Speech recognizer unavailable",
            ])
        }

        self.recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        self.recognitionRequest?.shouldReportPartialResults = true
        self.recognitionRequest?.taskHint = .dictation
        guard let request = self.recognitionRequest else { return }

        GatewayDiagnostics.log("talk audio: session \(Self.describeAudioSession())")

        let input = self.audioEngine.inputNode
        let format = input.inputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw NSError(domain: "TalkMode", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "Invalid audio input format",
            ])
        }
        input.removeTap(onBus: 0)
        let tapDiagnostics = AudioTapDiagnostics(label: "talk") { [weak self] level in
            guard let self else { return }
            Task { @MainActor in
                // Smooth + clamp for UI, and keep it cheap.
                let raw = max(0, min(Double(level) * 10.0, 1.0))
                let next = (self.micLevel * 0.80) + (raw * 0.20)
                self.micLevel = next

                // Dynamic thresholding so background noise doesn’t prevent endpointing.
                if self.isListening, !self.isSpeaking, !self.noiseFloorReady {
                    self.noiseFloorSamples.append(raw)
                    if self.noiseFloorSamples.count >= 22 {
                        let sorted = self.noiseFloorSamples.sorted()
                        let take = max(6, sorted.count / 2)
                        let slice = sorted.prefix(take)
                        let avg = slice.reduce(0.0, +) / Double(slice.count)
                        self.noiseFloor = avg
                        self.noiseFloorReady = true
                        self.noiseFloorSamples.removeAll(keepingCapacity: true)
                        let threshold = min(0.35, max(0.12, avg + 0.10))
                        GatewayDiagnostics.log(
                            "talk audio: noiseFloor=\(String(format: "%.3f", avg)) threshold=\(String(format: "%.3f", threshold))")
                    }
                }

                // Track speaker bleed baseline during TTS for interrupt gating.
                if self.isSpeechOutputActive {
                    self.ttsAudioBaseline = (self.ttsAudioBaseline * 0.92) + (raw * 0.08)
                }

                let threshold: Double = if let floor = self.noiseFloor, self.noiseFloorReady {
                    min(0.35, max(0.12, floor + 0.10))
                } else {
                    0.18
                }
                if raw >= threshold {
                    self.lastAudioActivity = Date()
                }
            }
        }
        self.audioTapDiagnostics = tapDiagnostics
        let tapBlock = Self.makeAudioTapAppendCallback(request: request, diagnostics: tapDiagnostics)
        input.installTap(onBus: 0, bufferSize: 2048, format: format, block: tapBlock)
        self.inputTapInstalled = true

        self.audioEngine.prepare()
        try self.audioEngine.start()
        self.loggedPartialThisCycle = false

        GatewayDiagnostics.log(
            "talk speech: recognition started mode=\(String(describing: self.captureMode)) engineRunning=\(self.audioEngine.isRunning)")
        self.recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            if let error {
                let msg = error.localizedDescription
                GatewayDiagnostics.log("talk speech: error=\(msg)")
                // Only update status for genuine errors, not intentional cancellations
                // (e.g. processTranscript sets captureMode=.idle before stopping recognition).
                if !self.isSpeaking, self.captureMode != .idle {
                    if msg.localizedCaseInsensitiveContains("no speech detected") ||
                        msg.localizedCaseInsensitiveContains("was canceled")
                    {
                        self.statusText = self.isEnabled ? "Listening" : "Speech error: \(msg)"
                    } else {
                        self.statusText = "Speech error: \(msg)"
                    }
                }
                self.logger.debug("speech recognition error: \(msg, privacy: .public)")
                // Speech recognition can terminate on transient errors (e.g. no speech detected).
                // If talk mode is enabled and we're in continuous capture, try to restart.
                if self.captureMode == .continuous, self.isEnabled, !self.isSpeaking {
                    // Treat the task as terminal on error so we don't get stuck with a dead recognizer.
                    if self.backgroundKeepAlive {
                        self.pauseRecognitionOnly()
                    } else {
                        self.stopRecognition()
                    }
                    Task { @MainActor [weak self] in
                        await self?.restartRecognitionAfterError()
                    }
                }
            }
            guard let result else { return }
            let transcript = result.bestTranscription.formattedString
            if !result.isFinal, !self.loggedPartialThisCycle {
                let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty {
                    self.loggedPartialThisCycle = true
                    GatewayDiagnostics.log("talk speech: partial chars=\(trimmed.count)")
                }
            }
            Task { @MainActor in
                await self.handleTranscript(transcript: transcript, isFinal: result.isFinal)
            }
        }
    }

    private func restartRecognitionAfterError() async {
        guard self.isEnabled, self.captureMode == .continuous else { return }
        // Avoid thrashing the audio engine if it's already running.
        if self.recognitionTask != nil, self.audioEngine.isRunning { return }
        try? await Task.sleep(nanoseconds: 250_000_000)
        guard self.isEnabled, self.captureMode == .continuous else { return }

        if self.backgroundKeepAlive {
            // In background mode, resume recognition on the already-running engine
            await self.resumeRecognitionOnly()
            if self.statusText.localizedCaseInsensitiveContains("speech error") {
                self.statusText = "Listening"
            }
            GatewayDiagnostics.log("talk speech: recognition restarted (background)")
            return
        }

        do {
            try Self.configureAudioSession()
            try self.startRecognition()
            self.isListening = true
            if self.statusText.localizedCaseInsensitiveContains("speech error") {
                self.statusText = "Listening"
            }
            GatewayDiagnostics.log("talk speech: recognition restarted")
        } catch {
            let msg = error.localizedDescription
            GatewayDiagnostics.log("talk speech: restart failed error=\(msg)")
        }
    }

    private func stopRecognition() {
        self.recognitionTask?.cancel()
        self.recognitionTask = nil
        self.recognitionRequest?.endAudio()
        self.recognitionRequest = nil
        self.micLevel = 0
        self.lastAudioActivity = nil
        self.noiseFloorSamples.removeAll(keepingCapacity: true)
        self.noiseFloor = nil
        self.noiseFloorReady = false
        self.audioTapDiagnostics = nil
        if self.inputTapInstalled {
            self.audioEngine.inputNode.removeTap(onBus: 0)
            self.inputTapInstalled = false
        }
        self.audioEngine.stop()
        self.speechRecognizer = nil
    }
    
    /// Pauses speech recognition but keeps AVAudioEngine AND input tap running for background mode.
    /// The tap continues processing audio (keeping iOS from suspending us) but buffers are
    /// discarded since the recognition request has ended.
    private func pauseRecognitionOnly() {
        self.recognitionTask?.cancel()
        self.recognitionTask = nil
        self.recognitionRequest?.endAudio()
        self.recognitionRequest = nil
        self.micLevel = 0
        self.lastAudioActivity = nil
        self.noiseFloorSamples.removeAll(keepingCapacity: true)
        self.noiseFloor = nil
        self.noiseFloorReady = false
        // CRITICAL: Do NOT remove the input tap or stop the audioEngine in background mode.
        // Keeping the tap installed means audio continues flowing through the engine,
        // which iOS recognizes as active audio work and won't suspend us.
        // The tap's captured request reference has had endAudio() called, so append() is a no-op.
        self.speechRecognizer = nil
        self.logger.info("paused recognition only, keeping engine + tap running for background mode (tapInstalled=\(self.inputTapInstalled))")
    }
    
    /// Resumes speech recognition on an already-running AVAudioEngine (for background mode)
    private func resumeRecognitionOnly() async {
        guard self.isEnabled else { return }
        guard self.backgroundKeepAlive else { 
            // If we're not in background mode, fall back to full start
            await self.start()
            return
        }
        // Don't block on gateway - speech recognition is local. Transcripts
        // will be sent when the gateway reconnects.
        if !self.gatewayConnected {
            self.logger.info("resumeRecognitionOnly: gateway offline, recognition will still run locally")
        }

        do {
            // The engine should already be running, just restart recognition
            guard self.audioEngine.isRunning else {
                self.logger.warning("resumeRecognitionOnly: engine not running, falling back to full start")
                await self.start()
                return
            }
            
            self.speechRecognizer = SFSpeechRecognizer()
            guard let recognizer = self.speechRecognizer else {
                throw NSError(domain: "TalkMode", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: "Speech recognizer unavailable",
                ])
            }
            
            self.recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
            self.recognitionRequest?.shouldReportPartialResults = true
            self.recognitionRequest?.taskHint = .dictation
            guard let request = self.recognitionRequest else { return }
            
            let input = self.audioEngine.inputNode
            let format = input.inputFormat(forBus: 0)

            // Remove the old tap (kept alive during pause) before installing the new one
            if self.inputTapInstalled {
                input.removeTap(onBus: 0)
                self.inputTapInstalled = false
            }

            // Set up audio tap again
            let tapDiagnostics = AudioTapDiagnostics(label: "talk") { [weak self] level in
                guard let self else { return }
                Task { @MainActor in
                    let raw = max(0, min(Double(level) * 10.0, 1.0))
                    let next = (self.micLevel * 0.80) + (raw * 0.20)
                    self.micLevel = next
                    
                    if self.isListening, !self.isSpeaking, !self.noiseFloorReady {
                        self.noiseFloorSamples.append(raw)
                        if self.noiseFloorSamples.count >= 22 {
                            let sorted = self.noiseFloorSamples.sorted()
                            let take = max(6, sorted.count / 2)
                            let slice = sorted.prefix(take)
                            let avg = slice.reduce(0.0, +) / Double(slice.count)
                            self.noiseFloor = avg
                            self.noiseFloorReady = true
                            self.noiseFloorSamples.removeAll(keepingCapacity: true)
                            let threshold = min(0.35, max(0.12, avg + 0.10))
                            GatewayDiagnostics.log(
                                "talk audio: noiseFloor=\(String(format: "%.3f", avg)) threshold=\(String(format: "%.3f", threshold))")
                        }
                    }
                    
                    // Track speaker bleed baseline during TTS for interrupt gating.
                    if self.isSpeechOutputActive {
                        self.ttsAudioBaseline = (self.ttsAudioBaseline * 0.92) + (raw * 0.08)
                    }

                    let threshold: Double = if let floor = self.noiseFloor, self.noiseFloorReady {
                        min(0.35, max(0.12, floor + 0.10))
                    } else {
                        0.18
                    }
                    if raw >= threshold {
                        self.lastAudioActivity = Date()
                    }
                }
            }
            
            self.audioTapDiagnostics = tapDiagnostics
            let tapBlock = Self.makeAudioTapAppendCallback(request: request, diagnostics: tapDiagnostics)
            input.installTap(onBus: 0, bufferSize: 2048, format: format, block: tapBlock)
            self.inputTapInstalled = true
            self.loggedPartialThisCycle = false
            
            self.captureMode = .continuous
            self.isListening = true
            self.statusText = "Listening"
            self.startSilenceMonitor()
            
            GatewayDiagnostics.log(
                "talk speech: recognition resumed on running engine mode=\(String(describing: self.captureMode)) engineRunning=\(self.audioEngine.isRunning)")
            
            self.recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
                guard let self else { return }
                if let error {
                    let msg = error.localizedDescription
                    GatewayDiagnostics.log("talk speech: error=\(msg)")
                    if !self.isSpeaking {
                        if msg.localizedCaseInsensitiveContains("no speech detected") {
                            self.statusText = self.isEnabled ? "Listening" : "Speech error: \(msg)"
                        } else {
                            self.statusText = "Speech error: \(msg)"
                        }
                    }
                    self.logger.debug("speech recognition error: \(msg, privacy: .public)")
                    if self.captureMode == .continuous, self.isEnabled, !self.isSpeaking {
                        Task { @MainActor [weak self] in
                            await self?.restartRecognitionAfterError()
                        }
                    }
                }
                guard let result else { return }
                let transcript = result.bestTranscription.formattedString
                if !result.isFinal, !self.loggedPartialThisCycle {
                    let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !trimmed.isEmpty {
                        self.loggedPartialThisCycle = true
                        GatewayDiagnostics.log("talk speech: partial chars=\(trimmed.count)")
                    }
                }
                Task { @MainActor in
                    await self.handleTranscript(transcript: transcript, isFinal: result.isFinal)
                }
            }
            
            await self.subscribeChatIfNeeded(sessionKey: self.mainSessionKey)
            self.logger.info("resumed recognition on running engine")
            
        } catch {
            self.isListening = false
            self.statusText = "Resume failed: \(error.localizedDescription)"
            self.logger.error("resume recognition failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private nonisolated static func makeAudioTapAppendCallback(
        request: SpeechRequest,
        diagnostics: AudioTapDiagnostics) -> AVAudioNodeTapBlock
    {
        { buffer, _ in
            request.append(buffer)
            diagnostics.onBuffer(buffer)
        }
    }

    /// Returns true if headphones or a Bluetooth audio device is connected (no speaker-to-mic bleed).
    private var hasIsolatedAudioOutput: Bool {
        let outputs = AVAudioSession.sharedInstance().currentRoute.outputs
        return outputs.contains { port in
            port.portType == .headphones ||
            port.portType == .bluetoothA2DP ||
            port.portType == .bluetoothHFP ||
            port.portType == .bluetoothLE ||
            port.portType == .carAudio
        }
    }

    private func handleTranscript(transcript: String, isFinal: Bool) async {
        let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        let ttsActive = self.isSpeechOutputActive
        if ttsActive, self.interruptOnSpeech {
            // On speaker (no headphones), skip interrupt-on-speech entirely.
            // The mic picks up the TTS output and falsely triggers interrupts.
            // User can still tap the orb to stop playback.
            guard self.hasIsolatedAudioOutput else { return }
            if self.shouldInterrupt(with: trimmed) {
                self.stopSpeaking()
            }
            return
        }

        guard self.isListening else { return }
        if !trimmed.isEmpty {
            self.lastTranscript = trimmed
            self.lastHeard = Date()
        }
        if isFinal {
            self.lastTranscript = trimmed
            guard !trimmed.isEmpty else { return }
            GatewayDiagnostics.log("talk speech: final transcript chars=\(trimmed.count)")
            self.loggedPartialThisCycle = false
            if self.captureMode == .pushToTalk, self.pttAutoStopEnabled, self.isPushToTalkActive {
                _ = await self.endPushToTalk()
                return
            }
            if self.captureMode == .continuous, !self.isSpeechOutputActive {
                await self.processTranscript(trimmed, restartAfter: true)
            }
        }
    }

    private func startSilenceMonitor() {
        self.silenceTask?.cancel()
        self.silenceTask = Task { [weak self] in
            guard let self else { return }
            while self.isEnabled || (self.isPushToTalkActive && self.pttAutoStopEnabled) {
                try? await Task.sleep(nanoseconds: 100_000_000)
                await self.checkSilence()
            }
        }
    }

    private func checkSilence() async {
        if self.captureMode == .continuous {
            guard self.isListening, !self.isSpeechOutputActive else { return }
            let transcript = self.lastTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !transcript.isEmpty else { return }
            let lastActivity = [self.lastHeard, self.lastAudioActivity].compactMap { $0 }.max()
            guard let lastActivity else { return }
            if Date().timeIntervalSince(lastActivity) < self.silenceWindow { return }
            await self.processTranscript(transcript, restartAfter: true)
            return
        }

        guard self.captureMode == .pushToTalk, self.pttAutoStopEnabled else { return }
        guard self.isListening, !self.isSpeaking, self.isPushToTalkActive else { return }
        let transcript = self.lastTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !transcript.isEmpty else { return }
        let lastActivity = [self.lastHeard, self.lastAudioActivity].compactMap { $0 }.max()
        guard let lastActivity else { return }
        if Date().timeIntervalSince(lastActivity) < self.silenceWindow { return }
        _ = await self.endPushToTalk()
    }

    // Guardrail for PTT once so we don't stay open indefinitely.
    private func schedulePTTTimeout(seconds: TimeInterval) {
        guard seconds > 0 else { return }
        let nanos = UInt64(seconds * 1_000_000_000)
        self.pttTimeoutTask?.cancel()
        self.pttTimeoutTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: nanos)
            await self?.handlePTTTimeout()
        }
    }

    private func handlePTTTimeout() async {
        guard self.pttAutoStopEnabled, self.isPushToTalkActive else { return }
        _ = await self.endPushToTalk()
    }

    private func finishPTTOnce(_ payload: OpenClawTalkPTTStopPayload) {
        guard let continuation = self.pttCompletion else { return }
        self.pttCompletion = nil
        continuation.resume(returning: payload)
    }

    /// Pre-generates the thinking chime WAV so it's ready for instant playback.
    private func prepareThinkingSound() {
        let sampleRate: Float = 44100
        let duration: Float = 0.15
        let frequency: Float = 880 // A5 note
        let numSamples = Int(sampleRate * duration)
        let numChannels: UInt32 = 1
        guard let format = AVAudioFormat(standardFormatWithSampleRate: Double(sampleRate), channels: numChannels),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(numSamples))
        else { return }
        buffer.frameLength = AVAudioFrameCount(numSamples)
        guard let data = buffer.floatChannelData?[0] else { return }
        for i in 0..<numSamples {
            let t = Float(i) / sampleRate
            let envelope = 1.0 - (t / duration) // linear fade out
            data[i] = sin(2.0 * .pi * frequency * t) * envelope * 0.15
        }
        let tempURL = FileManager.default.temporaryDirectory.appendingPathComponent("thinking_chime.wav")
        do {
            let file = try AVAudioFile(forWriting: tempURL, settings: format.settings)
            try file.write(from: buffer)
            self.thinkingSoundURL = tempURL
        } catch {
            self.logger.debug("thinking sound prep failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Plays a short, subtle chime to indicate the assistant is processing.
    private func playThinkingSound() {
        guard let url = self.thinkingSoundURL else {
            self.prepareThinkingSound()
            guard let url = self.thinkingSoundURL else { return }
            return self.playThinkingSound()
        }
        do {
            let player = try AVAudioPlayer(contentsOf: url)
            player.volume = 0.4
            player.prepareToPlay()
            player.play()
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 200_000_000)
                _ = player
            }
        } catch {
            self.logger.debug("thinking sound failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Pre-generates a two-tone ascending chime for voice mode startup.
    private func prepareStartupSound() {
        let sampleRate: Float = 44100
        let noteDuration: Float = 0.12
        let gap: Float = 0.06
        let totalDuration = noteDuration * 2 + gap
        let freq1: Float = 523.25 // C5
        let freq2: Float = 783.99 // G5
        let numSamples = Int(sampleRate * totalDuration)
        let numChannels: UInt32 = 1
        guard let format = AVAudioFormat(standardFormatWithSampleRate: Double(sampleRate), channels: numChannels),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(numSamples))
        else { return }
        buffer.frameLength = AVAudioFrameCount(numSamples)
        guard let data = buffer.floatChannelData?[0] else { return }
        let note1End = Int(sampleRate * noteDuration)
        let gapEnd = Int(sampleRate * (noteDuration + gap))
        for i in 0..<numSamples {
            let t = Float(i) / sampleRate
            if i < note1End {
                let env = 1.0 - (t / noteDuration)
                data[i] = sin(2.0 * .pi * freq1 * t) * env * 0.18
            } else if i < gapEnd {
                data[i] = 0
            } else {
                let t2 = Float(i - gapEnd) / sampleRate
                let env = 1.0 - (t2 / noteDuration)
                data[i] = sin(2.0 * .pi * freq2 * t2) * env * 0.18
            }
        }
        let tempURL = FileManager.default.temporaryDirectory.appendingPathComponent("startup_chime.wav")
        do {
            let file = try AVAudioFile(forWriting: tempURL, settings: format.settings)
            try file.write(from: buffer)
            self.startupSoundURL = tempURL
        } catch {
            self.logger.debug("startup sound prep failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Plays the startup chime when voice mode begins listening.
    private func playStartupSound() {
        guard let url = self.startupSoundURL else {
            self.prepareStartupSound()
            guard let _ = self.startupSoundURL else { return }
            return self.playStartupSound()
        }
        do {
            let player = try AVAudioPlayer(contentsOf: url)
            player.volume = 0.5
            player.prepareToPlay()
            player.play()
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 400_000_000)
                _ = player
            }
        } catch {
            self.logger.debug("startup sound failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Polls for follow-up assistant messages after the initial response.
    /// Handles multi-turn agentic responses where the bot runs commands
    /// between text messages (each producing a separate run).
    private func pollForFollowUpMessages(
        gateway: GatewayNodeSession, since: Double, lastKnownText: String) async
    {
        var lastText = lastKnownText
        var missCount = 0

        for i in 0..<8 {
            try? await Task.sleep(nanoseconds: 2_000_000_000) // 2 sec interval
            guard self.isEnabled, self.gatewayConnected else { break }

            guard let newest = try? await self.fetchLatestAssistantText(
                gateway: gateway, since: since) else {
                missCount += 1
                if missCount >= 2 { break }
                continue
            }
            let trimmed = newest.trimmingCharacters(in: .whitespacesAndNewlines)
            guard trimmed != lastText else {
                missCount += 1
                if missCount >= 2 { break }
                continue
            }

            // New follow-up message detected
            missCount = 0
            self.logger.info("multi-turn follow-up \(i+1, privacy: .public) chars=\(trimmed.count, privacy: .public)")
            GatewayDiagnostics.log("talk: multi-turn follow-up \(i+1) chars=\(trimmed.count)")

            self.isSpeaking = true
            self.statusText = "Speaking…"
            self.lastSpokenText = trimmed
            self.allSpokenText = trimmed

            do {
                try await TalkSystemSpeechSynthesizer.shared.speak(text: trimmed)
            } catch {
                self.logger.error(
                    "multi-turn speak failed: \(error.localizedDescription, privacy: .public)")
            }

            self.isSpeaking = false
            self.allSpokenText = ""
            self.ttsAudioBaseline = 0
            lastText = trimmed
        }
    }

    private func processTranscript(_ transcript: String, restartAfter: Bool) async {
        self.isListening = false
        self.captureMode = .idle
        self.statusText = "Thinking…"
        self.lastTranscript = ""
        self.lastHeard = nil
        self.playThinkingSound()
        
        // CRITICAL FIX: Only stop recognition if we're not in background keepalive mode
        // Stopping the AVAudioEngine in background causes iOS to suspend the app
        if !self.backgroundKeepAlive {
            self.stopRecognition()
        } else {
            // In background mode, keep the engine running but stop speech recognition
            self.pauseRecognitionOnly()
        }

        GatewayDiagnostics.log("talk: process transcript chars=\(transcript.count) restartAfter=\(restartAfter)")
        await self.reloadConfig()
        let prompt = self.buildPrompt(transcript: transcript)
        guard self.gatewayConnected, let gateway else {
            self.statusText = "Gateway not connected"
            self.logger.warning("finalize: gateway not connected")
            GatewayDiagnostics.log("talk: abort gateway not connected")
            if restartAfter {
                if self.backgroundKeepAlive {
                    await self.resumeRecognitionOnly()
                } else {
                    await self.start()
                }
            }
            return
        }

        do {
            let startedAt = Date().timeIntervalSince1970
            let sessionKey = self.mainSessionKey
            await self.subscribeChatIfNeeded(sessionKey: sessionKey)
            self.logger.info(
                "chat.send start sessionKey=\(sessionKey, privacy: .public) chars=\(prompt.count, privacy: .public)")
            GatewayDiagnostics.log("talk: chat.send start sessionKey=\(sessionKey) chars=\(prompt.count)")
            let runId = try await self.sendChat(prompt, gateway: gateway)
            self.logger.info("chat.send ok runId=\(runId, privacy: .public)")
            GatewayDiagnostics.log("talk: chat.send ok runId=\(runId)")
            let shouldIncremental = self.shouldUseIncrementalTTS()
            var streamingTask: Task<Void, Never>?
            if shouldIncremental {
                self.resetIncrementalSpeech()
                streamingTask = Task { @MainActor [weak self] in
                    guard let self else { return }
                    await self.streamAssistant(runId: runId, gateway: gateway)
                }
            }
            let completion = await self.waitForChatCompletion(runId: runId, gateway: gateway, timeoutSeconds: 120)
            if completion == .timeout {
                self.logger.warning(
                    "chat completion timeout runId=\(runId, privacy: .public); attempting history fallback")
                GatewayDiagnostics.log("talk: chat completion timeout runId=\(runId)")
            } else if completion == .aborted {
                self.statusText = "Aborted"
                self.logger.warning("chat completion aborted runId=\(runId, privacy: .public)")
                GatewayDiagnostics.log("talk: chat completion aborted runId=\(runId)")
                streamingTask?.cancel()
                await self.finishIncrementalSpeech()
                if self.backgroundKeepAlive {
                    await self.resumeRecognitionOnly()
                } else {
                    await self.start()
                }
                return
            } else if completion == .error {
                self.statusText = "Chat error"
                self.logger.warning("chat completion error runId=\(runId, privacy: .public)")
                GatewayDiagnostics.log("talk: chat completion error runId=\(runId)")
                streamingTask?.cancel()
                await self.finishIncrementalSpeech()
                if self.backgroundKeepAlive {
                    await self.resumeRecognitionOnly()
                } else {
                    await self.start()
                }
                return
            }

            var assistantText = try await self.waitForAssistantText(
                gateway: gateway,
                since: startedAt,
                timeoutSeconds: completion == .final ? 12 : 25)
            if assistantText == nil, shouldIncremental {
                let fallback = self.incrementalSpeechBuffer.latestText
                if !fallback.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    assistantText = fallback
                }
            }
            guard let assistantText else {
                self.statusText = "No reply"
                self.logger.warning("assistant text timeout runId=\(runId, privacy: .public)")
                GatewayDiagnostics.log("talk: assistant text timeout runId=\(runId)")
                streamingTask?.cancel()
                await self.finishIncrementalSpeech()
                if self.backgroundKeepAlive {
                    await self.resumeRecognitionOnly()
                } else {
                    await self.start()
                }
                return
            }
            self.logger.info("assistant text ok chars=\(assistantText.count, privacy: .public)")
            GatewayDiagnostics.log("talk: assistant text ok chars=\(assistantText.count)")
            streamingTask?.cancel()
            if shouldIncremental {
                await self.handleIncrementalAssistantFinal(text: assistantText)
            } else {
                await self.playAssistant(text: assistantText)
            }

            // Multi-turn support: poll for follow-up assistant messages.
            // When the bot runs commands between responses, subsequent messages
            // may arrive after the initial run completes.
            await self.pollForFollowUpMessages(
                gateway: gateway, since: startedAt, lastKnownText: assistantText)
        } catch {
            self.statusText = "Talk failed: \(error.localizedDescription)"
            self.logger.error("finalize failed: \(error.localizedDescription, privacy: .public)")
            GatewayDiagnostics.log("talk: failed error=\(error.localizedDescription)")
        }

        if restartAfter {
            if self.backgroundKeepAlive {
                // In background mode, resume recognition without restarting the engine
                await self.resumeRecognitionOnly()
            } else {
                await self.start()
            }
        }
    }

    private func subscribeChatIfNeeded(sessionKey: String) async {
        let key = sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { return }
        guard let gateway else { return }
        guard !self.chatSubscribedSessionKeys.contains(key) else { return }

        let payload = "{\"sessionKey\":\"\(key)\"}"
        await gateway.sendEvent(event: "chat.subscribe", payloadJSON: payload)
        self.chatSubscribedSessionKeys.insert(key)
        self.logger.info("chat.subscribe ok sessionKey=\(key, privacy: .public)")
    }

    private func unsubscribeAllChats() async {
        guard let gateway else { return }
        let keys = self.chatSubscribedSessionKeys
        self.chatSubscribedSessionKeys.removeAll()
        for key in keys {
            let payload = "{\"sessionKey\":\"\(key)\"}"
            await gateway.sendEvent(event: "chat.unsubscribe", payloadJSON: payload)
        }
    }

    private func buildPrompt(transcript: String) -> String {
        let interrupted = self.lastInterruptedAtSeconds
        self.lastInterruptedAtSeconds = nil
        let includeVoiceHint = UserDefaults.standard.bool(forKey: "talk.voiceDirectiveHint.enabled")
        return TalkPromptBuilder.build(
            transcript: transcript,
            interruptedAtSeconds: interrupted,
            includeVoiceDirectiveHint: includeVoiceHint)
    }

    private enum ChatCompletionState: CustomStringConvertible {
        case final
        case aborted
        case error
        case timeout

        var description: String {
            switch self {
            case .final: "final"
            case .aborted: "aborted"
            case .error: "error"
            case .timeout: "timeout"
            }
        }
    }

    private func sendChat(_ message: String, gateway: GatewayNodeSession) async throws -> String {
        struct SendResponse: Decodable { let runId: String }
        let payload: [String: Any] = [
            "sessionKey": self.mainSessionKey,
            "message": message,
            "thinking": "low",
            "timeoutMs": 30000,
            "idempotencyKey": UUID().uuidString,
        ]
        let data = try JSONSerialization.data(withJSONObject: payload)
        guard let json = String(bytes: data, encoding: .utf8) else {
            throw NSError(
                domain: "TalkModeManager",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Failed to encode chat payload"])
        }
        let res = try await gateway.request(method: "chat.send", paramsJSON: json, timeoutSeconds: 30)
        let decoded = try JSONDecoder().decode(SendResponse.self, from: res)
        return decoded.runId
    }

    private func waitForChatCompletion(
        runId: String,
        gateway: GatewayNodeSession,
        timeoutSeconds: Int = 120) async -> ChatCompletionState
    {
        let stream = await gateway.subscribeServerEvents(bufferingNewest: 200)
        return await withTaskGroup(of: ChatCompletionState.self) { group in
            group.addTask { [runId] in
                for await evt in stream {
                    if Task.isCancelled { return .timeout }
                    guard evt.event == "chat", let payload = evt.payload else { continue }
                    guard let chatEvent = try? GatewayPayloadDecoding.decode(payload, as: ChatEvent.self) else {
                        continue
                    }
                    guard chatEvent.runid == runId else { continue }
                    if let state = chatEvent.state.value as? String {
                        switch state {
                        case "final": return .final
                        case "aborted": return .aborted
                        case "error": return .error
                        default: break
                        }
                    }
                }
                return .timeout
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(timeoutSeconds) * 1_000_000_000)
                return .timeout
            }
            let result = await group.next() ?? .timeout
            group.cancelAll()
            return result
        }
    }

    private func waitForAssistantText(
        gateway: GatewayNodeSession,
        since: Double,
        timeoutSeconds: Int) async throws -> String?
    {
        let deadline = Date().addingTimeInterval(TimeInterval(timeoutSeconds))
        while Date() < deadline {
            if let text = try await self.fetchLatestAssistantText(gateway: gateway, since: since) {
                return text
            }
            try? await Task.sleep(nanoseconds: 300_000_000)
        }
        return nil
    }

    private func fetchLatestAssistantText(gateway: GatewayNodeSession, since: Double? = nil) async throws -> String? {
        let res = try await gateway.request(
            method: "chat.history",
            paramsJSON: "{\"sessionKey\":\"\(self.mainSessionKey)\"}",
            timeoutSeconds: 15)
        guard let json = try JSONSerialization.jsonObject(with: res) as? [String: Any] else { return nil }
        guard let messages = json["messages"] as? [[String: Any]] else { return nil }
        for msg in messages.reversed() {
            guard (msg["role"] as? String) == "assistant" else { continue }
            if let since, let timestamp = msg["timestamp"] as? Double,
               TalkHistoryTimestamp.isAfter(timestamp, sinceSeconds: since) == false
            {
                continue
            }
            guard let content = msg["content"] as? [[String: Any]] else { continue }
            let text = content.compactMap { $0["text"] as? String }.joined(separator: "\n")
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { return trimmed }
        }
        return nil
    }

    private func playAssistant(text: String) async {
        let parsed = TalkDirectiveParser.parse(text)
        let directive = parsed.directive
        let cleaned = parsed.stripped.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return }
        self.applyDirective(directive)

        self.statusText = "Generating voice…"
        self.isSpeaking = true
        self.lastSpokenText = cleaned
        self.allSpokenText = cleaned
        self.ttsAudioBaseline = 0
        self.ttsStartedAt = Date()

        do {
            let started = Date()
            let language = ElevenLabsTTSClient.validatedLanguage(directive?.language)
            let requestedVoice = directive?.voiceId?.trimmingCharacters(in: .whitespacesAndNewlines)
            let resolvedVoice = self.resolveVoiceAlias(requestedVoice)
            if requestedVoice?.isEmpty == false, resolvedVoice == nil {
                self.logger.warning("unknown voice alias \(requestedVoice ?? "?", privacy: .public)")
            }

            let resolvedKey =
                (self.apiKey?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? self.apiKey : nil) ??
                ProcessInfo.processInfo.environment["ELEVENLABS_API_KEY"]
            let apiKey = resolvedKey?.trimmingCharacters(in: .whitespacesAndNewlines)
            let preferredVoice = resolvedVoice ?? self.currentVoiceId ?? self.defaultVoiceId
            let voiceId: String? = if let apiKey, !apiKey.isEmpty {
                await self.resolveVoiceId(preferred: preferredVoice, apiKey: apiKey)
            } else {
                nil
            }
            let canUseElevenLabs = (voiceId?.isEmpty == false) && (apiKey?.isEmpty == false)

            if canUseElevenLabs, let voiceId, let apiKey {
                GatewayDiagnostics.log("talk tts: provider=elevenlabs voiceId=\(voiceId)")
                let desiredOutputFormat = (directive?.outputFormat ?? self.defaultOutputFormat)?
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                let requestedOutputFormat = (desiredOutputFormat?.isEmpty == false) ? desiredOutputFormat : nil
                let outputFormat = ElevenLabsTTSClient.validatedOutputFormat(requestedOutputFormat ?? "pcm_44100")
                if outputFormat == nil, let requestedOutputFormat {
                    self.logger.warning(
                        "talk output_format unsupported for local playback: \(requestedOutputFormat, privacy: .public)")
                }

                let modelId = directive?.modelId ?? self.currentModelId ?? self.defaultModelId
                if let modelId {
                    GatewayDiagnostics.log("talk tts: modelId=\(modelId)")
                }
                func makeRequest(outputFormat: String?) -> ElevenLabsTTSRequest {
                    ElevenLabsTTSRequest(
                        text: cleaned,
                        modelId: modelId,
                        outputFormat: outputFormat,
                        speed: TalkTTSValidation.resolveSpeed(speed: directive?.speed, rateWPM: directive?.rateWPM),
                        stability: TalkTTSValidation.validatedStability(directive?.stability, modelId: modelId),
                        similarity: TalkTTSValidation.validatedUnit(directive?.similarity),
                        style: TalkTTSValidation.validatedUnit(directive?.style),
                        speakerBoost: directive?.speakerBoost,
                        seed: TalkTTSValidation.validatedSeed(directive?.seed),
                        normalize: ElevenLabsTTSClient.validatedNormalize(directive?.normalize),
                        language: language,
                        latencyTier: TalkTTSValidation.validatedLatencyTier(directive?.latencyTier))
                }

                let request = makeRequest(outputFormat: outputFormat)

                let client = ElevenLabsTTSClient(apiKey: apiKey)
                let stream = client.streamSynthesize(voiceId: voiceId, request: request)

                if self.interruptOnSpeech {
                    do {
                        if self.backgroundKeepAlive {
                            await self.resumeRecognitionOnly()
                        } else {
                            try self.startRecognition()
                        }
                    } catch {
                        self.logger.warning(
                            "startRecognition during speak failed: \(error.localizedDescription, privacy: .public)")
                    }
                }

                self.statusText = "Speaking…"
                let sampleRate = TalkTTSValidation.pcmSampleRate(from: outputFormat)
                let result: StreamingPlaybackResult
                if let sampleRate {
                    self.lastPlaybackWasPCM = true
                    var playback = await self.pcmPlayer.play(stream: stream, sampleRate: sampleRate)
                    if !playback.finished, playback.interruptedAt == nil {
                        let mp3Format = ElevenLabsTTSClient.validatedOutputFormat("mp3_44100")
                        self.logger.warning("pcm playback failed; retrying mp3")
                        self.lastPlaybackWasPCM = false
                        let mp3Stream = client.streamSynthesize(
                            voiceId: voiceId,
                            request: makeRequest(outputFormat: mp3Format))
                        playback = await self.mp3Player.play(stream: mp3Stream)
                    }
                    result = playback
                } else {
                    self.lastPlaybackWasPCM = false
                    result = await self.mp3Player.play(stream: stream)
                }
                let duration = Date().timeIntervalSince(started)
                self.logger.info("elevenlabs stream finished=\(result.finished, privacy: .public) dur=\(duration, privacy: .public)s")
                if !result.finished, let interruptedAt = result.interruptedAt {
                    self.lastInterruptedAtSeconds = interruptedAt
                }
            } else {
                self.logger.warning("tts unavailable; falling back to system voice (missing key or voiceId)")
                GatewayDiagnostics.log("talk tts: provider=system (missing key or voiceId)")
                if self.interruptOnSpeech {
                    do {
                        if self.backgroundKeepAlive {
                            await self.resumeRecognitionOnly()
                        } else {
                            try self.startRecognition()
                        }
                    } catch {
                        self.logger.warning(
                            "startRecognition during speak failed: \(error.localizedDescription, privacy: .public)")
                    }
                }
                self.statusText = "Speaking (System)…"
                try await TalkSystemSpeechSynthesizer.shared.speak(text: cleaned, language: language)
            }
        } catch {
            self.logger.error(
                "tts failed: \(error.localizedDescription, privacy: .public); falling back to system voice")
            GatewayDiagnostics.log("talk tts: provider=system (error) msg=\(error.localizedDescription)")
            do {
                if self.interruptOnSpeech {
                    do {
                        if self.backgroundKeepAlive {
                            await self.resumeRecognitionOnly()
                        } else {
                            try self.startRecognition()
                        }
                    } catch {
                        self.logger.warning(
                            "startRecognition during speak failed: \(error.localizedDescription, privacy: .public)")
                    }
                }
                self.statusText = "Speaking (System)…"
                let language = ElevenLabsTTSClient.validatedLanguage(directive?.language)
                try await TalkSystemSpeechSynthesizer.shared.speak(text: cleaned, language: language)
            } catch {
                self.statusText = "Speak failed: \(error.localizedDescription)"
                self.logger.error("system voice failed: \(error.localizedDescription, privacy: .public)")
            }
        }

        // Only stop recognition if not in background keepalive mode
        if !self.backgroundKeepAlive {
            self.stopRecognition()
        } else {
            // In background mode, we want to restart recognition immediately after speaking
            Task { @MainActor [weak self] in
                await self?.resumeRecognitionOnly()
            }
        }
        self.isSpeaking = false
        self.allSpokenText = ""
        self.ttsAudioBaseline = 0
    }

    /// Speak a push message (e.g. from `chat.push`) while properly gating the mic.
    /// Messages are queued so rapid-fire pushes don't cancel each other.
    /// Skipped when incremental speech is already active (normal response flow handles TTS).
    func speakPushMessage(text: String) {
        let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return }

        // Don't fight with the normal incremental speech pipeline
        if self.isSpeechOutputActive {
            self.logger.info("speakPushMessage: skipping, speech output already active")
            return
        }

        self.pushSpeechQueue.append(cleaned)

        if self.pushSpeechTask == nil {
            self.startPushSpeechTask()
        }
    }

    private func startPushSpeechTask() {
        self.pushSpeechTask = Task { @MainActor [weak self] in
            guard let self else { return }

            let talkActive = self.isEnabled

            if talkActive {
                self.isSpeaking = true
                self.statusText = "Speaking…"
                if self.backgroundKeepAlive {
                    self.pauseRecognitionOnly()
                } else {
                    self.stopRecognition()
                }
            }

            while !self.pushSpeechQueue.isEmpty, !Task.isCancelled {
                let segment = self.pushSpeechQueue.removeFirst()
                if talkActive {
                    self.lastSpokenText = segment
                    self.allSpokenText = segment
                    self.statusText = "Speaking…"
                }
                do {
                    try await TalkSystemSpeechSynthesizer.shared.speak(text: segment)
                } catch {
                    self.logger.error("push message speak failed: \(error.localizedDescription, privacy: .public)")
                }
            }

            if talkActive {
                // Restore listening state
                if self.backgroundKeepAlive {
                    await self.resumeRecognitionOnly()
                } else if self.isEnabled {
                    do {
                        try Self.configureAudioSession()
                        try self.startRecognition()
                        self.isListening = true
                    } catch {
                        self.logger.error(
                            "recognition restart after push speak failed: \(error.localizedDescription, privacy: .public)")
                    }
                }
                self.isSpeaking = false
                self.allSpokenText = ""
                self.ttsAudioBaseline = 0
                if self.isEnabled, self.isListening {
                    self.statusText = "Listening"
                }
            }

            self.pushSpeechTask = nil
        }
    }

    private func stopSpeaking(storeInterruption: Bool = true) {
        let hasIncremental = self.incrementalSpeechActive ||
            self.incrementalSpeechTask != nil ||
            !self.incrementalSpeechQueue.isEmpty
        if self.isSpeaking {
            let interruptedAt = self.lastPlaybackWasPCM
                ? self.pcmPlayer.stop()
                : self.mp3Player.stop()
            if storeInterruption {
                self.lastInterruptedAtSeconds = interruptedAt
            }
            _ = self.lastPlaybackWasPCM
                ? self.mp3Player.stop()
                : self.pcmPlayer.stop()
        } else if !hasIncremental {
            return
        }
        TalkSystemSpeechSynthesizer.shared.stop()
        self.cancelIncrementalSpeech()
        self.isSpeaking = false
    }

    /// Normalize text for fuzzy comparison (handles "alright" vs "all right", etc.)
    private static func normalizeForComparison(_ text: String) -> String {
        text.lowercased()
            .replacingOccurrences(of: "all right", with: "alright")
            .replacingOccurrences(of: "gonna", with: "going to")
            .replacingOccurrences(of: "wanna", with: "want to")
            .replacingOccurrences(of: "gotta", with: "got to")
    }

    private func shouldInterrupt(with transcript: String) -> Bool {
        let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 3 else { return false }
        // Grace period: don't allow interrupts in the first 1.5s of TTS while the
        // speaker bleed baseline calibrates. Without this, early partials slip through.
        if let started = self.ttsStartedAt, Date().timeIntervalSince(started) < 1.5 {
            GatewayDiagnostics.log(
                "talk interrupt: BLOCKED (grace period) mic=\(String(format: "%.3f", self.micLevel)) transcript=\"\(trimmed.prefix(40))\"")
            return false
        }
        // Check against all text spoken this TTS cycle using fuzzy normalization.
        let spokenNorm = Self.normalizeForComparison(self.allSpokenText)
        let trimmedNorm = Self.normalizeForComparison(trimmed)
        if !spokenNorm.isEmpty, spokenNorm.contains(trimmedNorm) {
            GatewayDiagnostics.log(
                "talk interrupt: BLOCKED (text match) mic=\(String(format: "%.3f", self.micLevel)) baseline=\(String(format: "%.3f", self.ttsAudioBaseline)) transcript=\"\(trimmed.prefix(40))\"")
            return false
        }
        if let spoken = self.lastSpokenText {
            let segNorm = Self.normalizeForComparison(spoken)
            if segNorm.contains(trimmedNorm) {
                GatewayDiagnostics.log(
                    "talk interrupt: BLOCKED (segment match) mic=\(String(format: "%.3f", self.micLevel)) baseline=\(String(format: "%.3f", self.ttsAudioBaseline)) transcript=\"\(trimmed.prefix(40))\"")
                return false
            }
        }
        // Note: threshold-based gating doesn't work well on speaker because the speaker
        // bleed baseline is so high (0.4-0.6) that the user's voice on top (0.5-0.7) can
        // never exceed 1.5x+ the baseline. Rely on text matching + grace period instead.
        GatewayDiagnostics.log(
            "talk interrupt: ALLOWED mic=\(String(format: "%.3f", self.micLevel)) baseline=\(String(format: "%.3f", self.ttsAudioBaseline)) transcript=\"\(trimmed.prefix(40))\"")
        return true
    }

    private func shouldUseIncrementalTTS() -> Bool {
        true
    }

    private var isSpeechOutputActive: Bool {
        self.isSpeaking ||
            self.incrementalSpeechActive ||
            self.incrementalSpeechTask != nil ||
            !self.incrementalSpeechQueue.isEmpty ||
            self.pushSpeechTask != nil
    }

    private func applyDirective(_ directive: TalkDirective?) {
        let requestedVoice = directive?.voiceId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedVoice = self.resolveVoiceAlias(requestedVoice)
        if requestedVoice?.isEmpty == false, resolvedVoice == nil {
            self.logger.warning("unknown voice alias \(requestedVoice ?? "?", privacy: .public)")
        }
        if let voice = resolvedVoice {
            if directive?.once != true {
                self.currentVoiceId = voice
                self.voiceOverrideActive = true
            }
        }
        if let model = directive?.modelId {
            if directive?.once != true {
                self.currentModelId = model
                self.modelOverrideActive = true
            }
        }
    }

    private func resetIncrementalSpeech() {
        self.incrementalSpeechQueue.removeAll()
        self.incrementalSpeechTask?.cancel()
        self.incrementalSpeechTask = nil
        self.incrementalSpeechActive = true
        self.incrementalSpeechUsed = false
        self.incrementalSpeechLanguage = nil
        self.incrementalSpeechBuffer = IncrementalSpeechBuffer()
        self.incrementalSpeechContext = nil
        self.incrementalSpeechDirective = nil
    }

    private func cancelIncrementalSpeech() {
        self.incrementalSpeechQueue.removeAll()
        self.incrementalSpeechTask?.cancel()
        self.incrementalSpeechTask = nil
        self.incrementalSpeechActive = false
        self.incrementalSpeechContext = nil
        self.incrementalSpeechDirective = nil
    }

    private func enqueueIncrementalSpeech(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        self.incrementalSpeechQueue.append(trimmed)
        self.incrementalSpeechUsed = true
        if self.incrementalSpeechTask == nil {
            self.startIncrementalSpeechTask()
        }
    }

    private func startIncrementalSpeechTask() {
        if self.interruptOnSpeech {
            do {
                if self.backgroundKeepAlive {
                    Task { await self.resumeRecognitionOnly() }
                } else {
                    try self.startRecognition()
                }
            } catch {
                self.logger.warning(
                    "startRecognition during incremental speak failed: \(error.localizedDescription, privacy: .public)")
            }
        }

        self.incrementalSpeechTask = Task { @MainActor [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                guard !self.incrementalSpeechQueue.isEmpty else { break }
                let segment = self.incrementalSpeechQueue.removeFirst()
                self.statusText = "Speaking…"
                self.isSpeaking = true
                self.lastSpokenText = segment
                self.allSpokenText += " " + segment
                await self.speakIncrementalSegment(segment)
            }
            self.isSpeaking = false
            self.allSpokenText = ""
            self.ttsAudioBaseline = 0
            if self.backgroundKeepAlive {
                self.pauseRecognitionOnly()
            } else {
                self.stopRecognition()
            }
            self.incrementalSpeechTask = nil
        }
    }

    private func finishIncrementalSpeech() async {
        guard self.incrementalSpeechActive else { return }
        let leftover = self.incrementalSpeechBuffer.flush()
        if let leftover {
            self.enqueueIncrementalSpeech(leftover)
        }
        if let task = self.incrementalSpeechTask {
            _ = await task.result
        }
        self.incrementalSpeechActive = false
    }

    private func handleIncrementalAssistantFinal(text: String) async {
        let parsed = TalkDirectiveParser.parse(text)
        self.applyDirective(parsed.directive)
        if let lang = parsed.directive?.language {
            self.incrementalSpeechLanguage = ElevenLabsTTSClient.validatedLanguage(lang)
        }
        await self.updateIncrementalContextIfNeeded()
        let segments = self.incrementalSpeechBuffer.ingest(text: text, isFinal: true)
        for segment in segments {
            self.enqueueIncrementalSpeech(segment)
        }
        await self.finishIncrementalSpeech()
        if !self.incrementalSpeechUsed {
            await self.playAssistant(text: text)
        }
    }

    private func streamAssistant(runId: String, gateway: GatewayNodeSession) async {
        let stream = await gateway.subscribeServerEvents(bufferingNewest: 200)
        for await evt in stream {
            if Task.isCancelled { return }
            guard evt.event == "agent", let payload = evt.payload else { continue }
            guard let agentEvent = try? GatewayPayloadDecoding.decode(payload, as: OpenClawAgentEventPayload.self) else {
                continue
            }
            guard agentEvent.runId == runId, agentEvent.stream == "assistant" else { continue }
            guard let text = agentEvent.data["text"]?.value as? String else { continue }
            let segments = self.incrementalSpeechBuffer.ingest(text: text, isFinal: false)
            if let lang = self.incrementalSpeechBuffer.directive?.language {
                self.incrementalSpeechLanguage = ElevenLabsTTSClient.validatedLanguage(lang)
            }
            await self.updateIncrementalContextIfNeeded()
            for segment in segments {
                self.enqueueIncrementalSpeech(segment)
            }
        }
    }

    private func updateIncrementalContextIfNeeded() async {
        let directive = self.incrementalSpeechBuffer.directive
        if let existing = self.incrementalSpeechContext, directive == self.incrementalSpeechDirective {
            if existing.language != self.incrementalSpeechLanguage {
                self.incrementalSpeechContext = IncrementalSpeechContext(
                    apiKey: existing.apiKey,
                    voiceId: existing.voiceId,
                    modelId: existing.modelId,
                    outputFormat: existing.outputFormat,
                    language: self.incrementalSpeechLanguage,
                    directive: existing.directive,
                    canUseElevenLabs: existing.canUseElevenLabs)
            }
            return
        }
        let context = await self.buildIncrementalSpeechContext(directive: directive)
        self.incrementalSpeechContext = context
        self.incrementalSpeechDirective = directive
    }

    private func buildIncrementalSpeechContext(directive: TalkDirective?) async -> IncrementalSpeechContext {
        let requestedVoice = directive?.voiceId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedVoice = self.resolveVoiceAlias(requestedVoice)
        if requestedVoice?.isEmpty == false, resolvedVoice == nil {
            self.logger.warning("unknown voice alias \(requestedVoice ?? "?", privacy: .public)")
        }
        let preferredVoice = resolvedVoice ?? self.currentVoiceId ?? self.defaultVoiceId
        let modelId = directive?.modelId ?? self.currentModelId ?? self.defaultModelId
        let desiredOutputFormat = (directive?.outputFormat ?? self.defaultOutputFormat)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let requestedOutputFormat = (desiredOutputFormat?.isEmpty == false) ? desiredOutputFormat : nil
        let outputFormat = ElevenLabsTTSClient.validatedOutputFormat(requestedOutputFormat ?? "pcm_44100")
        if outputFormat == nil, let requestedOutputFormat {
            self.logger.warning(
                "talk output_format unsupported for local playback: \(requestedOutputFormat, privacy: .public)")
        }

        let resolvedKey =
            (self.apiKey?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? self.apiKey : nil) ??
            ProcessInfo.processInfo.environment["ELEVENLABS_API_KEY"]
        let apiKey = resolvedKey?.trimmingCharacters(in: .whitespacesAndNewlines)
        let voiceId: String? = if let apiKey, !apiKey.isEmpty {
            await self.resolveVoiceId(preferred: preferredVoice, apiKey: apiKey)
        } else {
            nil
        }
        let canUseElevenLabs = (voiceId?.isEmpty == false) && (apiKey?.isEmpty == false)
        return IncrementalSpeechContext(
            apiKey: apiKey,
            voiceId: voiceId,
            modelId: modelId,
            outputFormat: outputFormat,
            language: self.incrementalSpeechLanguage,
            directive: directive,
            canUseElevenLabs: canUseElevenLabs)
    }

    private func speakIncrementalSegment(_ text: String) async {
        await self.updateIncrementalContextIfNeeded()
        guard let context = self.incrementalSpeechContext else {
            try? await TalkSystemSpeechSynthesizer.shared.speak(
                text: text,
                language: self.incrementalSpeechLanguage)
            return
        }

        if context.canUseElevenLabs, let apiKey = context.apiKey, let voiceId = context.voiceId {
            let request = ElevenLabsTTSRequest(
                text: text,
                modelId: context.modelId,
                outputFormat: context.outputFormat,
                speed: TalkTTSValidation.resolveSpeed(
                    speed: context.directive?.speed,
                    rateWPM: context.directive?.rateWPM),
                stability: TalkTTSValidation.validatedStability(
                    context.directive?.stability,
                    modelId: context.modelId),
                similarity: TalkTTSValidation.validatedUnit(context.directive?.similarity),
                style: TalkTTSValidation.validatedUnit(context.directive?.style),
                speakerBoost: context.directive?.speakerBoost,
                seed: TalkTTSValidation.validatedSeed(context.directive?.seed),
                normalize: ElevenLabsTTSClient.validatedNormalize(context.directive?.normalize),
                language: context.language,
                latencyTier: TalkTTSValidation.validatedLatencyTier(context.directive?.latencyTier))
            let client = ElevenLabsTTSClient(apiKey: apiKey)
            let stream = client.streamSynthesize(voiceId: voiceId, request: request)
            let sampleRate = TalkTTSValidation.pcmSampleRate(from: context.outputFormat)
            let result: StreamingPlaybackResult
            if let sampleRate {
                self.lastPlaybackWasPCM = true
                var playback = await self.pcmPlayer.play(stream: stream, sampleRate: sampleRate)
                if !playback.finished, playback.interruptedAt == nil {
                    self.logger.warning("pcm playback failed; retrying mp3")
                    self.lastPlaybackWasPCM = false
                    let mp3Format = ElevenLabsTTSClient.validatedOutputFormat("mp3_44100")
                    let mp3Stream = client.streamSynthesize(
                        voiceId: voiceId,
                        request: ElevenLabsTTSRequest(
                            text: text,
                            modelId: context.modelId,
                            outputFormat: mp3Format,
                            speed: TalkTTSValidation.resolveSpeed(
                                speed: context.directive?.speed,
                                rateWPM: context.directive?.rateWPM),
                            stability: TalkTTSValidation.validatedStability(
                                context.directive?.stability,
                                modelId: context.modelId),
                            similarity: TalkTTSValidation.validatedUnit(context.directive?.similarity),
                            style: TalkTTSValidation.validatedUnit(context.directive?.style),
                            speakerBoost: context.directive?.speakerBoost,
                            seed: TalkTTSValidation.validatedSeed(context.directive?.seed),
                            normalize: ElevenLabsTTSClient.validatedNormalize(context.directive?.normalize),
                            language: context.language,
                            latencyTier: TalkTTSValidation.validatedLatencyTier(context.directive?.latencyTier)))
                    playback = await self.mp3Player.play(stream: mp3Stream)
                }
                result = playback
            } else {
                self.lastPlaybackWasPCM = false
                result = await self.mp3Player.play(stream: stream)
            }
            if !result.finished, let interruptedAt = result.interruptedAt {
                self.lastInterruptedAtSeconds = interruptedAt
            }
        } else {
            try? await TalkSystemSpeechSynthesizer.shared.speak(
                text: text,
                language: self.incrementalSpeechLanguage)
        }
    }

}

private struct IncrementalSpeechBuffer {
    private(set) var latestText: String = ""
    private(set) var directive: TalkDirective?
    private var spokenOffset: Int = 0
    private var inCodeBlock = false
    private var directiveParsed = false

    mutating func ingest(text: String, isFinal: Bool) -> [String] {
        let normalized = text.replacingOccurrences(of: "\r\n", with: "\n")
        guard let usable = self.stripDirectiveIfReady(from: normalized) else { return [] }
        self.updateText(usable)
        return self.extractSegments(isFinal: isFinal)
    }

    mutating func flush() -> String? {
        guard !self.latestText.isEmpty else { return nil }
        let segments = self.extractSegments(isFinal: true)
        return segments.first
    }

    private mutating func stripDirectiveIfReady(from text: String) -> String? {
        guard !self.directiveParsed else { return text }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if trimmed.hasPrefix("{") {
            guard let newlineRange = text.range(of: "\n") else { return nil }
            let firstLine = text[..<newlineRange.lowerBound]
            let head = firstLine.trimmingCharacters(in: .whitespacesAndNewlines)
            guard head.hasSuffix("}") else { return nil }
            let parsed = TalkDirectiveParser.parse(text)
            if let directive = parsed.directive {
                self.directive = directive
            }
            self.directiveParsed = true
            return parsed.stripped
        }
        self.directiveParsed = true
        return text
    }

    private mutating func updateText(_ newText: String) {
        if newText.hasPrefix(self.latestText) {
            self.latestText = newText
        } else if self.latestText.hasPrefix(newText) {
            // Stream reset or correction; prefer the newer prefix.
            self.latestText = newText
            self.spokenOffset = min(self.spokenOffset, newText.count)
        } else {
            // Diverged text means chunks arrived out of order or stream restarted.
            let commonPrefix = Self.commonPrefixCount(self.latestText, newText)
            self.latestText = newText
            if self.spokenOffset > commonPrefix {
                self.spokenOffset = commonPrefix
            }
        }
        if self.spokenOffset > self.latestText.count {
            self.spokenOffset = self.latestText.count
        }
    }

    private static func commonPrefixCount(_ lhs: String, _ rhs: String) -> Int {
        let left = Array(lhs)
        let right = Array(rhs)
        let limit = min(left.count, right.count)
        var idx = 0
        while idx < limit, left[idx] == right[idx] {
            idx += 1
        }
        return idx
    }

    private mutating func extractSegments(isFinal: Bool) -> [String] {
        let chars = Array(self.latestText)
        guard self.spokenOffset < chars.count else { return [] }
        var idx = self.spokenOffset
        var lastBoundary: Int?
        var inCodeBlock = self.inCodeBlock
        var buffer = ""
        var bufferAtBoundary = ""
        var inCodeBlockAtBoundary = inCodeBlock

        while idx < chars.count {
            if idx + 2 < chars.count,
               chars[idx] == "`",
               chars[idx + 1] == "`",
               chars[idx + 2] == "`"
            {
                inCodeBlock.toggle()
                idx += 3
                continue
            }

            if !inCodeBlock {
                buffer.append(chars[idx])
                if Self.isBoundary(chars[idx]) {
                    lastBoundary = idx + 1
                    bufferAtBoundary = buffer
                    inCodeBlockAtBoundary = inCodeBlock
                }
            }

            idx += 1
        }

        if let boundary = lastBoundary {
            self.spokenOffset = boundary
            self.inCodeBlock = inCodeBlockAtBoundary
            let trimmed = bufferAtBoundary.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? [] : [trimmed]
        }

        guard isFinal else { return [] }
        self.spokenOffset = chars.count
        self.inCodeBlock = inCodeBlock
        let trimmed = buffer.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? [] : [trimmed]
    }

    private static func isBoundary(_ ch: Character) -> Bool {
        ch == "." || ch == "!" || ch == "?" || ch == "\n"
    }
}

extension TalkModeManager {
    nonisolated static func requestMicrophonePermission() async -> Bool {
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

    nonisolated static func requestSpeechPermission() async -> Bool {
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
                onTimeout: { NSError(domain: "TalkMode", code: 6, userInfo: [
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

    static func permissionMessage(
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

    static func permissionMessage(
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

extension TalkModeManager {
    func resolveVoiceAlias(_ value: String?) -> String? {
        let trimmed = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let normalized = trimmed.lowercased()
        if let mapped = self.voiceAliases[normalized] { return mapped }
        if self.voiceAliases.values.contains(where: { $0.caseInsensitiveCompare(trimmed) == .orderedSame }) {
            return trimmed
        }
        return Self.isLikelyVoiceId(trimmed) ? trimmed : nil
    }

    func resolveVoiceId(preferred: String?, apiKey: String) async -> String? {
        let trimmed = preferred?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmed.isEmpty {
            // Config / directives can provide a raw ElevenLabs voiceId (not an alias).
            // Accept it directly to avoid unnecessary listVoices calls (and accidental fallback selection).
            if Self.isLikelyVoiceId(trimmed) {
                return trimmed
            }
            if let resolved = self.resolveVoiceAlias(trimmed) { return resolved }
            self.logger.warning("unknown voice alias \(trimmed, privacy: .public)")
        }
        if let fallbackVoiceId { return fallbackVoiceId }

        do {
            let voices = try await ElevenLabsTTSClient(apiKey: apiKey).listVoices()
            guard let first = voices.first else {
                self.logger.warning("elevenlabs voices list empty")
                return nil
            }
            self.fallbackVoiceId = first.voiceId
            if self.defaultVoiceId == nil {
                self.defaultVoiceId = first.voiceId
            }
            if !self.voiceOverrideActive {
                self.currentVoiceId = first.voiceId
            }
            let name = first.name ?? "unknown"
            self.logger
                .info("default voice selected \(name, privacy: .public) (\(first.voiceId, privacy: .public))")
            return first.voiceId
        } catch {
            self.logger.error("elevenlabs list voices failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    static func isLikelyVoiceId(_ value: String) -> Bool {
        guard value.count >= 10 else { return false }
        return value.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
    }

    func reloadConfig(force: Bool = false) async {
        guard let gateway else { return }
        if !force, let last = self.lastConfigReload, Date().timeIntervalSince(last) < 60 {
            return
        }
        do {
            let res = try await gateway.request(method: "talk.config", paramsJSON: "{\"includeSecrets\":true}", timeoutSeconds: 8)
            guard let json = try JSONSerialization.jsonObject(with: res) as? [String: Any] else { return }
            guard let config = json["config"] as? [String: Any] else { return }
            let talk = config["talk"] as? [String: Any]
            self.defaultVoiceId = (talk?["voiceId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let aliases = talk?["voiceAliases"] as? [String: Any] {
                var resolved: [String: String] = [:]
                for (key, value) in aliases {
                    guard let id = value as? String else { continue }
                    let normalizedKey = key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                    let trimmedId = id.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !normalizedKey.isEmpty, !trimmedId.isEmpty else { continue }
                    resolved[normalizedKey] = trimmedId
                }
                self.voiceAliases = resolved
            } else {
                self.voiceAliases = [:]
            }
            if !self.voiceOverrideActive {
                self.currentVoiceId = self.defaultVoiceId
            }
            let model = (talk?["modelId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            self.defaultModelId = (model?.isEmpty == false) ? model : Self.defaultModelIdFallback
            if !self.modelOverrideActive {
                self.currentModelId = self.defaultModelId
            }
            self.defaultOutputFormat = (talk?["outputFormat"] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            self.apiKey = (talk?["apiKey"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let interrupt = talk?["interruptOnSpeech"] as? Bool {
                self.interruptOnSpeech = interrupt
            }
            self.lastConfigReload = Date()
        } catch {
            self.defaultModelId = Self.defaultModelIdFallback
            if !self.modelOverrideActive {
                self.currentModelId = self.defaultModelId
            }
        }
    }

    static func configureAudioSession() throws {
        let session = AVAudioSession.sharedInstance()
        // Use `.spokenAudio` for best STT accuracy. Speaker-to-mic feedback during TTS
        // is handled by disabling interrupt-on-speech on speaker rather than hardware AEC,
        // because TTS plays through separate audio players (not AVAudioEngine output).
        try session.setCategory(.playAndRecord, mode: .spokenAudio, options: [
            .allowBluetooth,
            .allowBluetoothA2DP,
            .allowBluetoothHFP,
            .defaultToSpeaker,
        ])
        try? session.setPreferredSampleRate(48_000)
        try? session.setPreferredIOBufferDuration(0.02)
        try session.setActive(true, options: [])
    }

    // MARK: - Audio route change handling

    private func observeAudioRouteChanges() {
        self.routeChangeObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let self else { return }
            let reason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
            let reasonEnum = reason.flatMap { AVAudioSession.RouteChangeReason(rawValue: $0) }
            let route = AVAudioSession.sharedInstance().currentRoute
            let outputs = route.outputs.map { $0.portType.rawValue }.joined(separator: ",")
            let inputs = route.inputs.map { $0.portType.rawValue }.joined(separator: ",")
            GatewayDiagnostics.log(
                "talk audio: route changed reason=\(reasonEnum.map { String(describing: $0) } ?? "?") in=[\(inputs)] out=[\(outputs)]")
            self.logger.info("audio route changed: reason=\(reason ?? 0) in=[\(inputs)] out=[\(outputs)]")
            Task { @MainActor [weak self] in
                await self?.handleAudioRouteChange(reason: reasonEnum)
            }
        }

        self.interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let self else { return }
            let type = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            let typeEnum = type.flatMap { AVAudioSession.InterruptionType(rawValue: $0) }
            GatewayDiagnostics.log("talk audio: interruption type=\(typeEnum.map { String(describing: $0) } ?? "?")")
            if typeEnum == .ended {
                Task { @MainActor [weak self] in
                    guard let self, self.isEnabled else { return }
                    try? Self.configureAudioSession()
                    await self.start()
                }
            }
        }
    }

    private func handleAudioRouteChange(reason: AVAudioSession.RouteChangeReason?) async {
        guard self.isEnabled, self.isListening else { return }
        // When audio route changes (headphones plugged in/out, Bluetooth connects/disconnects),
        // the AVAudioEngine input format changes. We need to restart recognition with the new format.
        switch reason {
        case .newDeviceAvailable, .oldDeviceUnavailable:
            self.logger.info("restarting recognition for audio route change")
            GatewayDiagnostics.log("talk audio: restarting recognition for route change")
            if self.backgroundKeepAlive {
                self.pauseRecognitionOnly()
                try? Self.configureAudioSession()
                await self.resumeRecognitionOnly()
            } else {
                self.stopRecognition()
                do {
                    try Self.configureAudioSession()
                    try self.startRecognition()
                    self.isListening = true
                    self.statusText = "Listening"
                } catch {
                    self.statusText = "Route change failed: \(error.localizedDescription)"
                    self.logger.error("route change restart failed: \(error.localizedDescription, privacy: .public)")
                }
            }
        default:
            break
        }
    }

    // MARK: - Background audio keepalive

    /// Starts a silent audio loop to prevent iOS from suspending the app in the background.
    /// This leverages UIBackgroundModes=audio+voip to keep the process alive between speech
    /// recognition cycles. With the AVAudioEngine now kept running continuously, this serves
    /// as an additional safety net.
    func startBackgroundAudioKeepAlive() {
        guard self.backgroundKeepAlive else { return }
        guard self.backgroundAudioPlayer == nil else { return }
        
        // With our improved approach where AVAudioEngine stays running, we might not need
        // the silent audio player as much, but keeping it as a safety net for robustness.
        // The continuous AVAudioEngine + VoIP background mode should be the primary keepalive.
        
        if self.audioEngine.isRunning {
            self.logger.info("background keepalive: AVAudioEngine already running, minimal silent player")
            // Engine is running, so we need less aggressive keepalive
        } else {
            self.logger.warning("background keepalive: AVAudioEngine not running, full silent player keepalive")
        }
        
        // Generate a tiny silent WAV in memory (44-byte header + 8000 silent samples).
        let sampleRate: UInt32 = 8000
        let numSamples: UInt32 = sampleRate // 1 second of silence
        let dataSize = numSamples * 2 // 16-bit mono
        let fileSize = 36 + dataSize
        var wav = Data(capacity: Int(44 + dataSize))
        wav.append(contentsOf: [0x52, 0x49, 0x46, 0x46]) // "RIFF"
        wav.append(contentsOf: withUnsafeBytes(of: fileSize.littleEndian) { Array($0) })
        wav.append(contentsOf: [0x57, 0x41, 0x56, 0x45]) // "WAVE"
        wav.append(contentsOf: [0x66, 0x6D, 0x74, 0x20]) // "fmt "
        wav.append(contentsOf: withUnsafeBytes(of: UInt32(16).littleEndian) { Array($0) }) // chunk size
        wav.append(contentsOf: withUnsafeBytes(of: UInt16(1).littleEndian) { Array($0) }) // PCM
        wav.append(contentsOf: withUnsafeBytes(of: UInt16(1).littleEndian) { Array($0) }) // mono
        wav.append(contentsOf: withUnsafeBytes(of: sampleRate.littleEndian) { Array($0) })
        wav.append(contentsOf: withUnsafeBytes(of: (sampleRate * 2).littleEndian) { Array($0) }) // byte rate
        wav.append(contentsOf: withUnsafeBytes(of: UInt16(2).littleEndian) { Array($0) }) // block align
        wav.append(contentsOf: withUnsafeBytes(of: UInt16(16).littleEndian) { Array($0) }) // bits per sample
        wav.append(contentsOf: [0x64, 0x61, 0x74, 0x61]) // "data"
        wav.append(contentsOf: withUnsafeBytes(of: dataSize.littleEndian) { Array($0) })
        wav.append(Data(count: Int(dataSize))) // silent samples
        do {
            let player = try AVAudioPlayer(data: wav)
            player.numberOfLoops = -1 // loop forever
            player.volume = 0.0
            player.play()
            self.backgroundAudioPlayer = player
            self.logger.info("background audio keepalive started (engine=\(self.audioEngine.isRunning))")
            GatewayDiagnostics.log("talk: background audio keepalive started engineRunning=\(self.audioEngine.isRunning)")
        } catch {
            self.logger.warning("background audio keepalive failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    func stopBackgroundAudioKeepAlive() {
        guard let player = self.backgroundAudioPlayer else { return }
        player.stop()
        self.backgroundAudioPlayer = nil
        self.logger.info("background audio keepalive stopped")
    }

    private static func describeAudioSession() -> String {
        let session = AVAudioSession.sharedInstance()
        let inputs = session.currentRoute.inputs.map { "\($0.portType.rawValue):\($0.portName)" }.joined(separator: ",")
        let outputs = session.currentRoute.outputs.map { "\($0.portType.rawValue):\($0.portName)" }.joined(separator: ",")
        let available = session.availableInputs?.map { "\($0.portType.rawValue):\($0.portName)" }.joined(separator: ",") ?? ""
        return "category=\(session.category.rawValue) mode=\(session.mode.rawValue) opts=\(session.categoryOptions.rawValue) inputAvail=\(session.isInputAvailable) routeIn=[\(inputs)] routeOut=[\(outputs)] availIn=[\(available)]"
    }
}

private final class AudioTapDiagnostics: @unchecked Sendable {
    private let label: String
    private let onLevel: (@Sendable (Float) -> Void)?
    private let lock = NSLock()
    private var bufferCount: Int = 0
    private var lastLoggedAt = Date.distantPast
    private var lastLevelEmitAt = Date.distantPast
    private var maxRmsWindow: Float = 0
    private var lastRms: Float = 0

    init(label: String, onLevel: (@Sendable (Float) -> Void)? = nil) {
        self.label = label
        self.onLevel = onLevel
    }

    func onBuffer(_ buffer: AVAudioPCMBuffer) {
        var shouldLog = false
        var shouldEmitLevel = false
        var count = 0
        lock.lock()
        bufferCount += 1
        count = bufferCount
        let now = Date()
        if now.timeIntervalSince(lastLoggedAt) >= 1.0 {
            lastLoggedAt = now
            shouldLog = true
        }
        if now.timeIntervalSince(lastLevelEmitAt) >= 0.12 {
            lastLevelEmitAt = now
            shouldEmitLevel = true
        }
        lock.unlock()

        let rate = buffer.format.sampleRate
        let ch = buffer.format.channelCount
        let frames = buffer.frameLength

        var rms: Float?
        if let data = buffer.floatChannelData?.pointee {
            let n = Int(frames)
            if n > 0 {
                var sum: Float = 0
                for i in 0..<n {
                    let v = data[i]
                    sum += v * v
                }
                rms = sqrt(sum / Float(n))
            }
        }

        let resolvedRms = rms ?? 0
        lock.lock()
        lastRms = resolvedRms
        if resolvedRms > maxRmsWindow { maxRmsWindow = resolvedRms }
        let maxRms = maxRmsWindow
        if shouldLog { maxRmsWindow = 0 }
        lock.unlock()

        if shouldEmitLevel, let onLevel {
            onLevel(resolvedRms)
        }

        guard shouldLog else { return }
        GatewayDiagnostics.log(
            "\(label) mic: buffers=\(count) frames=\(frames) rate=\(Int(rate))Hz ch=\(ch) rms=\(String(format: "%.4f", resolvedRms)) max=\(String(format: "%.4f", maxRms))")
    }
}

#if DEBUG
extension TalkModeManager {
    func _test_seedTranscript(_ transcript: String) {
        self.lastTranscript = transcript
        self.lastHeard = Date()
    }

    func _test_handleTranscript(_ transcript: String, isFinal: Bool) async {
        await self.handleTranscript(transcript: transcript, isFinal: isFinal)
    }

    func _test_backdateLastHeard(seconds: TimeInterval) {
        self.lastHeard = Date().addingTimeInterval(-seconds)
    }

    func _test_runSilenceCheck() async {
        await self.checkSilence()
    }

    func _test_incrementalReset() {
        self.incrementalSpeechBuffer = IncrementalSpeechBuffer()
    }

    func _test_incrementalIngest(_ text: String, isFinal: Bool) -> [String] {
        self.incrementalSpeechBuffer.ingest(text: text, isFinal: isFinal)
    }
}
#endif

private struct IncrementalSpeechContext {
    let apiKey: String?
    let voiceId: String?
    let modelId: String?
    let outputFormat: String?
    let language: String?
    let directive: TalkDirective?
    let canUseElevenLabs: Bool
}

// swiftlint:enable type_body_length
