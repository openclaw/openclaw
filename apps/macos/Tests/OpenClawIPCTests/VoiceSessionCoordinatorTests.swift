import Foundation
import Testing
@testable import OpenClaw

@MainActor
struct VoiceSessionCoordinatorTests {
    enum RetryChange: CaseIterable, Sendable { case none, transcript, session, deliveryTarget }
    enum Retirement: CaseIterable, Sendable { case replacement, dismissal }
    enum PendingBoundary: CaseIterable, Sendable { case preparation, forwarding }

    @Test(arguments: RetryChange.allCases)
    func manualAndQueuedAutoSendShareAdmissionAndRetryIdentity(change: RetryChange) async throws {
        try await withVoiceSendFixture { fixture in
            var requests = fixture.forwarding.requests.makeAsyncIterator()
            let token = fixture.sessions.startSession(text: "original", forwardEnabled: true)
            fixture.sessions.finalize(token: token, text: "original", sendChime: .none, autoSendAfter: nil)
            // These are the two entry points after the delayed callback has already queued.
            fixture.overlay.requestSend(token: token)
            let firstTask = try #require(fixture.tasks.last)
            fixture.overlay.actions()?.send(token, .autoSendDelay)
            #expect(fixture.tasks.count == 1)
            let first = try #require(await requests.next())
            #expect(first.input.message.hasSuffix("\n\noriginal"))
            #expect(first.input.sessionKey == "agent:main:work")
            #expect(fixture.overlay.model.isSending)
            #expect(!fixture.overlay.model.isSent)
            #expect(fixture.dismissals.isEmpty)

            first.complete(.failure(.rpcFailed("synthetic RPC rejection")))
            await firstTask.value
            #expect(fixture.overlay.model.sendError == "synthetic RPC rejection")
            #expect(!fixture.overlay.model.isSending)
            #expect(!fixture.overlay.model.isSent)
            #expect(fixture.overlay.isVisible)
            #expect(fixture.overlay.model.text == "original")
            #expect(fixture.dismissals.isEmpty)
            #expect(fixture.completedOutcomes.isEmpty)
            // A queued automatic callback must not turn a failed attempt into an implicit retry.
            fixture.overlay.actions()?.send(token, .autoSendDelay)
            #expect(fixture.tasks.count == 1)

            switch change {
            case .none: break
            case .transcript: fixture.overlay.updateText("corrected")
            case .session: fixture.sessionKey = "agent:main:other"
            case .deliveryTarget:
                fixture.route = .init(
                    key: fixture.sessionKey, channel: "telegram", lastChannel: nil,
                    lastTo: nil, deliveryContext: .init(channel: "telegram", to: "synthetic-target"))
            }
            fixture.overlay.requestSend(token: token)
            let retryTask = try #require(fixture.tasks.last)
            let retry = try #require(await requests.next())
            #expect((retry.input.idempotencyKey == first.input.idempotencyKey) == (change == .none))
            switch change {
            case .none: #expect(retry.input == first.input)
            case .transcript: #expect(retry.input.message.hasSuffix("\n\ncorrected"))
            case .session: #expect(retry.input.sessionKey == "agent:main:other")
            case .deliveryTarget:
                #expect(retry.input.to == "synthetic-target")
                #expect(retry.input.channel == .telegram)
                #expect(retry.input.deliver)
            }
            #expect(fixture.overlay.model.sendError == nil)
            retry.complete(.success(()))
            await retryTask.value
            #expect(fixture.overlay.model.isSent)
            #expect(!fixture.overlay.model.isSending)
            #expect(fixture.dismissals == [.sent])
            #expect(fixture.sessions.snapshot().token == nil)
            fixture.overlay.requestSend(token: token)
            #expect(fixture.tasks.count == 2)
            fixture.completeDismissal()
            #expect(fixture.completedOutcomes == [.sent])
            #expect(!fixture.overlay.isVisible)
        }
    }

    @Test(arguments: Retirement.allCases, PendingBoundary.allCases)
    func retiredSendCannotForwardOrPublishALateResult(retirement: Retirement, boundary: PendingBoundary) async throws {
        try await withVoiceSendFixture { fixture in
            fixture.holdPreparation = boundary == .preparation
            var preparations = fixture.preparation.requests.makeAsyncIterator()
            var forwards = fixture.forwarding.requests.makeAsyncIterator()
            let token = fixture.sessions.startSession(text: "retired", forwardEnabled: true)
            fixture.overlay.requestSend(token: token)
            let task = try #require(fixture.tasks.last)
            let pendingPreparation = boundary == .preparation ? await preparations.next() : nil
            let pendingForward = boundary == .forwarding ? await forwards.next() : nil

            let replacement: UUID?
            switch retirement {
            case .replacement:
                replacement = fixture.sessions.startSession(text: "replacement", forwardEnabled: true)
            case .dismissal:
                replacement = nil
                fixture.overlay.cancelEditingAndDismiss()
                #expect(fixture.sessions.snapshot().token == nil)
            }
            #expect(task.isCancelled)
            // These boundaries deliberately ignore cancellation, as an already-submitted RPC may do.
            if let pendingPreparation { pendingPreparation.complete(pendingPreparation.input) }
            pendingForward?.complete(.success(()))
            await task.value
            #expect(fixture.sessions.snapshot().token == replacement)
            #expect(!fixture.overlay.model.isSent)
            #expect(fixture.overlay.model.sendError == nil)
            #expect(!fixture.overlay.model.isSending)
            #expect(!fixture.dismissals.contains(.sent))
            #expect(fixture.completedOutcomes.isEmpty)
            if boundary == .preparation {
                #expect(await fixture.forwarding.inputs().isEmpty)
            }
            if replacement != nil {
                #expect(fixture.overlay.model.text == "replacement")
                #expect(fixture.overlay.isVisible)
            } else {
                fixture.completeDismissal()
                #expect(!fixture.overlay.isVisible)
                #expect(fixture.completedOutcomes == [.empty])
            }
        }
    }
}

