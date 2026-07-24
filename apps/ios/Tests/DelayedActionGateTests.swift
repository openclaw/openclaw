import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

private actor DelayDeliveryBarrier {
    private var deliveryCount = 0
    private var firstDeliveryPaused = false
    private var pauseWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    func pauseFirstDelivery() async {
        self.deliveryCount += 1
        guard self.deliveryCount == 1 else { return }
        self.firstDeliveryPaused = true
        let pauseWaiters = self.pauseWaiters
        self.pauseWaiters.removeAll()
        for waiter in pauseWaiters {
            waiter.resume()
        }
        await withCheckedContinuation { continuation in
            self.releaseWaiters.append(continuation)
        }
    }

    func waitUntilFirstDeliveryIsPaused() async {
        if self.firstDeliveryPaused { return }
        await withCheckedContinuation { continuation in
            self.pauseWaiters.append(continuation)
        }
    }

    func releaseFirstDelivery() {
        let releaseWaiters = self.releaseWaiters
        self.releaseWaiters.removeAll()
        for waiter in releaseWaiters {
            waiter.resume()
        }
    }
}

private actor WakeWordsApplyRecorder {
    struct Entry: Equatable, Sendable {
        let words: [String]
        let gatewayID: String
    }

    private var entries: [Entry] = []

    func record(words: [String], gatewayID: String) {
        self.entries.append(Entry(words: words, gatewayID: gatewayID))
    }

    func snapshot() -> [Entry] {
        self.entries
    }
}

struct DelayedActionGateTests {
    @Test @MainActor func `completed delay delivers its action`() async {
        var actions: [String] = []
        let gate = DelayedActionGate(sleeper: { _ in })

        let task = gate.schedule(after: .zero) {
            actions.append("current")
        }
        await task.value

        #expect(actions == ["current"])
    }

    @Test @MainActor func `cancellation after delay return suppresses delivery`() async {
        var actions: [String] = []
        let barrier = DelayDeliveryBarrier()
        let gate = DelayedActionGate(
            sleeper: { _ in },
            deliveryBarrier: { await barrier.pauseFirstDelivery() })

        let task = gate.schedule(after: .zero) {
            actions.append("stale")
        }
        await barrier.waitUntilFirstDeliveryIsPaused()
        gate.cancel()
        await barrier.releaseFirstDelivery()
        await task.value

        #expect(actions.isEmpty)
    }

    @Test @MainActor func `replacement action wins after stale delay returns`() async {
        var actions: [String] = []
        let barrier = DelayDeliveryBarrier()
        let gate = DelayedActionGate(
            sleeper: { _ in },
            deliveryBarrier: { await barrier.pauseFirstDelivery() })

        let staleTask = gate.schedule(after: .zero) {
            actions.append("stale")
        }
        await barrier.waitUntilFirstDeliveryIsPaused()
        let currentTask = gate.schedule(after: .zero) {
            actions.append("current")
        }
        await currentTask.value
        await barrier.releaseFirstDelivery()
        await staleTask.value

        #expect(actions == ["current"])
    }
}

struct GlobalWakeWordsSchedulingTests {
    @Test @MainActor func `model owns the pending wake words until delivery`() async throws {
        let fixture = try self.makeFixture(gatewayID: "gateway-a")
        defer { fixture.cleanup() }

        let task = try #require(
            fixture.model.scheduleGlobalWakeWordsSync(["saved"], after: .zero))
        await task.value

