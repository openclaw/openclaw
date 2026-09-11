import AppKit
import Observation
import OpenClawKit

@MainActor
@Observable
final class TalkModeController {
    static var shared: TalkModeController {
        AppStateStore.shared.voiceRuntime.talkController
    }

    struct Owners: Sendable {
        let runtime: TalkModeRuntime
        let wake: VoiceWakeRuntime
        let hotkey: VoicePushToTalkHotkey
        let overlay: TalkOverlayController
        let interruptMonitor: TalkSpeechInterruptMonitor
    }

    typealias OwnersProvider = @MainActor @Sendable () -> Owners
    @ObservationIgnored private let state: AppVoiceRuntime.State
    @ObservationIgnored private let owners: OwnersProvider
    @ObservationIgnored private let publishTalk: AppVoiceRuntime.PublishTalk

    static func liveOwners() -> Owners {
        let voice = AppStateStore.shared.voiceRuntime
        return Owners(
            runtime: voice.talkRuntime,
            wake: voice.wake,
            hotkey: voice.hotkey,
            overlay: voice.talkOverlay,
            interruptMonitor: voice.interruptMonitor)
    }

    init(
        state: @escaping AppVoiceRuntime.State = { AppStateStore.shared },
        owners: @escaping OwnersProvider = TalkModeController.liveOwners,
        publishTalk: @escaping AppVoiceRuntime.PublishTalk = AppVoiceRuntime.livePublishTalk)
    {
        self.state = state
        self.owners = owners
        self.publishTalk = publishTalk
    }

    private let logger = Logger(subsystem: "ai.openclaw", category: "talk.controller")
    private static let transcriptLimit = 20

    private(set) var phase: TalkModePhase = .idle
    private(set) var isPaused: Bool = false
    private(set) var level: Double = 0
    private(set) var partialTranscript: String = ""
    private(set) var recentTranscripts: [String] = []
    @ObservationIgnored private var transitionID = UUID()
    @ObservationIgnored private var wakePauseLease: UUID?
    @ObservationIgnored private var wakePauseTask: Task<Void, Never>?
    @ObservationIgnored private var shutdownTask: Task<Void, Never>?

    /// Meters streamed PCM speech so the orb waveform follows the audible
    /// envelope instead of a synthetic pulse.
    @ObservationIgnored private lazy var playbackEnvelope = PCMPlaybackEnvelope { [weak self] level in
        self?.updateSpeakingLevel(level)
    }

    func setEnabled(_ enabled: Bool) async {
        guard !enabled || self.state() != nil else { return }
        let owners = self.owners()
        let transitionID = UUID()
        self.transitionID = transitionID
        // Preference updates must not reopen PTT during Talk admission or audio teardown.
        owners.hotkey.setTalkSuppressed(true)
        self.logger.info("talk enabled=\(enabled)")
        if enabled {
            self.partialTranscript = ""
            self.recentTranscripts = []
            owners.overlay.present()
        } else {
            owners.overlay.dismiss()
        }
        owners.interruptMonitor.setEnabled(enabled && self.state()?.talkShiftToStopEnabled == true)
        if !enabled {
            let previousShutdown = self.shutdownTask
            self.shutdownTask = Task {
                // Disable invalidates a suspended startup immediately. A repeated disable still
                // joins the original shutdown before PTT or another Talk start can acquire audio.
                await owners.runtime.setEnabled(false)
                await previousShutdown?.value
            }
        }
        let shutdown = self.shutdownTask
        if enabled, self.wakePauseLease == nil {
            let lease = UUID()
            self.wakePauseLease = lease
            self.wakePauseTask = Task { await owners.wake.pauseForPushToTalk(lease: lease) }
        }
        // Overlapping transitions share the acquisition until the latest Off has shut down.
        // A replaced caller may release its wake handoff only after this insertion is acknowledged.
        await self.wakePauseTask?.value
        guard self.transitionID == transitionID else { return }
        await shutdown?.value
        if enabled, self.transitionID == transitionID {
            await owners.runtime.setEnabled(true)
        }

        guard self.transitionID == transitionID else { return }
        self.shutdownTask = nil
        guard !enabled else { return }
        let lease = self.wakePauseLease
        self.wakePauseLease = nil
        self.wakePauseTask = nil
        owners.hotkey.setTalkSuppressed(false)
        if let lease {
            await owners.wake.resumeAfterPushToTalk(lease: lease)
        }
    }

