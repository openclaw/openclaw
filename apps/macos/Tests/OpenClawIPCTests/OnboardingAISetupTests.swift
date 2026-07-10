import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

private actor ActivationMarkerObservation {
    private var observed = false

    func record(_ value: Bool) {
        self.observed = value
    }

    func value() -> Bool {
        self.observed
    }
}

private final class AISetupGatewayConfig: @unchecked Sendable {
    private let lock = NSLock()
    private let url: URL
    private var token: String
    private var switchTokenAfterReads: (remaining: Int, token: String)?

    init(url: URL, token: String) {
        self.url = url
        self.token = token
    }

    func setToken(_ token: String) {
        self.lock.lock()
        defer { self.lock.unlock() }
        self.token = token
        self.switchTokenAfterReads = nil
    }

    func switchToken(to token: String, afterReads: Int) {
        self.lock.lock()
        defer { self.lock.unlock() }
        self.switchTokenAfterReads = (remaining: afterReads, token: token)
    }

    func snapshot() -> GatewayConnection.Config {
        self.lock.lock()
        defer { self.lock.unlock() }
        if let pending = switchTokenAfterReads {
            if pending.remaining == 0 {
                self.token = pending.token
                self.switchTokenAfterReads = nil
            } else {
                self.switchTokenAfterReads = (
                    remaining: pending.remaining - 1,
                    token: pending.token)
            }
        }
        return (url: self.url, token: self.token, password: nil)
    }
}

private final class AISetupRouteIdentity: @unchecked Sendable {
    private let lock = NSLock()
    private var value: String

    init(_ value: String) {
        self.value = value
    }

    func set(_ value: String) {
        self.lock.lock()
        defer { self.lock.unlock() }
        self.value = value
    }

    func snapshot() -> String {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.value
    }
}

private actor AISetupRequestRecorder {
    private var methods: [String] = []
    private var apiKeys: [String] = []

    func record(_ message: URLSessionWebSocketTask.Message) {
        guard let request = aiSetupRequest(from: message) else { return }
        self.methods.append(request.method)
        if let apiKey = request.params["apiKey"] as? String {
            self.apiKeys.append(apiKey)
        }
    }

    func snapshot() -> (methods: [String], apiKeys: [String]) {
        (self.methods, self.apiKeys)
    }
}

private actor AISetupRequestGate {
    private var started = false
    private var released = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        self.started = true
        self.startWaiters.forEach { $0.resume() }
        self.startWaiters.removeAll()
        guard !self.released else { return }
        await withCheckedContinuation { continuation in
            self.releaseWaiters.append(continuation)
        }
    }

    func waitUntilStarted() async {
        guard !self.started else { return }
        await withCheckedContinuation { continuation in
            self.startWaiters.append(continuation)
        }
    }

    func release() {
        self.released = true
        self.releaseWaiters.forEach { $0.resume() }
        self.releaseWaiters.removeAll()
    }
}

private actor AISetupConfigReadGate {
    private let blockedRead: Int
    private var readCount = 0
    private var blocked = false
    private var released = false
    private var blockedWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    init(blockedRead: Int) {
        self.blockedRead = blockedRead
    }

    func snapshotToken() async -> String {
        self.readCount += 1
        if self.readCount == self.blockedRead {
            self.blocked = true
            self.blockedWaiters.forEach { $0.resume() }
            self.blockedWaiters.removeAll()
            if !self.released {
                await withCheckedContinuation { continuation in
                    self.releaseWaiters.append(continuation)
                }
            }
        }
        return "route-a"
    }

    func waitUntilBlocked() async {
        guard !self.blocked else { return }
        await withCheckedContinuation { continuation in
            self.blockedWaiters.append(continuation)
        }
    }

    func release() {
        self.released = true
        self.releaseWaiters.forEach { $0.resume() }
        self.releaseWaiters.removeAll()
    }
}

private func aiSetupRequest(
    from message: URLSessionWebSocketTask.Message) -> (id: String, method: String, params: [String: Any])?
{
    let data: Data? = switch message {
    case let .data(data): data
    case let .string(string): string.data(using: .utf8)
    @unknown default: nil
    }
    guard let data,
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let id = object["id"] as? String,
          let method = object["method"] as? String
    else { return nil }
    return (id: id, method: method, params: object["params"] as? [String: Any] ?? [:])
}

private func detectedSetupResponse(id: String) -> Data {
    Data(
        """
        {
          "type": "res",
          "id": "\(id)",
          "ok": true,
          "payload": {
            "candidates": [{
              "kind": "claude-cli",
              "label": "Claude Code",
              "detail": "installed",
              "modelRef": "claude-cli/claude-opus-4-8",
              "recommended": false,
              "credentials": false
            }],
            "manualProviders": [{
              "id": "openai-api-key",
              "label": "OpenAI API key",
              "hint": null
            }],
            "workspace": "/tmp/openclaw-workspace",
            "configuredModel": null,
            "setupComplete": false
          }
        }
        """.utf8)
}

private func actionableDetectedSetupResponse(id: String) -> Data {
    let response = String(decoding: detectedSetupResponse(id: id), as: UTF8.self)
        .replacingOccurrences(of: #""credentials": false"#, with: #""credentials": true"#)
    return Data(response.utf8)
}

private func missingConfiguredModelResponse(id: String) -> Data {
    Data(
        """
        {
          "type": "res",
          "id": "\(id)",
          "ok": true,
          "payload": {
            "defaultId": "main",
            "mainKey": "main",
            "scope": "per-sender",
            "agents": [{ "id": "main" }]
          }
        }
        """.utf8)
}

private func configuredModelResponse(id: String) -> Data {
    Data(
        """
        {
          "type": "res",
          "id": "\(id)",
          "ok": true,
          "payload": {
            "defaultId": "main",
            "mainKey": "main",
            "scope": "per-sender",
            "agents": [{
              "id": "main",
              "model": { "primary": "openai/gpt-5.5" }
            }]
          }
        }
        """.utf8)
}

private func waitForAISetupRequests(
    _ recorder: AISetupRequestRecorder,
    count: Int) async -> (methods: [String], apiKeys: [String])
{
    for _ in 0..<200 {
        let snapshot = await recorder.snapshot()
        if snapshot.methods.count >= count {
            return snapshot
        }
        try? await Task.sleep(nanoseconds: 5_000_000)
    }
    return await recorder.snapshot()
}

private func settleQueuedAISetupTasks() async {
    try? await Task.sleep(nanoseconds: 25_000_000)
}

private func makeAISetupSession(
    recorder: AISetupRequestRecorder,
    cancelActivationAfterSend: Bool = false) -> GatewayTestWebSocketSession
{
    GatewayTestWebSocketSession(taskFactory: {
        GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
            guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
            await recorder.record(message)
            switch request.method {
            case "crestodian.setup.detect":
                task.emitReceiveSuccess(.data(detectedSetupResponse(id: request.id)))
            case "crestodian.setup.activate":
                if cancelActivationAfterSend {
                    throw CancellationError()
                }
                task.emitReceiveSuccess(.data(failedActivationResponse(id: request.id)))
            default:
                break
            }
        })
    })
}

