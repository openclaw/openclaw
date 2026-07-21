import Foundation
import Testing
@testable import OpenClaw

@MainActor
struct MacNodePresenceReporterTests {
    @Test func `active computer presence defaults off and honors explicit opt in`() throws {
        let suiteName = "MacNodePresenceReporterTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        #expect(!AppState.resolveActiveComputerPresenceEnabled(defaults: defaults))
        defaults.set(true, forKey: activeComputerPresenceEnabledKey)
        #expect(AppState.resolveActiveComputerPresenceEnabled(defaults: defaults))
    }

    @Test func `disabled reporter does not sample idle time`() async {
        let idleProbe = PresenceIdleProbe(seconds: 3)
        let sender = PresenceSenderRecorder()
        let reporter = MacNodePresenceReporter(
            reportingEnabled: false,
            idleSecondsProvider: idleProbe.read)
        reporter.start(sender: sender.send)
        await sender.waitForPayloadCount(1)
        reporter.stop()

        #expect(idleProbe.calls == 0)
        #expect(sender.payloadObjects.last?["action"] as? String == "clear")
    }

    @Test func `enabling sends an immediate activity sample`() async throws {
        let idleProbe = PresenceIdleProbe(seconds: 7)
        let sender = PresenceSenderRecorder()
        let reporter = MacNodePresenceReporter(
            reportingEnabled: false,
            idleSecondsProvider: idleProbe.read)
        reporter.start(sender: sender.send)
        await reporter.setReportingEnabled(true)
        reporter.stop()

        let payload = try #require(sender.payloadObjects.last)
        #expect(payload["idleSeconds"] as? Int == 7)
        #expect(payload["action"] == nil)
        #expect(idleProbe.calls == 1)
    }

    @Test func `disabling sends a same connection clear`() async throws {
        let sender = PresenceSenderRecorder()
        let reporter = MacNodePresenceReporter(
            reportingEnabled: false,
            idleSecondsProvider: { 0 })
        reporter.start(sender: sender.send)
        await reporter.setReportingEnabled(true)
        await reporter.setReportingEnabled(false)
        reporter.stop()

        let payload = try #require(sender.payloadObjects.last)
        #expect(payload["action"] as? String == "clear")
    }

    @Test func `failed clear retries while disabled`() async {
        let sender = PresenceSenderRecorder(outcomes: [false, true])
        let reporter = MacNodePresenceReporter(
            reportingEnabled: false,
            idleSecondsProvider: { 0 })
        reporter.start(sender: sender.send)
        await sender.waitForPayloadCount(1)
        await reporter.setReportingEnabled(false)
        reporter.stop()

        #expect(sender.payloadObjects.filter { $0["action"] as? String == "clear" }.count == 2)
    }

    @Test func `activity crossing opt out is followed by another clear`() async {
        let sender = SuspendingPresenceSender()
        let reporter = MacNodePresenceReporter(
            reportingEnabled: true,
            idleSecondsProvider: { 0 })
        reporter.start(sender: sender.send)
        await sender.waitForActivitySend()

        await reporter.setReportingEnabled(false)
        sender.finishActivitySend()
        await sender.waitForClearCount(2)
        reporter.stop()

        #expect(sender.payloadObjects.last?["action"] as? String == "clear")
    }

    @Test func `activity crossing disable and re-enable refreshes the enabled sample`() async {
        let sender = SuspendingPresenceSender()
        let reporter = MacNodePresenceReporter(
            reportingEnabled: true,
            idleSecondsProvider: { 0 })
        reporter.start(sender: sender.send)
        await sender.waitForActivitySend()

        await reporter.setReportingEnabled(false)
        await reporter.setReportingEnabled(true)
        sender.finishActivitySend()
        await sender.waitForActivityCount(3)
        reporter.stop()

        #expect(sender.payloadObjects.last?["idleSeconds"] as? Int == 0)
    }

