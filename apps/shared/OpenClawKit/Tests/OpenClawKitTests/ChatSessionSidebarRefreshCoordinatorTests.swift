import Testing
@testable import OpenClawChatUI

@MainActor
struct ChatSessionSidebarRefreshCoordinatorTests {
    @MainActor
    private final class Clock {
        var sleepers: [CheckedContinuation<Void, Never>] = []

        func sleep(_: Duration) async throws {
            await withCheckedContinuation { self.sleepers.append($0) }
            try Task.checkCancellation()
        }

        func waitForSleepers(_ count: Int) async {
            for _ in 0..<1000 {
                if self.sleepers.count == count { return }
                await Task.yield()
            }
            Issue.record("Debounced load did not enter the injected clock")
        }

        func advance() {
            let sleepers = self.sleepers
            self.sleepers = []
            for sleeper in sleepers {
                sleeper.resume()
            }
        }
    }

    @Test func `debounce bursts and canceled waits cannot suppress a replacement load`() async throws {
        let coordinator = OpenClawChatSessionRefreshCoordinator()
        let clock = Clock()
        var loads = 0
        for _ in 0..<20 {
            coordinator.scheduleLoad(
                isLoading: false,
                coalescing: true,
                debounce: .milliseconds(200),
                sleep: { try await clock.sleep($0) },
                load: { loads += 1 })
        }
        await clock.waitForSleepers(1)
        #expect(clock.sleepers.count == 1)
        coordinator.cancel()
        coordinator.scheduleLoad(
            isLoading: false,
            coalescing: true,
            debounce: .milliseconds(200),
            sleep: { try await clock.sleep($0) },
            load: { loads += 1 })
        let replacement = try #require(coordinator.task)
        await clock.waitForSleepers(2)
        clock.advance()
        await replacement.value
        #expect(loads == 1)
        coordinator.scheduleLoad(
            isLoading: false,
            coalescing: true,
            debounce: .milliseconds(200),
            sleep: { try await clock.sleep($0) },
            load: { loads += 1 })
        let next = try #require(coordinator.task)
        await clock.waitForSleepers(1)
        clock.advance()
        await next.value
        #expect(loads == 2)
    }
}
