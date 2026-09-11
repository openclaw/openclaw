import Foundation
import OpenClawKit

struct VoicePermissions: Sendable {
    let supported: @Sendable () -> Bool
    let granted: @Sendable () -> Bool
    let ensure: @Sendable (Bool) async -> Bool

    static let live = Self(
        supported: { voiceWakeSupported },
        granted: { PermissionManager.voiceWakePermissionsGranted() },
        ensure: { await PermissionManager.ensureVoiceWakePermissions(interactive: $0) })
}

@MainActor
final class AppVoiceRuntime {
    typealias State = @MainActor @Sendable () -> AppState?
    typealias Controller = @MainActor @Sendable () -> TalkModeController?
    typealias UIAction = @MainActor @Sendable () -> Void
    typealias Forward = @Sendable (String, String?) async -> Result<Void, VoiceWakeForwarder.VoiceWakeForwardError>
    typealias PublishTalk = @Sendable (Bool, String) async -> Void
    typealias Bootstrap = @Sendable () async throws -> GatewayConnection.RealtimeTalkBootstrap

    struct Environment: Sendable {
        let appStatePermissions: VoicePermissions
        let pttPermissions: VoicePermissions
        let wakePermissions: VoicePermissions
        let talkPermissions: VoicePermissions
        let talkAudioCapture: @MainActor @Sendable (@escaping State) -> any RealtimeTalkAudioCapturing
        let talkPCMPlayer: @MainActor @Sendable () -> any PCMStreamingAudioPlaying
        let talkSelectedSession: @MainActor @Sendable () -> String?
        let stopPCM: @MainActor @Sendable () async -> Double?
        let stopMP3: @MainActor @Sendable () async -> Double?
        let stopBuffered: @MainActor @Sendable () async -> Double?
        let stopSystem: @Sendable () async -> Void
        let stopMLX: @Sendable () async -> Void
        let talkBootstrap: Bootstrap
        let publishTalk: PublishTalk
        let forward: Forward
        let wakePresentation: VoiceWakeOverlayController.Presentation
        let talkPresentation: TalkOverlayController.Presentation
        let interruptRegistration: TalkSpeechInterruptMonitor.Registration

        static let live = Self(
            appStatePermissions: .live,
            pttPermissions: .live,
            wakePermissions: .live,
            talkPermissions: .live,
            talkAudioCapture: { state in
                MacRealtimeTalkAudioCapture(selectedInputUID: { state()?.voiceWakeMicID })
            },
            talkPCMPlayer: { RealtimePCMStreamingAudioPlayer() },
            talkSelectedSession: { WebChatManager.shared.activeSessionKey },
            stopPCM: { PCMStreamingAudioPlayer.shared.stop() },
            stopMP3: { StreamingAudioPlayer.shared.stop() },
            stopBuffered: { TalkBufferedAudioPlayer.shared.stop() },
            stopSystem: { await TalkSystemSpeechSynthesizer.shared.stop() },
            stopMLX: { await TalkMLXSpeechSynthesizer.shared.cancelCurrent() },
            talkBootstrap: AppVoiceRuntime.liveBootstrap,
            publishTalk: AppVoiceRuntime.livePublishTalk,
            forward: {
                await VoiceWakeForwarder.forwardToSelectedSession(transcript: $0, voiceWakeTrigger: $1)
            },
            wakePresentation: .live,
            talkPresentation: .live,
            interruptRegistration: .live)
    }

    private weak var state: AppState?
    let overlay: VoiceWakeOverlayController
    let sessions: VoiceSessionCoordinator
    let wake: VoiceWakeRuntime
    let ptt: VoicePushToTalk
    let hotkey: VoicePushToTalkHotkey
    let talkRuntime: TalkModeRuntime
    let talkOverlay: TalkOverlayController
    let interruptMonitor: TalkSpeechInterruptMonitor
    let talkController: TalkModeController
    private(set) var isActive = false