/// Continuation-backed external boundary: no sleeps, polling, windows, defaults, or Gateway.
private actor VoiceSendBoundary<Input: Sendable, Output: Sendable> {
    struct Request: Sendable {
        let input: Input
        let complete: @Sendable (Output) -> Void
    }

    nonisolated let requests: AsyncStream<Request>
    private let events: AsyncStream<Request>.Continuation
    private var pending: [UUID: CheckedContinuation<Output, Never>] = [:]
    private var received: [Input] = []
    private let cleanupValue: Output

    init(cleanupValue: Output) {
        let stream = AsyncStream<Request>.makeStream()
        self.requests = stream.stream
        self.events = stream.continuation
        self.cleanupValue = cleanupValue
    }

    func request(_ input: Input) async -> Output {
        let id = UUID()
        self.received.append(input)
        return await withCheckedContinuation { continuation in
            self.pending[id] = continuation
            self.events.yield(Request(input: input, complete: { value in
                Task { await self.resolve(id, value: value) }
            }))
        }
    }

    private func resolve(_ id: UUID, value: Output) {
        self.pending.removeValue(forKey: id)?.resume(returning: value)
    }

    func inputs() -> [Input] { self.received }

    func finish() {
        for continuation in self.pending.values { continuation.resume(returning: self.cleanupValue) }
        self.pending.removeAll()
        self.events.finish()
    }
}

@MainActor
private final class VoiceSendFixture {
    let forwarding = VoiceSendBoundary<GatewayAgentInvocation, Result<Void, VoiceWakeForwarder.VoiceWakeForwardError>>(
        cleanupValue: .failure(.rpcFailed("fixture cleanup")))
    let preparation = VoiceSendBoundary<GatewayAgentInvocation, GatewayAgentInvocation>(
        cleanupValue: .init(message: "fixture cleanup"))
    var holdPreparation = false
    var sessionKey = "agent:main:work"
    var route: VoiceWakeForwarder.SessionRouteEntry?
    var tasks: [Task<Void, Never>] = []
    var dismissals: [VoiceWakeOverlayController.SendOutcome] = []
    var completedOutcomes: [VoiceWakeOverlayController.SendOutcome] = []
    private var finishDismissal: (@MainActor () -> Void)?

    lazy var overlay: VoiceWakeOverlayController = .init(
        enableUI: false,
        presentation: .init(
            present: { _, _ in }, updateFrame: { _, _ in }, bringToFront: { _ in },
            animateDismiss: { [unowned self] _, _, outcome, completion in
                self.dismissals.append(outcome)
                self.finishDismissal = { completion(.animated(finishWindow: {})) }
            }),
        actions: { [unowned self] in
            .init(
                send: { token, reason in
                    if let task = self.sessions.sendNow(token: token, reason: reason) { self.tasks.append(task) }
                },
                updateEditedText: { self.sessions.updateEditedText(token: $0, text: $1) },
                didPresent: {},
                willDismiss: { self.sessions.overlayWillDismiss(token: $0) },
                didDismiss: { token, outcome in
                    self.completedOutcomes.append(outcome)
                    self.sessions.overlayDidDismiss(token: token)
                })
        })
    lazy var sessions: VoiceSessionCoordinator = .init(
        overlay: self.overlay,
        prepareForward: { [unowned self] text, trigger in await self.prepare(text, trigger: trigger) },
        forward: { [forwarding] in await forwarding.request($0) },
        didDismiss: { _ in })

    private func prepare(_ text: String, trigger: String?) async -> GatewayAgentInvocation {
        let invocation = VoiceWakeForwarder.makeInvocation(
            transcript: text,
            sessionKey: self.sessionKey,
            routeEntries: self.route.map { [$0] } ?? [],
            voiceWakeTrigger: trigger)
        return self.holdPreparation ? await self.preparation.request(invocation) : invocation
    }

    func completeDismissal() {
        let completion = self.finishDismissal
        self.finishDismissal = nil
        completion?()
    }

    func cleanup() async {
        if let token = self.sessions.snapshot().token {
            self.sessions.dismiss(token: token, reason: .explicit, outcome: .empty)
        }
        await self.preparation.finish()
        await self.forwarding.finish()
        for task in self.tasks { await task.value }
        self.completeDismissal()
    }
}

@MainActor
private func withVoiceSendFixture(_ body: (VoiceSendFixture) async throws -> Void) async throws {
    let fixture = VoiceSendFixture()
    do {
        try await body(fixture)
    } catch {
        await fixture.cleanup()
        throw error
    }
    await fixture.cleanup()
}