private func failedActivationResponse(id: String) -> Data {
    Data(
        """
        {
          "type": "res",
          "id": "\(id)",
          "ok": true,
          "payload": { "ok": false, "status": "auth", "error": "rejected" }
        }
        """.utf8)
}

private func verifiedSetupResponse(id: String) -> Data {
    Data(
        """
        {
          "type": "res",
          "id": "\(id)",
          "ok": true,
          "payload": { "ok": true, "modelRef": "openai/gpt-5.5", "latencyMs": 42 }
        }
        """.utf8)
}

private func rejectedSetupVerificationResponse(id: String) -> Data {
    Data(
        """
        {
          "type": "res",
          "id": "\(id)",
          "ok": true,
          "payload": { "ok": false, "status": "auth", "error": "expired login" }
        }
        """.utf8)
}

private func unavailableGatewayResponse(id: String) -> Data {
    Data(
        """
        {
          "type": "res",
          "id": "\(id)",
          "ok": false,
          "error": { "code": "UNAVAILABLE", "message": "temporary failure" }
        }
        """.utf8)
}

@Suite(.serialized)
@MainActor
struct OnboardingAISetupTests {
    @Test func `candidate failure keeps friendly summary and exact detail`() {
        let failure = OnboardingAISetupModel.failure(
            label: "Codex CLI",
            status: "auth",
            error: "Codex login expired (request 42)")

        #expect(failure.summary == "Codex CLI is installed, but the login didn’t work. Sign in again, then retry.")
        #expect(failure.detail == "Codex login expired (request 42)")
        #expect(failure.copyText == "Codex login expired (request 42)")
    }

    @Test func `candidate failure omits empty detail`() {
        let failure = OnboardingAISetupModel.failure(
            label: "Codex CLI",
            status: "timeout",
            error: "  ")

        #expect(failure.summary == "Codex CLI didn’t answer in time.")
        #expect(failure.detail == nil)
        #expect(failure.copyText == failure.summary)
    }

    @Test func `transport failure preserves original detail`() {
        let failure = OnboardingAISetupModel.transportFailure(
            "Gateway request failed: connection reset")

        #expect(failure.summary == "Gateway request failed: connection reset")
        #expect(failure.detail == "Gateway request failed: connection reset")
    }

    @Test func `codex activation covers install probe and finalization`() {
        #expect(OnboardingAISetupModel.activationRequestTimeoutMs(for: "codex-cli") == 480_000)
        #expect(OnboardingAISetupModel.activationRequestTimeoutMs(for: "claude-cli") == 150_000)
        #expect(OnboardingAISetupModel.activationRequestTimeoutMs(for: "codex-cli") >= (305 + 90) * 1000)
    }

    @Test func `only definitive failures can clear an activation marker`() {
        let responseError = GatewayResponseError(
            method: "crestodian.setup.activate",
            code: "UNKNOWN_METHOD",
            message: "unknown method",
            details: nil)
        let timeout = NSError(
            domain: "Gateway",
            code: 5,
            userInfo: [NSLocalizedDescriptionKey: "gateway request timed out"])
        let decodeError = DecodingError.dataCorrupted(.init(
            codingPath: [],
            debugDescription: "invalid activation response"))

        #expect(OnboardingAISetupModel.activationFailureIsDefinitive(responseError))
        #expect(!OnboardingAISetupModel.activationFailureIsDefinitive(decodeError))
        #expect(!OnboardingAISetupModel.activationFailureIsDefinitive(timeout))
        #expect(!OnboardingAISetupModel.activationFailureIsDefinitive(CancellationError()))
    }

    @Test func `successful activation response completes lease and hands off immediately`() async throws {
        let suiteName = "OnboardingCompletedActivationTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0, let request = aiSetupRequest(from: message),
                      request.method == "crestodian.setup.activate"
                else { return }
                task.emitReceiveSuccess(.data(verifiedSetupResponse(id: request.id)))
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
        let model = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { "local" })
        var handedOff = false
        model.onConnected = { handedOff = true }

        await model.activate(kind: "claude-cli")