    init(state: AppState, environment: Environment) {
        self.state = state
        // Back-references are not evaluated until AppState has stored the complete graph.
        // Operation-local action values then retain their concrete cleanup owners.
        let stateProvider: State = { [weak state] in state }
        let controllerProvider: Controller = { [weak state] in state?.voiceRuntime.talkController }
        let overlay = VoiceWakeOverlayController(
            presentation: environment.wakePresentation,
            actions: { [weak state] in
                guard let state else { return nil }
                let sessions = state.voiceRuntime.sessions
                return .init(
                    send: { sessions.sendNow(token: $0, reason: $1) },
                    didPresent: { state.startVoiceEars() },
                    didDismiss: { token, outcome in
                        if outcome == .empty { state.blinkOnce() }
                        if outcome == .sent { state.celebrateSend() }
                        state.stopVoiceEars()
                        sessions.overlayDidDismiss(token: token)
                    })
            })
        let sessions = VoiceSessionCoordinator(
            overlay: overlay,
            forward: environment.forward,
            didDismiss: { [weak state] _ in
                guard let state else { return }
                let wake = state.voiceRuntime.wake
                Task { await wake.refresh(state: state) }
            })
        let wake = VoiceWakeRuntime(
            state: stateProvider,
            sessions: sessions,
            overlay: overlay,
            permissions: environment.wakePermissions,
            forward: environment.forward)
        let ptt = VoicePushToTalk(
            state: stateProvider, wake: wake, sessions: sessions, permissions: environment.pttPermissions)
        let hotkey = VoicePushToTalkHotkey(
            beginAction: { ptt.begin() }, endAction: { ptt.end(cancelled: $0) })
        let talkRuntime = TalkModeRuntime(
            realtimeTalkBootstrapProvider: environment.talkBootstrap,
            state: stateProvider,
            controller: controllerProvider,
            dependencies: .init(
                permissions: environment.talkPermissions,
                audioCapture: { environment.talkAudioCapture(stateProvider) },
                pcmPlayer: environment.talkPCMPlayer,
                selectedSession: environment.talkSelectedSession,
                stopPCM: environment.stopPCM,
                stopMP3: environment.stopMP3,
                stopBuffered: environment.stopBuffered,
                stopSystem: environment.stopSystem,
                stopMLX: environment.stopMLX))
        let talkOverlay = TalkOverlayController(
            state: stateProvider,
            presentation: environment.talkPresentation,
            actions: {
                guard let controller = controllerProvider() else { return nil }
                return .init(
                    togglePaused: { controller.togglePaused() },
                    stopSpeaking: { controller.stopSpeaking(reason: .userTap) },
                    pauseForDrag: { controller.setPaused(true) },
                    exit: { controller.exitTalkMode() })
            })
        let interruptMonitor = TalkSpeechInterruptMonitor(
            registration: environment.interruptRegistration, controller: controllerProvider)
        let owners = TalkModeController.Owners(
            runtime: talkRuntime,
            wake: wake,
            hotkey: hotkey,
            overlay: talkOverlay,
            interruptMonitor: interruptMonitor)
        self.overlay = overlay
        self.sessions = sessions
        self.wake = wake
        self.ptt = ptt
        self.hotkey = hotkey
        self.talkRuntime = talkRuntime
        self.talkOverlay = talkOverlay
        self.interruptMonitor = interruptMonitor
        self.talkController = TalkModeController(
            state: stateProvider, owners: { owners }, publishTalk: environment.publishTalk)
    }

    func activate() {
        guard self.state != nil else { return }
        self.isActive = true
    }

    nonisolated static func liveBootstrap() async throws -> GatewayConnection.RealtimeTalkBootstrap {
        try await GatewayConnection.shared.acquireRealtimeTalkBootstrap()
    }

    nonisolated static func livePublishTalk(_ enabled: Bool, _ phase: String) async {
        await GatewayConnection.shared.talkMode(enabled: enabled, phase: phase)
    }
}