    @Test func `first activity sample sends immediately`() {
        #expect(MacNodePresenceReporter._testShouldSend(
            idleSeconds: 0,
            nowMs: 100_000,
            lastSentAtMs: nil,
            lastSentActiveAtMs: nil))
    }

    @Test func `continuous activity is throttled and then refreshed`() {
        #expect(!MacNodePresenceReporter._testShouldSend(
            idleSeconds: 0,
            nowMs: 110_000,
            lastSentAtMs: 100_000,
            lastSentActiveAtMs: 100_000))
        #expect(MacNodePresenceReporter._testShouldSend(
            idleSeconds: 0,
            nowMs: 115_000,
            lastSentAtMs: 100_000,
            lastSentActiveAtMs: 100_000))
    }

    @Test func `idle presence gets a sparse keepalive`() {
        #expect(!MacNodePresenceReporter._testShouldSend(
            idleSeconds: 100,
            nowMs: 200_000,
            lastSentAtMs: 100_000,
            lastSentActiveAtMs: 100_000))
        #expect(!MacNodePresenceReporter._testShouldSend(
            idleSeconds: 2_592_000,
            nowMs: 115_000,
            lastSentAtMs: 100_000,
            lastSentActiveAtMs: 100_000,
            saturated: true))
        #expect(MacNodePresenceReporter._testShouldSend(
            idleSeconds: 180,
            nowMs: 280_000,
            lastSentAtMs: 100_000,
            lastSentActiveAtMs: 100_000))
    }
}

@MainActor
private final class PresenceIdleProbe {
    let seconds: Int
    private(set) var calls = 0

    init(seconds: Int) {
        self.seconds = seconds
    }

    func read() -> Int? {
        self.calls += 1
        return self.seconds
    }
}

@MainActor
private final class PresenceSenderRecorder {
    private var outcomes: [Bool]
    private(set) var payloads: [String] = []

    init(outcomes: [Bool] = []) {
        self.outcomes = outcomes
    }

    var payloadObjects: [[String: Any]] {
        self.payloads.compactMap { payload in
            guard let data = payload.data(using: .utf8) else { return nil }
            return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        }
    }

    func send(_: String, _ payload: String) async -> Bool {
        self.payloads.append(payload)
        return self.outcomes.isEmpty ? true : self.outcomes.removeFirst()
    }

    func waitForPayloadCount(_ expected: Int) async {
        for _ in 0..<1000 {
            if self.payloads.count >= expected { return }
            await Task.yield()
        }
        Issue.record("timed out waiting for \(expected) presence payloads")
    }
}

@MainActor
private final class SuspendingPresenceSender {
    private var activityContinuation: CheckedContinuation<Bool, Never>?
    private var hasSuspendedActivity = false
    private(set) var payloads: [String] = []

    var payloadObjects: [[String: Any]] {
        self.payloads.compactMap { payload in
            guard let data = payload.data(using: .utf8) else { return nil }
            return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        }
    }

    func send(_: String, _ payload: String) async -> Bool {
        self.payloads.append(payload)
        guard self.payloadObjects.last?["idleSeconds"] != nil, !self.hasSuspendedActivity else {
            return true
        }
        self.hasSuspendedActivity = true
        return await withCheckedContinuation { continuation in
            self.activityContinuation = continuation
        }
    }

    func waitForActivitySend() async {
        for _ in 0..<1000 {
            if self.activityContinuation != nil { return }
            await Task.yield()
        }
        Issue.record("timed out waiting for suspended activity send")
    }

    func finishActivitySend() {
        self.activityContinuation?.resume(returning: true)
        self.activityContinuation = nil
    }

    func waitForClearCount(_ expected: Int) async {
        for _ in 0..<1000 {
            if self.payloadObjects.filter({ $0["action"] as? String == "clear" }).count >= expected { return }
            await Task.yield()
        }
        Issue.record("timed out waiting for \(expected) presence clears")
    }

    func waitForActivityCount(_ expected: Int) async {
        for _ in 0..<1000 {
            if self.payloadObjects.filter({ $0["idleSeconds"] != nil }).count >= expected { return }
            await Task.yield()
        }
        Issue.record("timed out waiting for \(expected) activity samples")
    }
}
