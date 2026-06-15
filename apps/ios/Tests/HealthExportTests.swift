import Foundation
import Testing
@testable import OpenClaw

// MARK: - Mocks

private struct MockReader: HealthKitReading {
    var available: Bool = true
    var requested: Bool = true
    var batch: HealthExportBatch
    var newAnchor: Data?
    var readError: Error?

    func isHealthDataAvailable() -> Bool {
        self.available
    }

    func hasRequestedAuthorization() -> Bool {
        self.requested
    }

    func requestAuthorization() async throws {}
    func readNewSamples() async throws -> (batch: HealthExportBatch, newAnchor: Data?) {
        if let readError { throw readError }
        return (self.batch, self.newAnchor)
    }
}

private final class MockUploader: HealthWebhookUploading, @unchecked Sendable {
    var error: Error?
    private(set) var postCount = 0
    private(set) var lastBody: Data?

    init(error: Error? = nil) {
        self.error = error
    }

    func post(body: Data, config _: HealthWebhookConfig) async throws {
        self.postCount += 1
        self.lastBody = body
        if let error { throw error }
    }
}

// MARK: - URL validation

struct HealthExportURLValidationTests {
    @Test func `accepts https ts net`() {
        let url = HealthExportConfigStore.validatedURL(
            from: "https://my-host.tailnet-name.ts.net:8446/health/ingest")
        #expect(url != nil)
    }

    @Test func `rejects http`() {
        #expect(HealthExportConfigStore.validatedURL(from: "http://host.tail.ts.net/x") == nil)
    }

    @Test func `rejects non ts net`() {
        #expect(HealthExportConfigStore.validatedURL(from: "https://evil.example.com/health") == nil)
        #expect(HealthExportConfigStore.validatedURL(from: "https://ts.net.evil.com/x") == nil)
    }

    @Test func `rejects bare suffix and empty`() {
        #expect(HealthExportConfigStore.validatedURL(from: "https://.ts.net/x") == nil)
        #expect(HealthExportConfigStore.validatedURL(from: "") == nil)
        #expect(HealthExportConfigStore.validatedURL(from: "not a url") == nil)
    }
}

// MARK: - Date formatting

struct HealthExportDateFormatterTests {
    @Test func `formats UTC`() throws {
        // Build a known UTC instant deterministically rather than hardcoding an epoch.
        var components = DateComponents()
        components.year = 2026
        components.month = 6
        components.day = 15
        components.hour = 9
        components.minute = 30
        components.second = 0
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: "UTC"))
        let date = try #require(calendar.date(from: components))
        let string = HealthExportDateFormatter.string(from: date)
        #expect(string == "2026-06-15 09:30:00 +0000")
    }
}

// MARK: - Payload encoding

struct HealthExportPayloadTests {
    @Test func `encodes forced units and sleep minutes`() throws {
        let batch = HealthExportBatch(
            metrics: [
                .stepCount: [HealthMetricSample(quantity: 1234, date: "2026-06-15 10:00:00 +0000")],
                .heartRate: [HealthMetricSample(quantity: 72, date: "2026-06-15 10:00:00 +0000")],
            ],
            sleepMinutes: [HealthMetricSample(quantity: 432, date: "2026-06-15 07:00:00 +0000")],
            workouts: [])
        let data = try #require(HealthExportPayloadEncoder.encode(batch))
        let json = try #require(String(data: data, encoding: .utf8))
        // Forced units present
        #expect(json.contains("\"units\":\"bpm\""))
        #expect(json.contains("\"units\":\"count\""))
        // Sleep exported as numeric minutes metric, not a raw category
        #expect(json.contains("\"name\":\"SleepMinutes\""))
        #expect(json.contains("\"units\":\"min\""))
        #expect(json.contains("\"qty\":432"))
    }

    @Test func `sanitizes workout no GPS no metadata`() throws {
        let batch = HealthExportBatch(
            metrics: [:],
            sleepMinutes: [],
            workouts: [HealthWorkoutSample(
                id: "ABC",
                name: "Running",
                start: "2026-06-15 06:00:00 +0000",
                end: "2026-06-15 06:30:00 +0000",
                duration: 1800,
                distanceKm: 5.0,
                activeEnergyKcal: 300)])
        let data = try #require(HealthExportPayloadEncoder.encode(batch))
        let json = try #require(String(data: data, encoding: .utf8))
        #expect(json.contains("\"id\":\"ABC\""))
        #expect(json.contains("\"units\":\"km\""))
        #expect(json.contains("\"units\":\"kcal\""))
        // No metadata / route / latitude leaks
        #expect(!json.lowercased().contains("metadata"))
        #expect(!json.lowercased().contains("latitude"))
        #expect(!json.lowercased().contains("route"))
    }

