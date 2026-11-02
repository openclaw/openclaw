#if DEBUG && os(iOS) && targetEnvironment(simulator)
import Foundation

/// Temporary screenshot investigation; remove with the diagnostic branch.
@MainActor
public enum ChatScreenshotDiagnostics {
    enum Metric: String, CaseIterable {
        case updateUIView, sizeThatFits, interactionUpdate, textDidChange
        case focusBegan, focusEnded, layoutSubviews
    }

    struct Counter: Codable, Sendable {
        var entered = 0
        var completed = 0
        var depth = 0
        var maxDepth = 0
        var totalMs = 0.0
        var maxMs = 0.0
        var firstStartedAt: Double?
        var lastStartedAt: Double?
        var lastCompletedAt: Double?
    }

    private static var writer: Writer?
    private static var counters: [String: Counter] = [:]

    public static func start() {
        guard self.writer == nil,
              ProcessInfo.processInfo.arguments.contains("--openclaw-screenshot-mode"),
              let prefix = ProcessInfo.processInfo.environment["OPENCLAW_AX_METRICS_PATH"]
        else { return }
        self.counters = Dictionary(uniqueKeysWithValues: Metric.allCases.map { ($0.rawValue, Counter()) })
        self.writer = Writer(path: "\(prefix)-\(ProcessInfo.processInfo.processIdentifier).jsonl")
    }

    static func begin(_ metric: Metric) -> Double? {
        guard self.writer != nil else { return nil }
        let now = ProcessInfo.processInfo.systemUptime
        var value = self.counters[metric.rawValue, default: Counter()]
        value.entered += 1
        value.depth += 1
        value.maxDepth = max(value.maxDepth, value.depth)
        value.firstStartedAt = value.firstStartedAt ?? now
        value.lastStartedAt = now
        self.counters[metric.rawValue] = value
        return now
    }

    static func end(_ metric: Metric, since started: Double?) {
        guard let started else { return }
        let now = ProcessInfo.processInfo.systemUptime
        var value = self.counters[metric.rawValue, default: Counter()]
        value.completed += 1
        value.depth -= 1
        let elapsed = (now - started) * 1000
        value.totalMs += elapsed
        value.maxMs = max(value.maxMs, elapsed)
        value.lastCompletedAt = now
        self.counters[metric.rawValue] = value
    }

    /// Mutable writer state belongs exclusively to this serial queue. Main-actor
    /// counters cross that boundary only as an immutable Sendable snapshot.
    private final class Writer: @unchecked Sendable {
        private let queue = DispatchQueue(label: "ai.openclaw.screenshot-responsiveness", qos: .utility)
        private let path: String
        private var file: FileHandle?
        private var timer: (any DispatchSourceTimer)?
        private var pendingAt: Double?
        private var lastMainAt: Double?
        private var lastTickAt: Double?
        private var ticks = 0
        private var closed = false
        private let startedAt = ProcessInfo.processInfo.systemUptime

        init(path: String) {
            self.path = path
            self.queue.async { self.startWriting() }
        }

        private func startWriting() {
            guard FileManager.default.createFile(atPath: self.path, contents: nil),
                  let file = try? FileHandle(forWritingTo: URL(fileURLWithPath: self.path))
            else {
                self.failWriting()
                return
            }
            self.file = file
            self.write(Record(event: "start"))
            guard !self.closed else { return }
            let timer = DispatchSource.makeTimerSource(queue: self.queue)
            timer.schedule(deadline: .now(), repeating: 1, leeway: .milliseconds(100))
            timer.setEventHandler { [weak self] in self?.tick() }
            self.timer = timer
            timer.resume()
        }

        private func tick() {
            guard !self.closed else { return }
            let now = ProcessInfo.processInfo.systemUptime
            if now - self.startedAt >= 120 || self.ticks >= 120 {
                self.write(Record(event: "deadline"))
                self.close()
                return
            }
            self.ticks += 1
            var record = Record(event: "background-tick")
            record.tick = self.ticks
            record.writerTickIntervalMs = self.lastTickAt.map { (now - $0) * 1000 }
            record.pendingAgeMs = self.pendingAt.map { (now - $0) * 1000 }
            record.lastMainAt = self.lastMainAt
            self.lastTickAt = now
            self.write(record)
            guard !self.closed, self.pendingAt == nil else { return }
            // File-writing time is separate from waiting for the main queue.
            let requestedAt = ProcessInfo.processInfo.systemUptime
            self.pendingAt = requestedAt
            DispatchQueue.main.async {
                // Stamp execution here, not on later delivery to the writer.
                let executedAt = ProcessInfo.processInfo.systemUptime
                let snapshot = ChatScreenshotDiagnostics.counters
                self.queue.async {
                    guard !self.closed else { return }
                    self.pendingAt = nil
                    self.lastMainAt = executedAt
                    var record = Record(event: "main-heartbeat")
                    record.mainRequestedAt = requestedAt
                    record.mainExecutedAt = executedAt
                    record.mainLatencyMs = (executedAt - requestedAt) * 1000
                    record.writerDeliveryDelayMs = (record.uptimeSeconds - executedAt) * 1000
                    record.counters = snapshot
                    self.write(record)
                }
            }
        }

        private func write(_ record: Record) {
            guard !self.closed else { return }
            do {
                var data = try JSONEncoder().encode(record)
                data.append(0x0A)
                try self.file?.write(contentsOf: data)
            } catch {
                self.failWriting()
            }
        }

        private func failWriting() {
            print("AX_DIAGNOSTIC_WRITE_FAILED")
            self.close()
        }

        private func close() {
            self.closed = true
            self.timer?.cancel()
            self.timer = nil
            try? self.file?.close()
            self.file = nil
        }
    }

    private struct Record: Encodable, Sendable {
        let schemaVersion = 1
        let event: String
        let pid = ProcessInfo.processInfo.processIdentifier
        let unixSeconds = Date().timeIntervalSince1970
        let uptimeSeconds = ProcessInfo.processInfo.systemUptime
        var tick: Int?
        var writerTickIntervalMs: Double?
        var pendingAgeMs: Double?
        var lastMainAt: Double?
        var mainRequestedAt: Double?
        var mainExecutedAt: Double?
        var mainLatencyMs: Double?
        var writerDeliveryDelayMs: Double?
        var counters: [String: Counter]?
    }
}
#endif
