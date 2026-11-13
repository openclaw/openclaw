import Foundation
import Testing
@testable import OpenClawChatUI

@MainActor
private func queueWhileOffline(_ vm: OpenClawChatViewModel, text: String) async throws {
    vm.input = text
    vm.send()
    try await waitForOutboxState { !vm.isSubmittingDraft }
}

private func drain(_ vm: OpenClawChatViewModel, timeoutMs: Int) async -> OpenClawChatOutboxWakeDrain {
    await vm.drainOutboxForBackgroundWake(timeoutMs: timeoutMs) { _ in true }
}

@Suite(.timeLimit(.minutes(1)))
struct ChatViewModelOutboxBackgroundWakeTests {
    @Test func `background wake drain delivers queued sends before returning`() async throws {
        let (store, _, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let transport = OutboxTestTransport(healthy: false)
        let vm = await makeOutboxViewModel(transport: transport, outbox: store, transcriptCache: store)

        await MainActor.run { vm.load() }
        try await queueWhileOffline(vm, text: "first")
        try await queueWhileOffline(vm, text: "second")
        let queuedIDs = await store.loadCommands().map(\.id)
        #expect(queuedIDs.count == 2)

        // A wake reconnects the gateway; its health event has not reached the view model yet.
        await transport.state.update { $0.healthy = true }
        #expect(await drain(vm, timeoutMs: 20000) == .delivered)

        #expect(await transport.state.sentIdempotencyKeys == queuedIDs)
        #expect(await transport.state.sentMessages == ["first", "second"])
        #expect(await drain(vm, timeoutMs: 20000) == .idle)
    }

    @Test func `background wake drain keeps the retry backoff after a gateway rejection`() async throws {
        let (store, _, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let transport = OutboxTestTransport(healthy: false)
        // Production retry delays.
        let vm = await makeOutboxViewModel(transport: transport, outbox: store, retryDelaysMs: [2000, 8000])

        await MainActor.run { vm.load() }
        try await queueWhileOffline(vm, text: "rejected once")
        await transport.state.update {
            $0.sendRejects = true
            $0.healthy = true
        }
        let started = Date()

        // Inside the 2 s backoff the drain only waits: one attempt spent, row still queued.
        #expect(await drain(vm, timeoutMs: 1500) == .pending)
        let afterRejection = await store.loadCommands()
        #expect(afterRejection.map(\.status) == [.queued])
        #expect(afterRejection.map(\.retryCount) == [1])

        // The outbox's own retry timer sends it again inside the wake window.
        await transport.state.update { $0.sendRejects = false }
        #expect(await drain(vm, timeoutMs: 5000) == .delivered)
        #expect(Date().timeIntervalSince(started) >= 2)
        #expect(await transport.state.sentMessages == ["rejected once"])
    }

    @Test func `background wake drain reports terminal rejections as failed`() async throws {
        let (store, _, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let transport = OutboxTestTransport(healthy: false)
        let vm = await makeOutboxViewModel(transport: transport, outbox: store)

        await MainActor.run { vm.load() }
        try await queueWhileOffline(vm, text: "always rejected")
        await transport.state.update {
            $0.sendRejects = true
            $0.healthy = true
        }

        #expect(await drain(vm, timeoutMs: 20000) == .failed)
        let rows = await store.loadCommands()
        #expect(rows.map(\.status) == [.failed])
        #expect(rows.map(\.retryCount) == [3])
    }

    @Test func `background wake drain bounds a slow health check by the time left`() async throws {
        let (store, _, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let transport = OutboxTestTransport(healthy: false)
        let vm = await makeOutboxViewModel(transport: transport, outbox: store)

        await MainActor.run { vm.load() }
        try await queueWhileOffline(vm, text: "slow link")
        // A slow reconnect left little of the wake: the Gateway answers health only after 5 s.
        await transport.state.update {
            $0.healthDelayMs = 5000
            $0.healthy = true
        }
        let started = Date()

        #expect(await drain(vm, timeoutMs: 800) == .pending)
        #expect(Date().timeIntervalSince(started) < 1.5)
        #expect(try #require(await transport.state.healthTimeoutsMs.last) <= 800)
        #expect(await store.loadCommands().map(\.status) == [.queued])
    }

    @Test func `background wake drain gives up at its deadline while offline`() async throws {
        let (store, _, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let transport = OutboxTestTransport(healthy: false)
        let vm = await makeOutboxViewModel(transport: transport, outbox: store)

        await MainActor.run { vm.load() }
        try await queueWhileOffline(vm, text: "still offline")

        #expect(await drain(vm, timeoutMs: 300) == .pending)
        #expect(await vm.drainOutboxForBackgroundWake(timeoutMs: 300) { _ in false } == .noRoute)
        #expect(await transport.state.sentIdempotencyKeys.isEmpty)
        #expect(await store.loadCommands().map(\.status) == [.queued])
    }

    @Test func `background wake drain never replays an unconfirmed send`() async throws {
        let (store, _, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let transport = OutboxTestTransport(healthy: false)
        let vm = await makeOutboxViewModel(transport: transport, outbox: store)

        await MainActor.run { vm.load() }
        try await queueWhileOffline(vm, text: "accepted before disconnect")
        let queuedIDs = await store.loadCommands().map(\.id)
        await transport.state.update {
            $0.sendFailsAfterRecording = true
            $0.healthy = true
        }

        // The lost ack is settled by history (the fake Gateway stored the turn), never by a resend.
        let outcome = await drain(vm, timeoutMs: 20000)
        #expect(outcome == .delivered, "outcome \(outcome.rawValue)")
        // A second wake must not resend the ambiguous attempt.
        #expect(await drain(vm, timeoutMs: 20000) == .idle)
        #expect(await transport.state.sentIdempotencyKeys == queuedIDs)
    }
}
