import Foundation
import Testing
@testable import OpenClaw

@MainActor
struct OnboardingDashboardLoadTests {
    @Test func `readiness can complete before the waiter resumes`() async throws {
        let request = DashboardDocumentLoad()
        let waiting = Task { try await request.wait() }
        request.finish(.success(()))
        try await waiting.value
    }

    @Test func `a late result cannot replace a failed handoff`() async {
        let request = DashboardDocumentLoad()
        request.finish(.failure(URLError(.cannotLoadFromNetwork)))
        request.finish(.success(()))
        await #expect(throws: URLError.self) { try await request.wait() }
    }

    @Test func `cancelling an old handoff cannot cancel a newer one`() async throws {
        let oldRequest = DashboardDocumentLoad()
        let oldWait = Task { try await oldRequest.wait() }
        let newRequest = DashboardDocumentLoad()
        oldWait.cancel()
        newRequest.finish(.success(()))

        await #expect(throws: CancellationError.self) { try await oldWait.value }
        try await newRequest.wait()
    }
}
