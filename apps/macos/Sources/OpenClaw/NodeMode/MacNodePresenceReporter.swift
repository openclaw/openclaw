import ApplicationServices
import Foundation

@MainActor
final class MacNodePresenceReporter {
    typealias Sender = @MainActor @Sendable (_ event: String, _ payloadJSON: String) async -> Bool
    typealias Clearer = @MainActor @Sendable () async -> ClearDeliveryResult
    typealias UnsupportedClearHandler = @MainActor @Sendable () -> Void
    typealias IdleSecondsProvider = @MainActor @Sendable () -> Int?

    enum ClearDeliveryResult: Equatable, Sendable {
        case cleared
        case retry
        case unsupported
    }

    private struct Payload: Codable {
        let idleSeconds: Int
        let saturated: Bool?
        let source: String?
    }

    private struct IdleSample {
        let seconds: Int
        let saturated: Bool
        let source: ActivitySource
    }

    private enum ActivitySource {
        case app
        case system
    }

    private struct DeliveryState {
        let sentAtMs: Int64
        let lastActiveAtMs: Int64
        let source: ActivitySource
    }

    private static let eventName = "node.presence.activity"
    private static let sampleInterval: TimeInterval = 2
    private static let activeReportIntervalMs: Int64 = 15000
    private static let keepaliveIntervalMs: Int64 = 180_000
    private static let maximumIdleSeconds = 30 * 24 * 60 * 60

    private var task: Task<Void, Never>?
    private var sender: Sender?
    private var clearer: Clearer?
    private var unsupportedClearHandler: UnsupportedClearHandler?
    private var delivery: DeliveryState?
    // The stored preference gates only system-wide sampling. App-local input is always eligible.
    private var reportingEnabled: Bool
    private var lastAppInputAt: ContinuousClock.Instant?
    private var clearPending = false
    private var hasDeliveredActivity = false
    private var unsupportedClearHandled = false
    private var generation: UInt64 = 0
    private var routeGeneration: UInt64 = 0
    private let idleSecondsProvider: IdleSecondsProvider

    init(
        reportingEnabled: Bool = AppDefaults.standard.bool(forKey: activeComputerPresenceEnabledKey),
        idleSecondsProvider: @escaping IdleSecondsProvider = {
            guard AXIsProcessTrusted() else { return nil }
            return SystemPresenceInfo.lastHardwareInputSeconds()
        })
    {
        self.reportingEnabled = reportingEnabled
        self.idleSecondsProvider = idleSecondsProvider
    }

    func start(
        sender: @escaping Sender,
        clearer: @escaping Clearer,
        onUnsupportedClear: @escaping UnsupportedClearHandler)
    {
        self.stop()
        self.sender = sender
        self.clearer = clearer
        self.unsupportedClearHandler = onUnsupportedClear
        // Registration creates a fresh server-side node session. Restore only activity
        // actually observed by this process, never treat connection as app interaction.
        self.updateSamplingTask(reportImmediately: true)
    }

    func recordAppActivity() {
        self.lastAppInputAt = .now
        self.updateSamplingTask(reportImmediately: true)
    }

    private func updateSamplingTask(reportImmediately: Bool = false) {
        guard self.sender != nil, self.reportingEnabled || self.lastAppInputAt != nil || self.clearPending else {
            SimpleTaskSupport.stop(task: &self.task)
            return
        }
        guard self.task == nil else { return }
        self.task = Task { [weak self] in
            if reportImmediately { await self?.reportCurrentState() }
            while await SimpleTaskSupport.waitForNextOperation(interval: Self.sampleInterval) {
                guard self != nil else { return }
                await self?.reportCurrentState()
            }
        }
    }

    func stop() {
        self.generation &+= 1
        self.routeGeneration &+= 1
        SimpleTaskSupport.stop(task: &self.task)
        self.sender = nil
        self.clearer = nil
        self.unsupportedClearHandler = nil
        self.delivery = nil
        self.clearPending = false
        self.hasDeliveredActivity = false
        self.unsupportedClearHandled = false
    }

    func setReportingEnabled(_ enabled: Bool) async {
        defer { self.updateSamplingTask() }
        if self.reportingEnabled == enabled {
            if !enabled, self.clearPending {
                await self.sendPendingClear()
            }
            return
        }

        self.reportingEnabled = enabled
        self.generation &+= 1
        self.delivery = nil
        if enabled {
            self.clearPending = false
            self.unsupportedClearHandled = false
            await self.reportCurrentState()
        } else {
            self.clearPending = self.hasDeliveredActivity
            await self.sendPendingClear()
            await self.reportCurrentState()
        }
    }

    private func currentSample() -> IdleSample? {
        let appSample = self.lastAppInputAt.map {
            Self.idleSample(seconds: Int($0.duration(to: .now).components.seconds), source: .app)
        }
        if self.reportingEnabled, let seconds = self.idleSecondsProvider() {
            let systemSample = Self.idleSample(seconds: seconds, source: .system)
            if let appSample, appSample.seconds < systemSample.seconds { return appSample }
            return systemSample
        }
        return appSample
    }

