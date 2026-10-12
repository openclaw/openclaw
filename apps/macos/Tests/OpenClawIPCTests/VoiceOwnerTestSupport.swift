import AppKit
import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClaw
@testable import OpenClawKit

final class VoiceOwnerLog: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [String] = []
    private var sequences: [String: Int] = [:]

    @discardableResult
    func record(_ event: String) -> Int {
        self.lock.withLock {
            self.entries.append(event)
            self.sequences[event, default: 0] += 1
            return self.sequences[event, default: 0]
        }
    }

    func count(_ event: String) -> Int {
        self.lock.withLock { self.sequences[event, default: 0] }
    }

    func snapshot() -> [String] {
        self.lock.withLock { self.entries }
    }
}

/// Each instance belongs to one external boundary. Cancellation deliberately does
/// not acknowledge permission completion; no test treats this as a PTT task join.
actor VoiceOwnerGate<Value: Sendable> {
    private let value: Value
    private let name: String
    private let log: VoiceOwnerLog
    private var held = false
    private var pending: [Int: CheckedContinuation<Value, Never>] = [:]

    init(_ name: String, value: Value, log: VoiceOwnerLog) {
        self.name = name
        self.value = value
        self.log = log
    }

    func hold() {
        self.held = true
    }

    func request() async -> Value {
        let id = self.log.record("\(self.name).request")
        guard self.held else { return self.value }
        return await withCheckedContinuation { self.pending[id] = $0 }
    }

    func resolve(_ id: Int, returning value: Value) {
        self.pending.removeValue(forKey: id)?.resume(returning: value)
    }

    func releaseAll() {
        self.held = false
        let pending = self.pending
        self.pending.removeAll()
        for continuation in pending.values {
            continuation.resume(returning: self.value)
        }
    }
}

struct VoiceOwnerTimeout: Error {
    let operation: String
}

func waitForVoiceOwner(
    _ operation: String,
    until condition: @escaping @Sendable () async -> Bool) async throws
{
    try await AsyncTimeout.withTimeout(
        seconds: 2,
        onTimeout: { VoiceOwnerTimeout(operation: operation) },
        operation: {
            while await !condition() {
                try await Task.sleep(nanoseconds: 1_000_000)
            }
        })
}

@MainActor
final class VoiceOwnerCapture: RealtimeTalkAudioCapturing {
    let suppressesInputDuringOutput = false
    private let id: Int
    private let log: VoiceOwnerLog
    private var running = false

    init(log: VoiceOwnerLog) {
        self.log = log
        self.id = log.record("capture.make")
    }

    func start(
        targetSampleRate: Double,
        onAudio: @escaping @Sendable (RealtimeTalkAudioFrame) -> Void,
        onFailure: @escaping @MainActor (String) -> Void) throws
    {
        self.running = true
        self.log.record("capture.start:\(self.id)")
    }

    func stop() {
        guard self.running else { return }
        self.running = false
        self.log.record("capture.stop:\(self.id)")
    }
}

@MainActor
final class VoiceOwnerPlayer: PCMStreamingAudioPlaying {
    private let id: Int
    private let log: VoiceOwnerLog

    init(log: VoiceOwnerLog) {
        self.log = log
        self.id = log.record("player.make")
    }

    func play(
        stream: AsyncThrowingStream<Data, Error>,
        sampleRate: Double) async -> StreamingPlaybackResult
    {
        Issue.record("Voice owner fixture unexpectedly requested PCM playback")
        return StreamingPlaybackResult(finished: false, interruptedAt: nil)
    }

    func stop() -> Double? {
        self.log.record("player.stop:\(self.id)")
        return nil
    }
}

@MainActor
final class VoiceOwnerFixture {
    let log: VoiceOwnerLog
    let appPermission: VoiceOwnerGate<Bool>
    let talkPermission: VoiceOwnerGate<Bool>
    let pttPermission: VoiceOwnerGate<Bool>
    let bootstrap: VoiceOwnerGate<Void>
    let create: VoiceOwnerGate<Void>
    let shutdown: VoiceOwnerGate<Void>
    private var streams: [AsyncStream<EventFrame>.Continuation] = []
    private var dismissals: [UUID: @MainActor @Sendable (VoiceWakeOverlayController.DismissalCompletion) -> Void] = [:]
    var operations: [Task<Void, Never>] = []