        #expect(await fixture.recorder.snapshot() == [
            .init(words: ["saved"], gatewayID: "gateway-a"),
        ])
    }

    @Test @MainActor func `replacement wake words are the only update applied`() async throws {
        let fixture = try self.makeFixture(gatewayID: "gateway-a")
        defer { fixture.cleanup() }

        let staleTask = try #require(
            fixture.model.scheduleGlobalWakeWordsSync(["old"], after: .seconds(30)))
        await Task.yield()
        let currentTask = try #require(
            fixture.model.scheduleGlobalWakeWordsSync(["new"], after: .zero))
        await staleTask.value
        await currentTask.value

        #expect(await fixture.recorder.snapshot() == [
            .init(words: ["new"], gatewayID: "gateway-a"),
        ])
    }

    @Test @MainActor func `dismiss then reopen replaces the pending value`() async throws {
        let fixture = try self.makeFixture(gatewayID: "gateway-a")
        defer { fixture.cleanup() }

        let dismissedTask = try #require(
            fixture.model.scheduleGlobalWakeWordsSync(["dismissed"], after: .seconds(30)))
        let reopenedTask = try #require(
            fixture.model.scheduleGlobalWakeWordsSync(["reopened"], after: .zero))
        await dismissedTask.value
        await reopenedTask.value

        #expect(await fixture.recorder.snapshot() == [
            .init(words: ["reopened"], gatewayID: "gateway-a"),
        ])
    }

    @Test @MainActor func `same gateway reconnect preserves the pending value`() async throws {
        let fixture = try self.makeFixture(gatewayID: "gateway-a")
        defer { fixture.cleanup() }

        let staleRouteTask = try #require(
            fixture.model.scheduleGlobalWakeWordsSync(["pending"], after: .seconds(30)))
        let replacementRouteTask = try #require(
            fixture.model._test_advanceGatewayRouteGeneration(
                preservingGlobalWakeWordsFor: "gateway-a"))
        await staleRouteTask.value
        await replacementRouteTask.value

        #expect(await fixture.recorder.snapshot() == [
            .init(words: ["pending"], gatewayID: "gateway-a"),
        ])
    }

    @Test @MainActor func `operator route ready event retries the pending value`() async throws {
        let fixture = try self.makeFixture(gatewayID: "gateway-a")
        defer { fixture.cleanup() }

        let offlineTask = try #require(
            fixture.model.scheduleGlobalWakeWordsSync(["offline-pending"], after: .seconds(30)))
        let routeReadyTask = try #require(
            fixture.model._test_retryPendingGlobalWakeWordsSync(stableID: "gateway-a"))
        await offlineTask.value
        await routeReadyTask.value

        #expect(await fixture.recorder.snapshot() == [
            .init(words: ["offline-pending"], gatewayID: "gateway-a"),
        ])
    }

    @Test @MainActor func `gateway switch invalidates the old route update`() async throws {
        let fixture = try self.makeFixture(gatewayID: "gateway-a")
        defer { fixture.cleanup() }

        let staleTask = try #require(
            fixture.model.scheduleGlobalWakeWordsSync(["old-route"], after: .seconds(30)))
        #expect(fixture.model._test_advanceGatewayRouteGeneration(
            preservingGlobalWakeWordsFor: "gateway-b") == nil)
        try fixture.model._test_setActiveGatewayConnectConfig(self.gatewayConfig(stableID: "gateway-b"))
        let currentTask = try #require(
            fixture.model.scheduleGlobalWakeWordsSync(["new-route"], after: .zero))
        await staleTask.value
        await currentTask.value

        #expect(await fixture.recorder.snapshot() == [
            .init(words: ["new-route"], gatewayID: "gateway-b"),
        ])
    }

    @MainActor
    private func makeFixture(gatewayID: String) throws -> (
        model: NodeAppModel,
        recorder: WakeWordsApplyRecorder,
        cleanup: @MainActor () -> Void)
    {
        let model = NodeAppModel()
        let recorder = WakeWordsApplyRecorder()
        try model._test_setActiveGatewayConnectConfig(self.gatewayConfig(stableID: gatewayID))
        model._test_setGlobalWakeWordsApplyHandler { words, appliedGatewayID in
            await recorder.record(words: words, gatewayID: appliedGatewayID)
        }
        return (model, recorder, {
            model.cancelScheduledGlobalWakeWordsSync()
            model._test_setGlobalWakeWordsApplyHandler(nil)
            model.voiceWake.stop()
        })
    }

    private func gatewayConfig(stableID: String) throws -> GatewayConnectConfig {
        try GatewayConnectConfig(
            url: #require(URL(string: "wss://\(stableID).example")),
            stableID: stableID,
            tls: nil,
            token: "token",
            bootstrapToken: nil,
            password: nil,
            nodeOptions: GatewayConnectOptions(
                role: "node",
                scopes: [],
                caps: [],
                commands: [],
                permissions: [:],
                clientId: "test",
                clientMode: "node",
                clientDisplayName: "Test"))
    }
}