    private func reportCurrentState() async {
        guard !self.clearPending else {
            await self.sendPendingClear()
            return
        }
        guard let sample = self.currentSample() else {
            self.clearPending = self.hasDeliveredActivity
            await self.sendPendingClear()
            return
        }
        if self.delivery?.source != sample.source { self.delivery = nil }
        guard Self.shouldSend(
            idleSeconds: sample.seconds,
            saturated: sample.saturated,
            nowMs: Self.nowMs(),
            delivery: self.delivery)
        else { return }

        let nowMs = Self.nowMs()
        let lastActiveAtMs = max(0, nowMs - Int64(sample.seconds) * 1000)
        let payload = Payload(
            idleSeconds: sample.seconds,
            saturated: sample.saturated ? true : nil,
            source: sample.source == .app ? "app" : nil)
        guard let sender = self.sender,
              let data = try? JSONEncoder().encode(payload),
              let payloadJSON = String(data: data, encoding: .utf8)
        else { return }
        let generation = self.generation
        let routeGeneration = self.routeGeneration
        guard await sender(Self.eventName, payloadJSON) else { return }
        // Setting changes can cross this await and still belong to this route.
        // A stop/start cannot transfer the old route's delivery into the new one.
        guard routeGeneration == self.routeGeneration else { return }
        self.hasDeliveredActivity = true
        guard generation == self.generation else {
            self.delivery = nil
            if self.reportingEnabled {
                await self.reportCurrentState()
            } else {
                self.clearPending = self.hasDeliveredActivity
                await self.sendPendingClear()
            }
            return
        }
        // Permission can change while a send is suspended, without a preference change.
        guard self.currentSample()?.source == sample.source else {
            self.clearPending = self.hasDeliveredActivity
            await self.sendPendingClear()
            return
        }
        self.delivery = DeliveryState(sentAtMs: nowMs, lastActiveAtMs: lastActiveAtMs, source: sample.source)
    }

    private func sendPendingClear() async {
        // Clear the previous scope before publishing the app-only fallback.
        defer { self.updateSamplingTask() }
        guard self.clearPending,
              let clearer = self.clearer
        else { return }
        let generation = self.generation
        let routeGeneration = self.routeGeneration
        let result = await clearer()
        guard routeGeneration == self.routeGeneration else { return }
        guard generation == self.generation else {
            if self.reportingEnabled {
                self.clearPending = false
                self.delivery = nil
                await self.reportCurrentState()
            } else {
                self.clearPending = self.hasDeliveredActivity
                await self.sendPendingClear()
            }
            return
        }
        switch result {
        case .cleared:
            self.clearPending = false
            self.hasDeliveredActivity = false
            self.delivery = nil
            if self.currentSample() != nil { await self.reportCurrentState() }
        case .retry:
            break
        case .unsupported:
            self.clearPending = false
            self.hasDeliveredActivity = false
            guard !self.unsupportedClearHandled else { return }
            self.unsupportedClearHandled = true
            self.unsupportedClearHandler?()
        }
    }

    private static func idleSample(seconds: Int, source: ActivitySource) -> IdleSample {
        let bounded = min(max(0, seconds), self.maximumIdleSeconds)
        return IdleSample(seconds: bounded, saturated: seconds > self.maximumIdleSeconds, source: source)
    }

    private static func shouldSend(
        idleSeconds: Int,
        saturated: Bool,
        nowMs: Int64,
        delivery: DeliveryState?) -> Bool
    {
        guard let delivery else { return true }
        let elapsedMs = nowMs - delivery.sentAtMs
        if elapsedMs >= self.keepaliveIntervalMs {
            return true
        }
        if saturated {
            return false
        }
        let lastActiveAtMs = max(0, nowMs - Int64(idleSeconds) * 1000)
        return lastActiveAtMs > delivery.lastActiveAtMs && elapsedMs >= self.activeReportIntervalMs
    }

    private static func nowMs() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1000)
    }
}

#if DEBUG
extension MacNodePresenceReporter {
    static func _testShouldSend(
        idleSeconds: Int,
        nowMs: Int64,
        lastSentAtMs: Int64?,
        lastSentActiveAtMs: Int64?,
        saturated: Bool = false) -> Bool
    {
        let delivery: DeliveryState? = if let lastSentAtMs, let lastSentActiveAtMs {
            DeliveryState(sentAtMs: lastSentAtMs, lastActiveAtMs: lastSentActiveAtMs, source: .system)
        } else {
            nil
        }
        return self.shouldSend(
            idleSeconds: idleSeconds,
            saturated: saturated,
            nowMs: nowMs,
            delivery: delivery)
    }
}
#endif