    init() {
        let log = VoiceOwnerLog()
        self.log = log
        self.appPermission = VoiceOwnerGate("app.permission", value: true, log: log)
        self.talkPermission = VoiceOwnerGate("talk.permission", value: true, log: log)
        self.pttPermission = VoiceOwnerGate("ptt.permission", value: false, log: log)
        self.bootstrap = VoiceOwnerGate("bootstrap", value: (), log: log)
        self.create = VoiceOwnerGate("create", value: (), log: log)
        self.shutdown = VoiceOwnerGate("shutdown.buffered", value: (), log: log)
    }

    func environment(appPermissionGranted: Bool = true) -> AppVoiceRuntime.Environment {
        let log = self.log
        return .init(
            appStatePermissions: .init(
                supported: { true },
                granted: { appPermissionGranted },
                ensure: { [appPermission] _ in await appPermission.request() }),
            pttPermissions: .init(
                supported: { true },
                granted: { false },
                ensure: { [pttPermission] _ in await pttPermission.request() }),
            wakePermissions: .init(
                supported: { true },
                granted: { log.record("wake.permission")
                    return false
                },
                ensure: { _ in false }),
            talkPermissions: .init(
                supported: { true },
                granted: { true },
                ensure: { [talkPermission] _ in await talkPermission.request() }),
            talkAudioCapture: { _ in VoiceOwnerCapture(log: log) },
            talkPCMPlayer: { VoiceOwnerPlayer(log: log) },
            talkSelectedSession: { nil },
            stopPCM: { log.record("shutdown.pcm")
                return nil
            },
            stopMP3: { log.record("shutdown.mp3")
                return nil
            },
            stopBuffered: { [shutdown] in await shutdown.request()
                return nil
            },
            stopSystem: { log.record("shutdown.system") },
            stopMLX: { log.record("shutdown.mlx") },
            talkBootstrap: { [self] in await self.bootstrap.request()
                return try await self.makeBootstrap()
            },
            publishTalk: { log.record("publish:\($0):\($1)") },
            forward: { text, _ in log.record("forward:\(text)")
                return .success(())
            },
            wakePresentation: .init(
                present: { owner, first in if first { owner.actions()?.didPresent() } },
                updateFrame: { _, _ in },
                bringToFront: { _ in },
                animateDismiss: { [self] owner, _, _, completion in
                    guard let token = owner.activeToken else {
                        Issue.record("Dismissal without an overlay token")
                        return
                    }
                    log.record("overlay.request:\(token)")
                    self.dismissals[token] = completion
                }),
            talkPresentation: .init(
                present: { _, _ in log.record("talk.present") },
                animateDismiss: { _, completion in completion { log.record("talk.hidden") } }),
            interruptRegistration: .init(
                addGlobal: { _, _ in NSNumber(value: log.record("monitor.global")) },
                addLocal: { _, _ in NSNumber(value: -log.record("monitor.local")) },
                remove: { log.record("monitor.remove:\($0)") }))
    }

