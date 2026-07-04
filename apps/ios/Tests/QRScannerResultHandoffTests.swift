import Testing
@testable import OpenClaw

@MainActor
struct QRScannerResultHandoffTests {
    @Test func `queued result is delivered once after dismissal`() async throws {
        let handoff = QRScannerResultHandoff(settlingNanoseconds: 0)
        var deliveredResult: QRScannerResult?

        handoff.queue(.setupCode("review-demo"))
        let task = try #require(handoff.processAfterDismissal { deliveredResult = $0 })
        await task.value

        #expect(deliveredResult == .setupCode("review-demo"))
        #expect(handoff.processAfterDismissal { _ in } == nil)
    }

    @Test func `cancel prevents queued delivery`() async throws {
        let handoff = QRScannerResultHandoff(settlingNanoseconds: 1_000_000_000)
        var deliveredResult: QRScannerResult?

        handoff.queue(.setupCode("review-demo"))
        let task = try #require(handoff.processAfterDismissal { deliveredResult = $0 })
        handoff.cancel()
        await task.value

        #expect(deliveredResult == nil)
    }

    @Test func `beginning another scan clears stale result`() {
        let handoff = QRScannerResultHandoff(settlingNanoseconds: 0)

        handoff.queue(.setupCode("stale"))
        handoff.beginScan()

        #expect(handoff.processAfterDismissal { _ in } == nil)
    }
}