    func updatePhase(_ phase: TalkModePhase) {
        let previousPhase = self.phase
        self.phase = phase
        if phase == .idle || phase == .thinking {
            self.updateLevel(0)
        }
        self.owners().overlay.updatePhase(phase)

        if phase != previousPhase {
            self.playPhaseSound(phase, previousPhase: previousPhase)
        }
        self.publishPhase()
    }

    private func publishPhase() {
        guard let state = self.state(), state.voiceRuntime.isActive else { return }
        let effectivePhase = self.isPaused ? "paused" : self.phase.rawValue
        let enabled = state.talkEnabled
        Task { [publishTalk] in await publishTalk(enabled, effectivePhase) }
    }

    private func playPhaseSound(_ phase: TalkModePhase, previousPhase: TalkModePhase) {
        guard let state = self.state() else { return }
        guard !state.isPreview, state.talkPhaseSoundsEnabled else { return }
        let soundName: String? = switch phase {
        case .thinking:
            "Tink" // 생각 중: 짧고 가벼운 소리
        case .speaking:
            "Pop" // 대답 시작: 톡 소리
        case .listening:
            // 대답 중단(speaking→listening): 부드러운 종료음
            // 듣기 시작(thinking→listening 등): 잠수함 소리
            previousPhase == .speaking ? "Bottle" : "Submarine"
        case .idle:
            nil
        }
        if let soundName {
            NSSound(named: NSSound.Name(soundName))?.play()
        }
    }

    func updateLevel(_ level: Double) {
        let clamped = min(max(level, 0), 1)
        if clamped == 0 {
            self.level = 0
        } else {
            let response = clamped > self.level ? 0.45 : 0.18
            self.level += (clamped - self.level) * response
        }
        self.owners().overlay.updateLevel(self.level)
    }

    /// Playback level published while agent speech plays; nil (path without
    /// metering, or playback ended) settles the wave back to its floor.
    func updateSpeakingLevel(_ level: Double?) {
        guard self.phase == .speaking else { return }
        self.updateLevel(level ?? 0)
    }

    func updatePartialTranscript(_ transcript: String) {
        self.partialTranscript = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func commitTranscript(_ transcript: String) {
        let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        self.partialTranscript = ""
        guard !trimmed.isEmpty else { return }
        self.recentTranscripts.append(trimmed)
        if self.recentTranscripts.count > Self.transcriptLimit {
            self.recentTranscripts.removeFirst(self.recentTranscripts.count - Self.transcriptLimit)
        }
    }

    /// Passes streamed PCM speech through to the player while feeding the
    /// playback envelope; call `endSpeechMetering` once playback returns.
    func meteredSpeechStream(
        _ stream: AsyncThrowingStream<Data, Error>,
        sampleRate: Double) -> AsyncThrowingStream<Data, Error>
    {
        self.playbackEnvelope.metering(stream, sampleRate: sampleRate)
    }

    func endSpeechMetering() {
        self.playbackEnvelope.cancel()
    }

    func setPaused(_ paused: Bool) {
        guard self.isPaused != paused else { return }
        self.logger.info("talk paused=\(paused)")
        self.isPaused = paused
        let owners = self.owners()
        owners.overlay.updatePaused(paused)
        guard self.state()?.voiceRuntime.isActive == true else { return }
        self.publishPhase()
        Task { await owners.runtime.setPaused(paused) }
    }

    func togglePaused() {
        self.setPaused(!self.isPaused)
    }

    func stopSpeaking(reason: TalkStopReason = .userTap) {
        let runtime = self.owners().runtime
        Task { await runtime.stopSpeaking(reason: reason) }
    }

    func exitTalkMode() {
        guard let state = self.state() else { return }
        Task { await state.setTalkEnabled(false) }
    }
}

enum TalkStopReason {
    case userTap
    case speech
    case manual
}