        #expect(model.connected)
        #expect(handedOff)
        #expect(OnboardingCrestodianResumeStore.pendingState(
            for: "local",
            defaults: defaults) == .completed)
    }

    @Test func `reset during final route validation rejects stale activation handoff`() async throws {
        let suiteName = "OnboardingFinalRouteValidationResetTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let configGate = AISetupConfigReadGate(blockedRead: 4)
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0,
                      let request = aiSetupRequest(from: message),
                      request.method == "crestodian.setup.activate"
                else { return }
                task.emitReceiveSuccess(.data(verifiedSetupResponse(id: request.id)))
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: {
                let token = await configGate.snapshotToken()
                return (url: url, token: token, password: nil)
            },
            sessionBox: WebSocketSessionBox(session: session))
        let model = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { "local" })
        var handoffCount = 0
        model.onConnected = { handoffCount += 1 }

        let activation = Task { await model.activate(kind: "codex-cli") }
        await configGate.waitUntilBlocked()
        model.resetForGatewayChange(clearPendingHandoff: false)
        await configGate.release()
        await activation.value

        #expect(!model.connected)
        #expect(model.phase == .idle)
        #expect(handoffCount == 0)
        #expect(OnboardingCrestodianResumeStore.isPending(
            for: "local",
            defaults: defaults))
    }

    @Test func `gateway change clears route-bound setup state`() {
        let model = OnboardingAISetupModel()
        model.manualProviderID = "openai"
        model.manualKey = "temporary-key"
        model.showManualEntry = true

        model.resetForGatewayChange()

        #expect(model.phase == .idle)
        #expect(model.connectedModelRef == nil)
        #expect(model.connectedLatencyMs == nil)
        #expect(model.manualProviderID.isEmpty)
        #expect(model.manualKey.isEmpty)
        #expect(!model.showManualEntry)
    }

    @Test func `configured gateway result is accepted only for the visible selected route`() {
        #expect(OnboardingView.shouldOpenConfiguredGatewayDashboard(
            onboardingVisible: true,
            expectedMode: .remote,
            currentMode: .remote,
            crestodianResumePending: false,
            setupOwnsInferenceTransition: false))
        #expect(!OnboardingView.shouldOpenConfiguredGatewayDashboard(
            onboardingVisible: false,
            expectedMode: .remote,
            currentMode: .remote,
            crestodianResumePending: false,
            setupOwnsInferenceTransition: false))
        #expect(!OnboardingView.shouldOpenConfiguredGatewayDashboard(
            onboardingVisible: true,
            expectedMode: .remote,
            currentMode: .local,
            crestodianResumePending: false,
            setupOwnsInferenceTransition: false))
        #expect(!OnboardingView.shouldOpenConfiguredGatewayDashboard(
            onboardingVisible: true,
            expectedMode: .unconfigured,
            currentMode: .unconfigured,
            crestodianResumePending: false,
            setupOwnsInferenceTransition: false))
    }

    @Test func `fresh inference transition owns the Crestodian handoff`() {
        #expect(!OnboardingView.shouldOpenConfiguredGatewayDashboard(
            onboardingVisible: true,
            expectedMode: .local,
            currentMode: .local,
            crestodianResumePending: false,
            setupOwnsInferenceTransition: true))
    }

    @Test func `pending Crestodian handoff cannot be mistaken for an existing install`() {
        #expect(!OnboardingView.shouldOpenConfiguredGatewayDashboard(
            onboardingVisible: true,
            expectedMode: .local,
            currentMode: .local,
            crestodianResumePending: true,
            setupOwnsInferenceTransition: false))
    }

    @Test func `configured model label stays pending until live verification`() async {
        let model = OnboardingAISetupModel()

        model.resumeConfiguredInference(modelRef: " openai/gpt-5.5 ")

        #expect(!model.connected)
        #expect(model.pendingActivationVerification)
        #expect(model.phase == .detecting)
        #expect(model.connectedModelRef == nil)

        await model.activate(kind: "codex-cli")
        #expect(model.pendingActivationVerification)
        #expect(!model.connected)

        model.acceptVerifiedPendingInference(modelRef: "openai/gpt-5.5")

        #expect(model.connected)
        #expect(!model.pendingActivationVerification)
        #expect(model.connectedModelRef == "openai/gpt-5.5")
        #expect(model.selectedKind == "existing-model")
        #expect(model.statuses["existing-model"] == .connected)
    }

    @Test func `pending handoff connects only after route-bound live verification`() async throws {
        let recorder = AISetupRequestRecorder()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
                await recorder.record(message)
                if request.method == "crestodian.setup.verify" {
                    task.emitReceiveSuccess(.data(verifiedSetupResponse(id: request.id)))
                }
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
        let model = OnboardingAISetupModel(
            gateway: gateway,
            routeIdentityProvider: { "local" })

        model.resumeConfiguredInference(modelRef: "openai/gpt-5.5")
        await model.verifyPendingConfiguredInference()

        let requests = await recorder.snapshot()
        #expect(requests.methods == ["crestodian.setup.verify"])
        #expect(model.connected)
        #expect(model.connectedModelRef == "openai/gpt-5.5")
        #expect(model.connectedLatencyMs == 42)
    }

    @Test func `overlapping pending verification callers share one route-bound request`() async throws {
        let recorder = AISetupRequestRecorder()
        let gate = AISetupRequestGate()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
                await recorder.record(message)
                guard request.method == "crestodian.setup.verify" else { return }
                await gate.wait()
                task.emitReceiveSuccess(.data(verifiedSetupResponse(id: request.id)))
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
        let model = OnboardingAISetupModel(
            gateway: gateway,
            routeIdentityProvider: { "local" })
        model.resumeConfiguredInference(modelRef: "openai/gpt-5.5")

        let first = Task { await model.verifyPendingConfiguredInference() }
        await gate.waitUntilStarted()
        let second = Task { await model.verifyPendingConfiguredInference() }
        await Task.yield()

        #expect(await (recorder.snapshot()).methods == ["crestodian.setup.verify"])
        await gate.release()
        #expect(await first.value == .connected)
        #expect(await second.value == .connected)
        #expect(await (recorder.snapshot()).methods == ["crestodian.setup.verify"])
    }

    @Test func `pending verification revalidates route after shared task completes`() async throws {
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0, let request = aiSetupRequest(from: message),
                      request.method == "crestodian.setup.verify"
                else { return }
                task.emitReceiveSuccess(.data(verifiedSetupResponse(id: request.id)))
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
        let routeIdentity = AISetupRouteIdentity("remote:id:gateway-a")
        let model = OnboardingAISetupModel(
            gateway: gateway,
            routeIdentityProvider: { routeIdentity.snapshot() })
        model.onConnected = { routeIdentity.set("remote:id:gateway-b") }

        model.resumeConfiguredInference(modelRef: "openai/gpt-5.5")
        let outcome = await model.verifyPendingConfiguredInference()

        #expect(outcome == .superseded)
    }

    @Test func `disappearing onboarding invalidates detection before activation`() async throws {
        let recorder = AISetupRequestRecorder()
        let gate = AISetupRequestGate()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
                await recorder.record(message)
                switch request.method {
                case "crestodian.setup.detect":
                    await gate.wait()
                    task.emitReceiveSuccess(.data(actionableDetectedSetupResponse(id: request.id)))
                case "crestodian.setup.activate":
                    task.emitReceiveSuccess(.data(failedActivationResponse(id: request.id)))
                default:
                    break
                }
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
        let appState = AppState(preview: true)
        appState.connectionMode = .remote
        appState.remoteTransport = .direct
        appState.remoteUrl = "ws://example.invalid"
        let view = OnboardingView(state: appState, aiSetupGateway: gateway)
        view.onboardingVisible = true

        view.aiSetup.startIfNeeded()
        await gate.waitUntilStarted()
        view.onboardingDidDisappear()
        await gate.release()
        await settleQueuedAISetupTasks()

        #expect(await (recorder.snapshot()).methods == ["crestodian.setup.detect"])
        #expect(view.aiSetup.phase == .idle)
    }

    @Test func `failed pending verification keeps activation lease before deadline`() async throws {
        let suiteName = "OnboardingPendingVerificationFailureTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        OnboardingCrestodianResumeStore.markPending(routeIdentity: "local", defaults: defaults)
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0, let request = aiSetupRequest(from: message),
                      request.method == "crestodian.setup.verify"
                else { return }
                task.emitReceiveSuccess(.data(rejectedSetupVerificationResponse(id: request.id)))
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
        let model = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { "local" })

        model.resumeConfiguredInference(modelRef: "openai/gpt-5.5")
        let outcome = await model.verifyPendingConfiguredInference()

        #expect(!model.connected)
        #expect(model.pendingActivationVerification)
        #expect(model.detectError?.detail == "expired login")
        #expect(outcome == .notConnected)
        #expect(OnboardingCrestodianResumeStore.isPending(for: "local", defaults: defaults))
    }

    @Test func `pending Crestodian marker is app local and clearable`() throws {
        let suiteName = "OnboardingCrestodianResumeStoreTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        #expect(!OnboardingCrestodianResumeStore.isPending(for: "local", defaults: defaults))
        OnboardingCrestodianResumeStore.markPending(routeIdentity: "local", defaults: defaults)
        #expect(OnboardingCrestodianResumeStore.isPending(for: "local", defaults: defaults))
        OnboardingCrestodianResumeStore.clear(defaults: defaults)
        #expect(!OnboardingCrestodianResumeStore.isPending(for: "local", defaults: defaults))
    }

    @Test func `legacy marker relaunch migrates to a full conservative lease`() throws {
        let suiteName = "OnboardingLegacyCrestodianResumeStoreTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        defaults.set("local", forKey: onboardingCrestodianPendingKey)

        let migrated = OnboardingCrestodianResumeStore.pendingState(
            for: "local",
            defaults: defaults,
            now: now)
        let deadline: Date? = if case let .activating(deadline) = migrated {
            deadline
        } else {
            nil
        }
        let leaseDeadline = try #require(deadline)

        #expect(leaseDeadline == now.addingTimeInterval(
            OnboardingCrestodianResumeStore.legacyActivationLeaseSeconds))
        #expect(defaults.object(forKey: onboardingCrestodianPendingKey) is [String: Any])
        #expect(OnboardingCrestodianResumeStore.pendingState(
            for: "local",
            defaults: defaults,
            now: now.addingTimeInterval(484)) == .activating(deadline: leaseDeadline))
        #expect(OnboardingCrestodianResumeStore.pendingState(
            for: "local",
            defaults: defaults,
            now: now.addingTimeInterval(486)) == .activationExpired)
    }

    @Test func `missing model cannot start a second activation before pending deadline`() async throws {
        let suiteName = "OnboardingPendingDeadlineBlockTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let url = try #require(URL(string: "ws://localhost:18789"))
        let appState = AppState(preview: true)
        appState.connectionMode = .local
        let routeIdentity = OnboardingCrestodianResumeStore.selectedRouteIdentity(state: appState)
        OnboardingCrestodianResumeStore.markPending(
            routeIdentity: routeIdentity,
            activationTimeoutMs: 30000,
            defaults: defaults)
        let recorder = AISetupRequestRecorder()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
                await recorder.record(message)
                if request.method == "agents.list" {
                    task.emitReceiveSuccess(.data(missingConfiguredModelResponse(id: request.id)))
                }
            })
        })
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
        let view = OnboardingView(
            state: appState,
            aiSetupGateway: gateway,
            crestodianDefaults: defaults)

        let initialProbe = try #require(view.onboardingDidAppear())
        await initialProbe.value
        await settleQueuedAISetupTasks()

        #expect(await (recorder.snapshot()).methods == ["agents.list"])
        #expect(view.aiSetup.waitingForPendingActivationDeadline)
        #expect(OnboardingCrestodianResumeStore.isPending(
            for: routeIdentity,
            defaults: defaults))
        view.onboardingDidDisappear()
    }

    @Test func `expired pending activation safely permits a fresh activation`() async throws {
        let suiteName = "OnboardingExpiredPendingActivationTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let url = try #require(URL(string: "ws://localhost:18789"))
        let appState = AppState(preview: true)
        appState.connectionMode = .local
        let routeIdentity = OnboardingCrestodianResumeStore.selectedRouteIdentity(state: appState)
        OnboardingCrestodianResumeStore.markPending(
            routeIdentity: routeIdentity,
            activationTimeoutMs: 0,
            defaults: defaults,
            now: Date(timeIntervalSinceNow: -10))
        let recorder = AISetupRequestRecorder()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
                await recorder.record(message)
                switch request.method {
                case "agents.list":
                    task.emitReceiveSuccess(.data(missingConfiguredModelResponse(id: request.id)))
                case "crestodian.setup.detect":
                    task.emitReceiveSuccess(.data(actionableDetectedSetupResponse(id: request.id)))
                case "crestodian.setup.activate":
                    task.emitReceiveSuccess(.data(failedActivationResponse(id: request.id)))
                default:
                    break
                }
            })
        })
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
        let view = OnboardingView(
            state: appState,
            aiSetupGateway: gateway,
            crestodianDefaults: defaults)

        let initialProbe = try #require(view.onboardingDidAppear())
        await initialProbe.value
        let requests = await waitForAISetupRequests(recorder, count: 3)

        #expect(requests.methods == [
            "agents.list",
            "crestodian.setup.detect",
            "crestodian.setup.activate",
        ])
        #expect(!view.aiSetup.waitingForPendingActivationDeadline)
        view.onboardingDidDisappear()
    }

    @Test func `stale missing probe cannot reset inference connected while suspended`() async throws {
        let suiteName = "OnboardingStaleMissingConnectedTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        OnboardingCrestodianResumeStore.markPending(
            routeIdentity: "local",
            defaults: defaults)
        OnboardingCrestodianResumeStore.markCompleted(
            ifOwnedBy: "local",
            defaults: defaults)
        let recorder = AISetupRequestRecorder()
        let gate = AISetupRequestGate()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
                await recorder.record(message)
                switch request.method {
                case "agents.list":
                    await gate.wait()
                    task.emitReceiveSuccess(.data(missingConfiguredModelResponse(id: request.id)))
                case "crestodian.setup.detect":
                    task.emitReceiveSuccess(.data(detectedSetupResponse(id: request.id)))
                default:
                    break
                }
            })
        })
        let url = try #require(URL(string: "ws://localhost:18789"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
        let appState = AppState(preview: true)
        appState.connectionMode = .local
        let view = OnboardingView(
            state: appState,
            aiSetupGateway: gateway,
            crestodianDefaults: defaults)

        let staleProbe = try #require(view.probeConfiguredGatewayForDashboard(
            startAISetupWhenMissing: true,
            knownVisible: true,
            knownAISetupPage: true))
        await gate.waitUntilStarted()
        view.aiSetup.resumeConfiguredInference(modelRef: "openai/gpt-5.5")
        view.aiSetup.acceptVerifiedPendingInference(modelRef: "openai/gpt-5.5")
        #expect(view.aiSetup.connected)
        await gate.release()
        await staleProbe.value
        await settleQueuedAISetupTasks()

        #expect(view.aiSetup.connected)
        #expect(OnboardingCrestodianResumeStore.pendingState(
            for: "local",
            defaults: defaults) == .completed)
        #expect(await (recorder.snapshot()).methods == ["agents.list"])
    }

    @Test func `unavailable configured gateway timeout does not start inference setup`() async throws {
        let suiteName = "OnboardingUnavailableGatewayTimeoutTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let recorder = AISetupRequestRecorder()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { _, message, sendIndex in
                guard sendIndex > 0 else { return }
                await recorder.record(message)
            })
        })
        let url = try #require(URL(string: "ws://localhost:18789"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
        let appState = AppState(preview: true)
        appState.connectionMode = .local
        let view = OnboardingView(
            state: appState,
            aiSetupGateway: gateway,
            crestodianDefaults: defaults,
            configuredGatewayProbeTimeoutMs: 1)
        view.onboardingVisible = true
        view.currentPage = try #require(view.pageOrder.firstIndex(of: view.aiPageIndex))

        let probe = try #require(view.probeConfiguredGatewayForDashboard(
            startAISetupWhenMissing: true,
            knownVisible: true))
        await probe.value
        await settleQueuedAISetupTasks()

        #expect(await (recorder.snapshot()).methods == ["agents.list"])
        #expect(view.aiSetup.phase == .ready)
        #expect(view.aiSetup.configuredGatewayProbeUnavailable)
        #expect(view.aiSetup.detectError != nil)
        #expect(!OnboardingCrestodianResumeStore.isPending(for: "local", defaults: defaults))
    }

    @Test func `read only configured gateway retry does not own inference transition`() {
        let model = OnboardingAISetupModel(routeIdentityProvider: { "local" })

        model.showConfiguredGatewayProbeUnavailable()
        model.beginConfiguredGatewayProbeRetry()

        #expect(model.phase == .detecting)
        #expect(model.configuredGatewayProbeUnavailable)
        #expect(!model.ownsInferenceTransition)
    }

    @Test func `temporary remote connection check cannot start configured gateway probe`() {
        let state = AppState(preview: true)
        state.connectionMode = .unconfigured
        let view = OnboardingView(state: state)
        view.configuredGatewayProbe.beginTemporaryConnectionCheck()
        defer { view.configuredGatewayProbe.endTemporaryConnectionCheck() }
        state.connectionMode = .remote

        let probe = view.probeConfiguredGatewayForDashboard(knownVisible: true)

        #expect(probe == nil)
    }

    @Test func `unavailable gateway error preserves expired and completed markers`() async throws {
        for markerPhase in ["expired", "completed"] {
            let suiteName = "OnboardingUnavailableGatewayMarkerTests-\(markerPhase)-\(UUID().uuidString)"
            let defaults = try #require(UserDefaults(suiteName: suiteName))
            defer { defaults.removePersistentDomain(forName: suiteName) }
            OnboardingCrestodianResumeStore.markPending(
                routeIdentity: "local",
                activationTimeoutMs: markerPhase == "expired" ? 0 : 30000,
                defaults: defaults,
                now: markerPhase == "expired" ? Date(timeIntervalSinceNow: -10) : Date())
            if markerPhase == "completed" {
                OnboardingCrestodianResumeStore.markCompleted(
                    ifOwnedBy: "local",
                    defaults: defaults)
            }
            let recorder = AISetupRequestRecorder()
            let session = GatewayTestWebSocketSession(taskFactory: {
                GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                    guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
                    await recorder.record(message)
                    task.emitReceiveSuccess(.data(unavailableGatewayResponse(id: request.id)))
                })
            })
            let url = try #require(URL(string: "ws://localhost:18789"))
            let gateway = GatewayConnection(
                configProvider: { (url: url, token: nil, password: nil) },
                sessionBox: WebSocketSessionBox(session: session))
            let appState = AppState(preview: true)
            appState.connectionMode = .local
            let view = OnboardingView(
                state: appState,
                aiSetupGateway: gateway,
                crestodianDefaults: defaults)
            view.onboardingVisible = true
            view.currentPage = try #require(view.pageOrder.firstIndex(of: view.aiPageIndex))

            let probe = try #require(view.probeConfiguredGatewayForDashboard(
                startAISetupWhenMissing: true,
                knownVisible: true))
            await probe.value
            await settleQueuedAISetupTasks()

            #expect(await (recorder.snapshot()).methods == ["agents.list"])
            #expect(view.aiSetup.phase == .ready)
            #expect(view.aiSetup.configuredGatewayProbeUnavailable)
            let pendingState = OnboardingCrestodianResumeStore.pendingState(
                for: "local",
                defaults: defaults)
            if markerPhase == "expired" {
                #expect(pendingState == .activationExpired)
            } else {
                #expect(pendingState == .completed)
            }

            let retry = try #require(view.retryConfiguredGatewayProbe())
            await retry.value
            let retried = await recorder.snapshot()
            await settleQueuedAISetupTasks()

            #expect(retried.methods == ["agents.list", "agents.list"])
            #expect(view.aiSetup.phase == .ready)
            #expect(view.aiSetup.configuredGatewayProbeUnavailable)
            #expect(OnboardingCrestodianResumeStore.pendingState(
                for: "local",
                defaults: defaults) == pendingState)
        }
    }

    @Test func `unavailable probe resets stale ready setup before successful missing retry`() async throws {
        let suiteName = "OnboardingUnavailableReadyRetryTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let recorder = AISetupRequestRecorder()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
                await recorder.record(message)
                switch request.method {
                case "crestodian.setup.detect":
                    task.emitReceiveSuccess(.data(detectedSetupResponse(id: request.id)))
                case "agents.list":
                    let probeCount = await recorder.snapshot().methods.filter { $0 == "agents.list" }.count
                    let response = probeCount == 1
                        ? unavailableGatewayResponse(id: request.id)
                        : missingConfiguredModelResponse(id: request.id)
                    task.emitReceiveSuccess(.data(response))
                default:
                    break
                }
            })
        })
        let url = try #require(URL(string: "ws://localhost:18789"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
        let appState = AppState(preview: true)
        appState.connectionMode = .local
        let view = OnboardingView(
            state: appState,
            aiSetupGateway: gateway,
            crestodianDefaults: defaults)
        view.onboardingVisible = true
        view.currentPage = try #require(view.pageOrder.firstIndex(of: view.aiPageIndex))

        await view.aiSetup.detectAndAutoConnect()
        #expect(view.aiSetup.phase == .ready)
        #expect(!view.aiSetup.candidates.isEmpty)

        let unavailableProbe = try #require(view.probeConfiguredGatewayForDashboard(
            startAISetupWhenMissing: true,
            knownVisible: true))
        await unavailableProbe.value
        #expect(view.aiSetup.configuredGatewayProbeUnavailable)
        #expect(view.aiSetup.candidates.isEmpty)

        let retry = try #require(view.retryConfiguredGatewayProbe())
        await retry.value
        let requests = await waitForAISetupRequests(recorder, count: 4)

        #expect(requests.methods == [
            "crestodian.setup.detect",
            "agents.list",
            "agents.list",
            "crestodian.setup.detect",
        ])
        #expect(view.aiSetup.phase == .ready)
        #expect(!view.aiSetup.configuredGatewayProbeUnavailable)
        #expect(!view.aiSetup.candidates.isEmpty)
    }

    @Test func `unavailable retry cannot mutate while activation lease is active`() async throws {
        let suiteName = "OnboardingUnavailableActiveLeaseRetryTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        OnboardingCrestodianResumeStore.markPending(
            routeIdentity: "local",
            activationTimeoutMs: 30000,
            defaults: defaults)
        let recorder = AISetupRequestRecorder()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
                await recorder.record(message)
                let probeCount = await recorder.snapshot().methods.filter { $0 == "agents.list" }.count
                let response = probeCount == 1
                    ? unavailableGatewayResponse(id: request.id)
                    : missingConfiguredModelResponse(id: request.id)
                task.emitReceiveSuccess(.data(response))
            })
        })
        let url = try #require(URL(string: "ws://localhost:18789"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
        let appState = AppState(preview: true)
        appState.connectionMode = .local
        let view = OnboardingView(
            state: appState,
            aiSetupGateway: gateway,
            crestodianDefaults: defaults)

        let unavailableProbe = try #require(view.probeConfiguredGatewayForDashboard(
            startAISetupWhenMissing: true,
            knownVisible: true,
            knownAISetupPage: true))
        await unavailableProbe.value
        #expect(view.aiSetup.configuredGatewayProbeUnavailable)

        let retry = try #require(view.retryConfiguredGatewayProbe())
        await retry.value
        await settleQueuedAISetupTasks()

        #expect(await (recorder.snapshot()).methods == ["agents.list", "agents.list"])
        #expect(view.aiSetup.waitingForPendingActivationDeadline)
        #expect(OnboardingCrestodianResumeStore.isPending(for: "local", defaults: defaults))
    }

    @Test func `verified configured model stays read only until pending deadline`() async throws {
        let suiteName = "OnboardingPendingConfiguredVerificationTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let url = try #require(URL(string: "ws://localhost:18789"))
        let appState = AppState(preview: true)
        appState.connectionMode = .local
        OnboardingCrestodianResumeStore.markPending(
            routeIdentity: "local",
            activationTimeoutMs: 30000,
            defaults: defaults)
        let recorder = AISetupRequestRecorder()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0, let request = aiSetupRequest(from: message) else { return }
                await recorder.record(message)
                switch request.method {
                case "agents.list":
                    let agentsListCount = await recorder.snapshot().methods.filter {
                        $0 == "agents.list"
                    }.count
                    let response = agentsListCount == 1
                        ? missingConfiguredModelResponse(id: request.id)
                        : configuredModelResponse(id: request.id)
                    task.emitReceiveSuccess(.data(response))
                case "crestodian.setup.verify":
                    task.emitReceiveSuccess(.data(verifiedSetupResponse(id: request.id)))
                default:
                    break
                }
            })
        })
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
        let view = OnboardingView(
            state: appState,
            aiSetupGateway: gateway,
            crestodianDefaults: defaults)

        let initialProbe = try #require(view.onboardingDidAppear())
        await initialProbe.value
        #expect(view.aiSetup.waitingForPendingActivationDeadline)
        let configuredProbe = try #require(
            view.probeConfiguredGatewayForDashboard(knownVisible: true))
        await configuredProbe.value
        for _ in 0..<200 {
            if case .verified = OnboardingCrestodianResumeStore.pendingState(
                for: "local",
                defaults: defaults)
            {
                break
            }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }

        let methods = await recorder.snapshot().methods
        #expect(Array(methods.prefix(3)) == [
            "agents.list",
            "agents.list",
            "crestodian.setup.verify",
        ])
        #expect(!methods.contains("crestodian.setup.detect"))
        #expect(!methods.contains("crestodian.setup.activate"))
        #expect(!view.aiSetup.connected)
        #expect(view.aiSetup.waitingForPendingActivationDeadline)
        #expect({
            if case .verified = OnboardingCrestodianResumeStore.pendingState(
                for: "local",
                defaults: defaults)
            {
                return true
            }
            return false
        }())
        view.onboardingDidDisappear()
    }

    @Test func `verified route hands off after activation deadline`() async throws {
        let suiteName = "OnboardingVerifiedExpiredActivationTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        OnboardingCrestodianResumeStore.markPending(
            routeIdentity: "local",
            activationTimeoutMs: 0,
            defaults: defaults,
            now: Date(timeIntervalSinceNow: -10))
        OnboardingCrestodianResumeStore.markVerified(
            ifOwnedBy: "local",
            defaults: defaults)
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0, let request = aiSetupRequest(from: message),
                      request.method == "crestodian.setup.verify"
                else { return }
                task.emitReceiveSuccess(.data(verifiedSetupResponse(id: request.id)))
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
        let model = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { "local" })
        var handedOff = false
        model.onConnected = { handedOff = true }

        model.resumeConfiguredInference(modelRef: "openai/gpt-5.5")
        let outcome = await model.verifyPendingConfiguredInference()

        #expect(outcome == .connected)
        #expect(model.connected)
        #expect(handedOff)
        #expect(OnboardingCrestodianResumeStore.pendingState(
            for: "local",
            defaults: defaults) == .completed)
    }

    @Test func `pending marker for another route is preserved`() throws {
        let suiteName = "OnboardingCrestodianRouteMismatchTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        OnboardingCrestodianResumeStore.markPending(
            routeIdentity: "remote:id:gateway-a",
            defaults: defaults)

        #expect(!OnboardingCrestodianResumeStore.isPending(
            for: "remote:id:gateway-b",
            defaults: defaults))
        #expect(OnboardingCrestodianResumeStore.isPending(
            for: "remote:id:gateway-a",
            defaults: defaults))
    }

    @Test func `A to B to A preserves first activation lease`() throws {
        let suiteName = "OnboardingCrestodianMultiRouteTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let now = Date(timeIntervalSince1970: 1_800_000_000)

        OnboardingCrestodianResumeStore.markPending(
            routeIdentity: "remote:id:gateway-a",
            defaults: defaults,
            now: now)
        OnboardingCrestodianResumeStore.markPending(
            routeIdentity: "remote:id:gateway-b",
            defaults: defaults,
            now: now.addingTimeInterval(1))

        #expect(OnboardingCrestodianResumeStore.isPending(
            for: "remote:id:gateway-a",
            defaults: defaults,
            now: now.addingTimeInterval(2)))
        #expect(OnboardingCrestodianResumeStore.isPending(
            for: "remote:id:gateway-b",
            defaults: defaults,
            now: now.addingTimeInterval(2)))

        OnboardingCrestodianResumeStore.clear(
            ifOwnedBy: "remote:id:gateway-b",
            defaults: defaults)
        #expect(OnboardingCrestodianResumeStore.isPending(
            for: "remote:id:gateway-a",
            defaults: defaults,
            now: now.addingTimeInterval(2)))
        #expect(!OnboardingCrestodianResumeStore.isPending(
            for: "remote:id:gateway-b",
            defaults: defaults,
            now: now.addingTimeInterval(2)))
    }

    @Test func `route reset clears only current route lease`() throws {
        let suiteName = "OnboardingCrestodianRouteResetTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let routeIdentity = AISetupRouteIdentity("remote:id:gateway-b")
        OnboardingCrestodianResumeStore.markPending(
            routeIdentity: "remote:id:gateway-a",
            defaults: defaults)
        OnboardingCrestodianResumeStore.markPending(
            routeIdentity: "remote:id:gateway-b",
            defaults: defaults)
        let model = OnboardingAISetupModel(
            defaults: defaults,
            routeIdentityProvider: { routeIdentity.snapshot() })

        model.resetForGatewayChange()

        #expect(OnboardingCrestodianResumeStore.isPending(
            for: "remote:id:gateway-a",
            defaults: defaults))
        #expect(!OnboardingCrestodianResumeStore.isPending(
            for: "remote:id:gateway-b",
            defaults: defaults))
    }

    @Test func `gateway selection reset preserves in flight lease`() throws {
        let suiteName = "OnboardingCrestodianSelectionResetTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let appState = AppState(preview: true)
        appState.connectionMode = .local
        OnboardingCrestodianResumeStore.markPending(
            routeIdentity: "local",
            defaults: defaults)
        let view = OnboardingView(state: appState, crestodianDefaults: defaults)

        view.resetGatewayBoundAIState()

        #expect(OnboardingCrestodianResumeStore.isPending(
            for: "local",
            defaults: defaults))
    }

    @Test func `v1 route marker migrates without blocking another route`() throws {
        let suiteName = "OnboardingCrestodianV1MigrationTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        defaults.set([
            "version": 1,
            "routeIdentity": "remote:id:gateway-a",
            "phase": "verified",
        ], forKey: onboardingCrestodianPendingKey)

        #expect({
            if case .verified = OnboardingCrestodianResumeStore.pendingState(
                for: "remote:id:gateway-a",
                defaults: defaults,
                now: now)
            {
                return true
            }
            return false
        }())
        OnboardingCrestodianResumeStore.markPending(
            routeIdentity: "remote:id:gateway-b",
            defaults: defaults,
            now: now)
        #expect(OnboardingCrestodianResumeStore.isPending(
            for: "remote:id:gateway-a",
            defaults: defaults,
            now: now))
        #expect(OnboardingCrestodianResumeStore.isPending(
            for: "remote:id:gateway-b",
            defaults: defaults,
            now: now))
    }

    @Test func `fallback remote route identity omits auth but preserves endpoint`() {
        let authenticatedIdentity = OnboardingCrestodianResumeStore.routeIdentity(
            connectionMode: .remote,
            preferredGatewayID: nil,
            remoteTransport: .direct,
            remoteURL: "wss://user:secret@gateway.example.test/path?tenant=team-a&token=secret#fragment",
            remoteTarget: "")
        let cleanIdentity = OnboardingCrestodianResumeStore.routeIdentity(
            connectionMode: .remote,
            preferredGatewayID: nil,
            remoteTransport: .direct,
            remoteURL: "wss://gateway.example.test/path?tenant=team-a",
            remoteTarget: "")
        let otherEndpointIdentity = OnboardingCrestodianResumeStore.routeIdentity(
            connectionMode: .remote,
            preferredGatewayID: nil,
            remoteTransport: .direct,
            remoteURL: "wss://gateway.example.test/other",
            remoteTarget: "")
        let otherQueryIdentity = OnboardingCrestodianResumeStore.routeIdentity(
            connectionMode: .remote,
            preferredGatewayID: nil,
            remoteTransport: .direct,
            remoteURL: "wss://gateway.example.test/path?tenant=team-b",
            remoteTarget: "")

        #expect(authenticatedIdentity?.hasPrefix("remote:direct:") == true)
        #expect(authenticatedIdentity?.contains("secret") == false)
        #expect(authenticatedIdentity?.contains("gateway.example.test") == false)
        #expect(authenticatedIdentity == cleanIdentity)
        #expect(authenticatedIdentity != otherEndpointIdentity)
        #expect(authenticatedIdentity != otherQueryIdentity)
    }

    @Test func `fallback route identity distinguishes local state dirs and ssh gateway ports`() {
        let localA = OnboardingCrestodianResumeStore.routeIdentity(
            connectionMode: .local,
            preferredGatewayID: nil,
            remoteTransport: .direct,
            remoteURL: "",
            remoteTarget: "",
            localStateDir: URL(fileURLWithPath: "/tmp/openclaw-state-a"))
        let localB = OnboardingCrestodianResumeStore.routeIdentity(
            connectionMode: .local,
            preferredGatewayID: nil,
            remoteTransport: .direct,
            remoteURL: "",
            remoteTarget: "",
            localStateDir: URL(fileURLWithPath: "/tmp/openclaw-state-b"))
        let sshA = OnboardingCrestodianResumeStore.routeIdentity(
            connectionMode: .remote,
            preferredGatewayID: nil,
            remoteTransport: .ssh,
            remoteURL: "",
            remoteTarget: "user@gateway.example.test",
            sshRemotePort: 18789)
        let sshB = OnboardingCrestodianResumeStore.routeIdentity(
            connectionMode: .remote,
            preferredGatewayID: nil,
            remoteTransport: .ssh,
            remoteURL: "",
            remoteTarget: "user@gateway.example.test",
            sshRemotePort: 18790)

        #expect(localA?.hasPrefix("local:") == true)
        #expect(localA != localB)
        #expect(sshA != sshB)
    }

    @Test func `fallback remote route identity canonicalizes the persisted URL`() {
        let beforePersistence = OnboardingCrestodianResumeStore.routeIdentity(
            connectionMode: .remote,
            preferredGatewayID: nil,
            remoteTransport: .direct,
            remoteURL: "ws://localhost",
            remoteTarget: "")
        let afterPersistence = OnboardingCrestodianResumeStore.routeIdentity(
            connectionMode: .remote,
            preferredGatewayID: nil,
            remoteTransport: .direct,
            remoteURL: "ws://localhost:18789",
            remoteTarget: "")

        #expect(beforePersistence == afterPersistence)
    }

    @Test func `activation marks pending before request and clears definitive failure`() async throws {
        let suiteName = "OnboardingActivationMarkerTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let observation = ActivationMarkerObservation()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0,
                      let id = GatewayWebSocketTestSupport.requestID(from: message)
                else { return }
                let requestDefaults = UserDefaults(suiteName: suiteName)
                await observation.record(
                    requestDefaults.map {
                        OnboardingCrestodianResumeStore.isPending(
                            for: "local",
                            defaults: $0)
                    } == true)
                task.emitReceiveSuccess(.data(failedActivationResponse(id: id)))
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
        let model = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { "local" })

        await model.activate(kind: "codex-cli")

        #expect(await observation.value())
        #expect(!OnboardingCrestodianResumeStore.isPending(for: "local", defaults: defaults))
    }

    @Test func `stale queued detection cannot probe a replacement Gateway`() async throws {
        let suiteName = "OnboardingQueuedDetectionRouteTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let url = try #require(URL(string: "ws://example.invalid"))
        let config = AISetupGatewayConfig(url: url, token: "route-a-token")
        let recorder = AISetupRequestRecorder()
        let session = makeAISetupSession(recorder: recorder)
        let gateway = GatewayConnection(
            configProvider: { config.snapshot() },
            sessionBox: WebSocketSessionBox(session: session))
        let routeIdentity = AISetupRouteIdentity("remote:id:gateway-a")
        let model = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { routeIdentity.snapshot() })

        model.startIfNeeded()
        model.resetForGatewayChange()
        config.setToken("route-b-token")
        routeIdentity.set("remote:id:gateway-b")
        model.startIfNeeded()

        let requests = await waitForAISetupRequests(recorder, count: 1)
        #expect(requests.methods == ["crestodian.setup.detect"])
        #expect(requests.apiKeys.isEmpty)
        #expect(model.phase == .ready)
    }

    @Test func `stale queued selection cannot activate on a replacement Gateway`() async throws {
        let suiteName = "OnboardingQueuedSelectionRouteTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let url = try #require(URL(string: "ws://example.invalid"))
        let config = AISetupGatewayConfig(url: url, token: "route-a-token")
        let recorder = AISetupRequestRecorder()
        let gateway = GatewayConnection(
            configProvider: { config.snapshot() },
            sessionBox: WebSocketSessionBox(session: makeAISetupSession(recorder: recorder)))
        let routeIdentity = AISetupRouteIdentity("remote:id:gateway-a")
        let model = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { routeIdentity.snapshot() })
        await model.detectAndAutoConnect()

        model.userSelect(kind: "claude-cli")
        model.resetForGatewayChange()
        config.setToken("route-b-token")
        routeIdentity.set("remote:id:gateway-b")
        await settleQueuedAISetupTasks()

        let requests = await recorder.snapshot()
        #expect(requests.methods == ["crestodian.setup.detect"])
        #expect(!OnboardingCrestodianResumeStore.isPending(
            for: "remote:id:gateway-b",
            defaults: defaults))
        #expect(model.phase == .idle)
    }

    @Test func `stale manual key task never sends credentials to a replacement Gateway`() async throws {
        let suiteName = "OnboardingQueuedManualRouteTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let url = try #require(URL(string: "ws://example.invalid"))
        let config = AISetupGatewayConfig(url: url, token: "route-a-token")
        let recorder = AISetupRequestRecorder()
        let gateway = GatewayConnection(
            configProvider: { config.snapshot() },
            sessionBox: WebSocketSessionBox(session: makeAISetupSession(recorder: recorder)))
        let routeIdentity = AISetupRouteIdentity("remote:id:gateway-a")
        let model = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { routeIdentity.snapshot() })
        await model.detectAndAutoConnect()
        model.manualProviderID = "openai-api-key"
        model.manualKey = "old-route-secret"

        model.submitManualKey()
        model.resetForGatewayChange()
        config.setToken("route-b-token")
        routeIdentity.set("remote:id:gateway-b")
        await settleQueuedAISetupTasks()

        let requests = await recorder.snapshot()
        #expect(requests.methods == ["crestodian.setup.detect"])
        #expect(!requests.apiKeys.contains("old-route-secret"))
        #expect(!OnboardingCrestodianResumeStore.isPending(
            for: "remote:id:gateway-b",
            defaults: defaults))
        #expect(!model.manualTesting)
    }

    @Test func `automatic activation rejects an auth-token change before dispatch`() async throws {
        let suiteName = "OnboardingAutomaticActivationTokenTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let url = try #require(URL(string: "ws://example.invalid"))
        let config = AISetupGatewayConfig(url: url, token: "token-a")
        config.switchToken(to: "token-b", afterReads: 2)
        let recorder = AISetupRequestRecorder()
        let gateway = GatewayConnection(
            configProvider: { config.snapshot() },
            sessionBox: WebSocketSessionBox(session: makeAISetupSession(recorder: recorder)))
        let model = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { "local" })

        await model.activate(kind: "codex-cli")

        #expect(await (recorder.snapshot()).methods.isEmpty)
        #expect(!OnboardingCrestodianResumeStore.isPending(for: "local", defaults: defaults))
        #expect(!model.pendingActivationVerification)
        #expect(model.phase == .ready)
    }

    @Test func `manual activation rejects an auth-token change before sending the key`() async throws {
        let suiteName = "OnboardingManualActivationTokenTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let url = try #require(URL(string: "ws://example.invalid"))
        let config = AISetupGatewayConfig(url: url, token: "token-a")
        let recorder = AISetupRequestRecorder()
        let gateway = GatewayConnection(
            configProvider: { config.snapshot() },
            sessionBox: WebSocketSessionBox(session: makeAISetupSession(recorder: recorder)))
        let model = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { "local" })
        await model.detectAndAutoConnect()
        model.manualProviderID = "openai-api-key"
        model.manualKey = "must-not-send"
        config.switchToken(to: "token-b", afterReads: 2)

        model.submitManualKey()
        for _ in 0..<200 {
            guard model.manualTesting else { break }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }

        let requests = await recorder.snapshot()
        #expect(requests.methods == ["crestodian.setup.detect"])
        #expect(!requests.apiKeys.contains("must-not-send"))
        #expect(!OnboardingCrestodianResumeStore.isPending(for: "local", defaults: defaults))
        #expect(!model.pendingActivationVerification)
        #expect(model.manualError != nil)
    }

    @Test func `cancellation after activation dispatch retains pending resume marker`() async throws {
        let suiteName = "OnboardingDispatchedCancellationTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let url = try #require(URL(string: "ws://example.invalid"))
        let config = AISetupGatewayConfig(url: url, token: "token-a")
        let recorder = AISetupRequestRecorder()
        let gateway = GatewayConnection(
            configProvider: { config.snapshot() },
            sessionBox: WebSocketSessionBox(session: makeAISetupSession(
                recorder: recorder,
                cancelActivationAfterSend: true)))
        let model = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { "local" })
        var scheduledDeadlines: [(deadline: Date, routeIdentity: String)] = []
        model.onPendingActivationDeadline = { deadline, routeIdentity in
            scheduledDeadlines.append((deadline, routeIdentity))
        }

        await model.activate(kind: "codex-cli")

        #expect(await (recorder.snapshot()).methods == ["crestodian.setup.activate"])
        #expect(OnboardingCrestodianResumeStore.isPending(for: "local", defaults: defaults))
        #expect(model.pendingActivationVerification)
        #expect(model.waitingForPendingActivationDeadline)
        #expect(model.isBusy)
        #expect(model.phase == .detecting)
        #expect(scheduledDeadlines.count == 1)
        #expect(scheduledDeadlines.first?.routeIdentity == "local")
    }

    @Test func `manual cancellation after dispatch schedules pending deadline recheck`() async throws {
        let suiteName = "OnboardingManualDispatchedCancellationTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let url = try #require(URL(string: "ws://example.invalid"))
        let recorder = AISetupRequestRecorder()
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: makeAISetupSession(
                recorder: recorder,
                cancelActivationAfterSend: true)))
        let model = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { "local" })
        await model.detectAndAutoConnect()
        model.manualProviderID = "openai-api-key"
        model.manualKey = "temporary-key"
        var scheduledDeadlines: [(deadline: Date, routeIdentity: String)] = []
        model.onPendingActivationDeadline = { deadline, routeIdentity in
            scheduledDeadlines.append((deadline, routeIdentity))
        }

        model.submitManualKey()
        for _ in 0..<200 {
            if !model.manualTesting, model.waitingForPendingActivationDeadline { break }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }

        #expect(await (recorder.snapshot()).methods == [
            "crestodian.setup.detect",
            "crestodian.setup.activate",
        ])
        #expect(OnboardingCrestodianResumeStore.isPending(for: "local", defaults: defaults))
        #expect(model.pendingActivationVerification)
        #expect(model.waitingForPendingActivationDeadline)
        #expect(model.phase == .detecting)
        #expect(scheduledDeadlines.count == 1)
        #expect(scheduledDeadlines.first?.routeIdentity == "local")
    }

    @Test func `superseded activation cannot clear the current gateway handoff`() async throws {
        let suiteName = "OnboardingSupersededActivationMarkerTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, _, sendIndex in
                guard sendIndex > 0 else { return }
                task.emitReceiveFailure()
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
        let model = OnboardingAISetupModel(
            gateway: gateway,
            defaults: defaults,
            routeIdentityProvider: { "remote:id:gateway-a" })

        let staleActivation = Task { await model.activate(kind: "codex-cli") }
        while !OnboardingCrestodianResumeStore.isPending(
            for: "remote:id:gateway-a",
            defaults: defaults)
        {
            await Task.yield()
        }
        model.resetForGatewayChange()
        OnboardingCrestodianResumeStore.markPending(
            routeIdentity: "remote:id:gateway-b",
            defaults: defaults)
        staleActivation.cancel()
        await staleActivation.value

        #expect(OnboardingCrestodianResumeStore.isPending(
            for: "remote:id:gateway-b",
            defaults: defaults))
    }

    @Test func `configured resume preserves marker until route reset`() throws {
        let suiteName = "OnboardingConfiguredResumeMarkerTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let model = OnboardingAISetupModel(
            defaults: defaults,
            routeIdentityProvider: { "local" })
        OnboardingCrestodianResumeStore.markPending(routeIdentity: "local", defaults: defaults)

        model.resumeConfiguredInference(modelRef: "openai/gpt-5.5")
        #expect(OnboardingCrestodianResumeStore.isPending(for: "local", defaults: defaults))

        model.resetForGatewayChange()
        #expect(!OnboardingCrestodianResumeStore.isPending(for: "local", defaults: defaults))
    }
}