    private func makeBootstrap() throws -> GatewayConnection.RealtimeTalkBootstrap {
        let events = AsyncStream<EventFrame>.makeStream(bufferingPolicy: .bufferingNewest(8))
        self.streams.append(events.continuation)
        let log = self.log
        let create = self.create
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in events.stream },
            request: { method, params, _ in
                if method == "talk.session.create" {
                    let id = "relay-\(log.record("relay.create"))"
                    log.record("relay.created:\(id)")
                    await create.request()
                    events.continuation.yield(EventFrame(
                        type: "event",
                        event: "talk.event",
                        payload: AnyCodable(["relaySessionId": id, "type": "ready"]),
                        seq: nil,
                        stateversion: nil))
                    return try JSONEncoder().encode(TalkSessionCreateResult(
                        sessionid: "talk-session",
                        mode: AnyCodable("realtime"),
                        transport: AnyCodable("gateway-relay"),
                        brain: AnyCodable("agent-consult"),
                        relaysessionid: id))
                }
                if method == "talk.session.close" {
                    guard let id = params?["sessionId"]?.value as? String else {
                        throw VoiceOwnerTimeout(operation: "close missing relay identity")
                    }
                    log.record("relay.closed:\(id)")
                }
                return Data("{\"ok\":true}".utf8)
            },
            isCurrent: { true })
        let snapshot = ConfigSnapshot(
            path: nil,
            exists: true,
            raw: nil,
            hash: nil,
            parsed: nil,
            valid: true,
            config: [
                "session": AnyCodable(["mainKey": AnyCodable("main")]),
                "talk": AnyCodable(["realtime": AnyCodable([
                    "provider": AnyCodable("openai"),
                    "providers": AnyCodable(["openai": AnyCodable(["model": AnyCodable("gpt-realtime-2")])]),
                    "mode": AnyCodable("realtime"),
                    "transport": AnyCodable("gateway-relay"),
                    "brain": AnyCodable("agent-consult"),
                ])]),
            ], issues: nil)
        return .init(transport: transport, configSnapshot: snapshot, sessionKey: "main")
    }

    func completeDismissal(_ token: UUID) {
        self.dismissals.removeValue(forKey: token)?(.animated(finishWindow: { [log] in
            log.record("overlay.finished:\(token)")
        }))
    }

    @discardableResult
    func requestTalk(_ enabled: Bool, state: AppState) -> Task<Void, Never> {
        let task = Task { await state.setTalkEnabled(enabled) }
        self.operations.append(task)
        return task
    }

    func cleanup(state: AppState, menu: StatusMenuController) async throws {
        menu.stopVoiceObservation()
        self.requestTalk(false, state: state)
        await self.appPermission.releaseAll()
        await self.talkPermission.releaseAll()
        await self.bootstrap.releaseAll()
        await self.create.releaseAll()
        await self.shutdown.releaseAll()
        for task in self.operations {
            await task.value
        }
        state.swabbleEnabled = false
        await state.voiceRuntime.wake.refresh(state: state)
        for token in Array(self.dismissals.keys) {
            self.completeDismissal(token)
        }
        defer {
            for stream in self.streams {
                stream.finish()
            }
            self.streams.removeAll()
            self.operations.removeAll()
        }
        try await waitForVoiceOwner("all created relays closed") { [log] in
            let created = log.snapshot().filter { $0.hasPrefix("relay.created:") }
            return created
                .allSatisfy { log.count($0.replacingOccurrences(of: "relay.created:", with: "relay.closed:")) == 1 }
        }
    }
}

@MainActor
func withVoiceOwnerFixture(
    activate: Bool = true,
    appPermissionGranted: Bool = true,
    _ body: (VoiceOwnerFixture, AppState, StatusMenuController) async throws -> Void) async throws
{
    try await TestIsolation.withIsolatedState(
        env: ["OPENCLAW_CONFIG_PATH": TestIsolation.tempConfigPath()],
        defaults: [swabbleEnabledKey: false, talkEnabledKey: false, voicePushToTalkEnabledKey: false])
    {
        let fixture = VoiceOwnerFixture()
        let state = AppState(preview: true, voiceEnvironment: fixture.environment(
            appPermissionGranted: appPermissionGranted))
        state.voiceWakeLocaleID = "en-US"
        state.voiceWakeTriggerChime = .none
        state.voiceWakeSendChime = .none
        state.talkRealtimeRelayEnabled = true
        let menu = StatusMenuController(state: state, updater: DisabledUpdaterController())
        if activate {
            state.activateVoice()
            await fixture.requestTalk(false, state: state).value
        }
        do {
            try await body(fixture, state, menu)
        } catch {
            try await fixture.cleanup(state: state, menu: menu)
            throw error
        }
        try await fixture.cleanup(state: state, menu: menu)
    }
}
