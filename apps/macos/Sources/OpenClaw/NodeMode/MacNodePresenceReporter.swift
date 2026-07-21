import ApplicationServices
import Foundation

@MainActor
final class MacNodePresenceReporter {
    typealias Sender = @MainActor @Sendable (_ event: String, _ payloadJSON: String) async -> Bool
    typealias IdleSecondsProvider = @MainActor @Sendable () -> Int?

    private struct Payload: Codable {
        let idleSeconds: Int
        let saturated: Bool?
    }

    private struct ClearPayload: Codable {
        let action = "clear"
    }

    private struct IdleSample {
        let seconds: Int
        let saturated: Bool
    }

    private struct DeliveryState {
        let sentAtMs: Int64
        let lastActiveAtMs: Int64
    }

    private static let eventName = "node.presence.activity"
    private static let sampleInterval = Duration.seconds(2)
    private static let activeReportIntervalMs: Int64 = 15000
    private static let keepaliveIntervalMs: Int64 = 180_000
    private static let maximumIdleSeconds = 30 * 24 * 60 * 60

    private var task: Task<Void, Never>?
    private var sender: Sender?
    private var delivery: DeliveryState?
    private var reportingEnabled: Bool
    private var clearPending = false
    private var generation: UInt64 = 0
    private let idleSecondsProvider: IdleSecondsProvider

    init(
        reportingEnabled: Bool = UserDefaults.standard.bool(forKey: activeComputerPresenceEnabledKey),
        idleSecondsProvider: @escaping IdleSecondsProvider = {
            guard AXIsProcessTrusted() else { return nil }
            return SystemPresenceInfo.lastHardwareInputSeconds()
        })
    {
        self.reportingEnabled = reportingEnabled
        self.idleSecondsProvider = idleSecondsProvider
    }

    func start(sender: @escaping Sender) {
        self.stop()
        self.sender = sender
        self.generation &+= 1
        self.clearPending = !self.reportingEnabled
        self.task = Task {
            while !Task.isCancelled {
                await self.reportCurrentState()
                try? await Task.sleep(for: Self.sampleInterval)
            }
        }
    }

    func stop() {
        self.generation &+= 1
        self.task?.cancel()
        self.task = nil
        self.sender = nil
        self.delivery = nil
        self.clearPending = false
    }

    func setReportingEnabled(_ enabled: Bool) async {
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
            await self.reportCurrentState()
        } else {
            self.clearPending = true
            await self.sendPendingClear()
        }
    }

    private func reportCurrentState() async {
        guard self.reportingEnabled else {
            await self.sendPendingClear()
            return
        }
        guard let seconds = self.idleSecondsProvider() else { return }
        let sample = Self.idleSample(seconds: seconds)
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
            saturated: sample.saturated ? true : nil)
        guard let sender = self.sender,
              let data = try? JSONEncoder().encode(payload),
              let payloadJSON = String(data: data, encoding: .utf8)
        else { return }
        let generation = self.generation
        guard await sender(Self.eventName, payloadJSON) else { return }
        guard generation == self.generation else {
            self.delivery = nil
            if self.reportingEnabled {
                await self.reportCurrentState()
            } else {
                self.clearPending = true
                await self.sendPendingClear()
            }
            return
        }
        guard self.reportingEnabled else {
            self.clearPending = true
            await self.sendPendingClear()
            return
        }
        self.delivery = DeliveryState(sentAtMs: nowMs, lastActiveAtMs: lastActiveAtMs)
    }

    private func sendPendingClear() async {
        guard self.clearPending,
              let sender = self.sender,
              let data = try? JSONEncoder().encode(ClearPayload()),
              let payloadJSON = String(data: data, encoding: .utf8)
        else { return }
        let generation = self.generation
        guard await sender(Self.eventName, payloadJSON) else { return }
        guard generation == self.generation else {
            if self.reportingEnabled {
                self.clearPending = false
                self.delivery = nil
                await self.reportCurrentState()
            } else {
                self.clearPending = true
                await self.sendPendingClear()
            }
            return
        }
        self.clearPending = false
    }

    private static func idleSample(seconds: Int) -> IdleSample {
        let bounded = min(max(0, seconds), self.maximumIdleSeconds)
        return IdleSample(seconds: bounded, saturated: seconds > self.maximumIdleSeconds)
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
            DeliveryState(sentAtMs: lastSentAtMs, lastActiveAtMs: lastSentActiveAtMs)
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
