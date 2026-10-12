import ConcurrencyExtras
import Foundation
import Observation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

@Suite(.serialized, .testWaitLimit)
@MainActor
struct CronJobsStoreTests {
    @Test(arguments: ["manual", "config.changed", "reopen"])
    func `count-only refreshes notify observers without changing preview rows`(trigger: String) async throws {
        let fixture = CronSourceFixture()
        fixture.catalogTotal.setValue(9)
        let store = CronJobsStore(gateway: fixture.gateway)
        do {
            if trigger == "manual" {
                await store.refreshJobs()
            } else {
                store.start()
                try await TestWait.observed("initial Cron catalog") { store.summary.total == 9 }
            }
            try #require(store.summary.total == 9)
            let lease = try #require(await fixture.gateway.captureServerLease())
            let previewIDs = store.summary.jobs.map(\.id)
            try #require(previewIDs.count == 8)
            let changed = LockIsolated(false)
            withObservationTracking {
                _ = store.summary
            } onChange: {
                changed.setValue(true)
            }

            if trigger == "reopen" { store.stop() }
            fixture.catalogTotal.setValue(10)
            switch trigger {
            case "config.changed":
                let request = try #require(fixture.requests.value.last)
                request.socket.emitReceiveSuccess(.string(
                    #"{"type":"event","event":"config.changed","seq":1,"payload":{"hash":"changed","ts":1}}"#))
            case "reopen":
                store.start()
            default:
                await store.refreshJobs()
            }
            try await TestWait.observed("updated Cron catalog") { store.summary.total == 10 }

            #expect(changed.value)
            #expect(store.summary.total == 10)
            #expect(store.summary.jobs.map(\.id) == previewIDs)
            #expect(await fixture.gateway.captureServerLease() == lease)
        } catch {
            store.stop()
            await fixture.gateway.shutdown()
            throw error
        }
        store.stop()
        await fixture.gateway.shutdown()
    }

    @Test(arguments: [false, true], ["menu", "caller"])
    func `stopping a refresh rejects a late job list completion`(succeeds: Bool, owner: String) async throws {
        let fixture = CronSourceFixture(holding: "cron.list")
        let store = CronJobsStore(gateway: fixture.gateway)
        let refresh = Task { await store.refreshJobs() }
        do {
            let pending = try await fixture.firstRequest("cron.list")
            if owner == "menu" {
                store.stop()
            } else {
                refresh.cancel()
            }
            if succeeds {
                CronSourceFixture.respond(pending)
            } else {
                CronSourceFixture.fail(pending, message: "closed menu failure")
            }
            await refresh.value
            #expect(store.summary.jobs.isEmpty)
        } catch {
            store.stop()
            refresh.cancel()
            await fixture.gateway.shutdown()
            await refresh.value
            throw error
        }
        await fixture.gateway.shutdown()
    }

    @Test(arguments: [false, true])
    func `opening the menu loads jobs and closing it stops event refresh`(lateHello: Bool) async throws {
        let fixture = CronSourceFixture()
        let store = CronJobsStore(gateway: fixture.gateway)
        do {
            store.start()
            try await TestWait.observed("one Cron job") { store.summary.jobs.count == 1 }
            #expect(store.summary.jobs.first?.name == "Gateway A")
            if lateHello {
                let count = fixture.requests.value.count { $0.method == "cron.list" }
                let snapshot = try #require(await fixture.gateway.lastSnapshot)
                let lease = try #require(await fixture.gateway.captureServerLease())
                await fixture.gateway._test_handlePush(.snapshot(snapshot), socketGeneration: lease.socketGeneration)
                try await Task.sleep(for: .milliseconds(350))
                #expect(fixture.requests.value.count { $0.method == "cron.list" } == count)
            }
            store.stop()
            let count = fixture.requests.value.count
            try self.sendCronEvent(fixture, sequence: 1)
            try await Task.sleep(for: .milliseconds(350))
            #expect(fixture.requests.value.count == count)
        } catch {
            store.stop()
            await fixture.gateway.shutdown()
            throw error
        }
        await fixture.gateway.shutdown()
    }

    @Test(arguments: ["event", "manual"])
    func `replacement refresh waits for its canceled predecessor to drain`(replacement: String) async throws {
        let (lookups, entered) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        let (releases, release) = AsyncStream<Void>.makeStream()
        let cancelled = AsyncTestGate()
        let heldLookup = Task { for await _ in releases {} }
        let holdNextLookup = LockIsolated(false)
        let fixture = CronSourceFixture(beforeEndpointLookup: {
            guard holdNextLookup.withValue({ value in
                defer { value = false }
                return value
            }) else { return }
            await withTaskCancellationHandler {
                entered.yield(())
                await heldLookup.value
            } onCancel: {
                cancelled.open()
            }
        })
        let store = CronJobsStore(gateway: fixture.gateway)
        var manualRefresh: Task<Void, Never>?
        func cleanup() async {
            release.finish()
            entered.finish()
            store.stop()
            manualRefresh?.cancel()
            await heldLookup.value
            await fixture.gateway.shutdown()
            await manualRefresh?.value
        }
        do {
            store.start()
            try await TestWait.observed("one Cron job") { store.summary.jobs.count == 1 }
            fixture.catalogTotal.setValue(0)
            holdNextLookup.setValue(true)
            try self.sendCronEvent(fixture, sequence: 1)
            var reachedGate = false
            for await _ in lookups {
                reachedGate = true
                break
            }
            try #require(reachedGate, "held endpoint lookup")
            let count = fixture.requests.value.count { $0.method == "cron.list" }
            if replacement == "event" {
                try self.sendCronEvent(fixture, sequence: 2)
            } else {
                let admitted = AsyncTestGate()
                manualRefresh = Task {
                    admitted.open()
                    await store.refreshJobs()
                }
                await admitted.wait()
                try Task.checkCancellation()
            }
            await cancelled.wait()
            try Task.checkCancellation()
            try await Task.sleep(for: .milliseconds(350))
            #expect(fixture.requests.value.count { $0.method == "cron.list" } == count)
            release.finish()
            try await TestWait.observed("no Cron jobs") { store.summary.jobs.count == 0 }
            #expect(fixture.requests.value.count { $0.method == "cron.list" } > count)
        } catch {
            await cleanup()
            throw error
        }
        await cleanup()
    }

    private func sendCronEvent(_ fixture: CronSourceFixture, sequence: Int) throws {
        let request = try #require(fixture.requests.value.last)
        let event = #"""
        {"type":"event","event":"cron","seq":\#(sequence),"payload":{"jobId":"shared-job","action":"finished"}}
        """#
        request.socket.emitReceiveSuccess(.string(event))
    }
}