    @Test func `empty batch encodes nil`() {
        #expect(HealthExportPayloadEncoder.encode(.empty) == nil)
    }
}

// MARK: - Orchestrator: HTTP outcome handling

// Serialized: these tests share `HealthExportFileStore` files + `HealthExportBackoff` defaults.
@MainActor
@Suite(.serialized)
struct HealthExportServiceTests {
    private func makeBatch() -> HealthExportBatch {
        HealthExportBatch(
            metrics: [.stepCount: [HealthMetricSample(quantity: 100, date: "2026-06-15 10:00:00 +0000")]],
            sleepMinutes: [],
            workouts: [])
    }

    /// Injected config so the orchestrator tests never depend on the Keychain.
    private func testConfig() -> HealthWebhookConfig {
        HealthWebhookConfig(
            url: URL(string: "https://test.tail.ts.net/health/ingest")!,
            token: "test-token")
    }

    private func reset() {
        HealthExportBackoff.reset()
        HealthExportFileStore.clearPendingPayload()
        HealthExportFileStore.clearAnchor()
    }

    @Test func `success advances anchor and sets success`() async {
        self.reset()
        defer { self.reset() }
        let uploader = MockUploader(error: nil)
        let reader = MockReader(batch: self.makeBatch(), newAnchor: Data([1, 2, 3]))
        let config = self.testConfig()
        let service = HealthExportService(reader: reader, uploader: uploader, configProvider: { config })

        await service.exportNow()

        #expect(uploader.postCount == 1)
        if case .success = service.status {} else {
            Issue.record("expected .success, got \(service.status)")
        }
        // Anchor advanced only on 2xx.
        #expect(HealthExportFileStore.loadAnchorData() == Data([1, 2, 3]))
        #expect(!HealthExportFileStore.hasPendingPayload())
    }

    @Test func `client error stops and does not advance anchor`() async {
        self.reset()
        defer { self.reset() }
        let uploader = MockUploader(error: HealthExportError.clientError(status: 401))
        let reader = MockReader(batch: self.makeBatch(), newAnchor: Data([9, 9]))
        let config = self.testConfig()
        let service = HealthExportService(reader: reader, uploader: uploader, configProvider: { config })

        await service.exportNow()

        if case .needsAttention = service.status {} else {
            Issue.record("expected .needsAttention, got \(service.status)")
        }
        // 4xx: anchor NOT advanced, no pending payload churn.
        #expect(HealthExportFileStore.loadAnchorData() == nil)
        #expect(HealthExportBackoff.currentAttempt() == 0)
    }

    @Test func `server error defers with backoff and persists pending`() async {
        self.reset()
        defer { self.reset() }
        let uploader = MockUploader(error: HealthExportError.serverOrNetwork(status: 503))
        let reader = MockReader(batch: self.makeBatch(), newAnchor: Data([7]))
        let config = self.testConfig()
        let service = HealthExportService(reader: reader, uploader: uploader, configProvider: { config })

        await service.exportNow()

        if case .retrying = service.status {} else {
            Issue.record("expected .retrying, got \(service.status)")
        }
        // 5xx: anchor NOT advanced, pending payload persisted, backoff incremented.
        #expect(HealthExportFileStore.loadAnchorData() == nil)
        #expect(HealthExportFileStore.hasPendingPayload())
        #expect(HealthExportBackoff.currentAttempt() == 1)
    }

    @Test func `nothing new when batch empty`() async {
        self.reset()
        defer { self.reset() }
        let uploader = MockUploader(error: nil)
        let reader = MockReader(batch: .empty, newAnchor: nil)
        let config = self.testConfig()
        let service = HealthExportService(reader: reader, uploader: uploader, configProvider: { config })

        await service.exportNow()

        #expect(uploader.postCount == 0)
        if case .nothingNew = service.status {} else {
            Issue.record("expected .nothingNew, got \(service.status)")
        }
    }
}

// MARK: - Backoff

struct HealthExportBackoffTests {
    @Test func `exponential and capped`() {
        HealthExportBackoff.reset()
        defer { HealthExportBackoff.reset() }
        let first = HealthExportBackoff.recordFailure()
        #expect(first == HealthExportBackoff.baseDelay)
        let second = HealthExportBackoff.recordFailure()
        #expect(second == HealthExportBackoff.baseDelay * 2)
        // Many failures stay capped at maxDelay and exhaust eventually.
        for _ in 0..<20 {
            _ = HealthExportBackoff.recordFailure()
        }
        #expect(HealthExportBackoff.hasExhaustedRetries())
    }
}
