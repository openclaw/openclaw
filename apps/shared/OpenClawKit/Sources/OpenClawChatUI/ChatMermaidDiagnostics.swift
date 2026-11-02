#if DEBUG && os(iOS) && targetEnvironment(simulator)
import Foundation

/// Temporary screenshot investigation; excluded from the production PR.
@MainActor
final class ChatMermaidDiagnostics {
    private let queue = DispatchQueue(label: "ai.openclaw.mermaid-diagnostic", qos: .utility)
    private let file: URL
    private var records = 0

    static func configured() -> ChatMermaidDiagnostics? {
        guard ProcessInfo.processInfo.arguments.contains("--openclaw-screenshot-mode"),
              let prefix = ProcessInfo.processInfo.environment["OPENCLAW_MERMAID_DIAGNOSTICS_PATH"]
        else { return nil }
        return ChatMermaidDiagnostics(file: URL(
            fileURLWithPath: "\(prefix)-\(ProcessInfo.processInfo.processIdentifier).jsonl"))
    }

    init(file: URL) {
        self.file = file
        self.record(event: "enabled", jobID: nil, phase: "setup", origin: "setup", category: "none", elapsedMs: 0)
    }

    func record(event: String, jobID: UUID?, phase: String, origin: String, category: String, elapsedMs: Double) {
        guard self.records < 64 else { return }
        self.records += 1
        // Producer clocks precede queue dispatch, keeping writer latency out of phase timing.
        let record = Record(
            sequence: self.records,
            event: event,
            jobID: jobID,
            phase: phase,
            origin: origin,
            category: category,
            elapsedMs: elapsedMs,
            unixSeconds: Date().timeIntervalSince1970,
            uptimeSeconds: ProcessInfo.processInfo.systemUptime,
            capped: self.records == 64)
        let file = self.file
        self.queue.async {
            do {
                var data = try JSONEncoder().encode(record)
                data.append(0x0A)
                if record.sequence == 1 {
                    try data.write(to: file, options: .atomic)
                } else {
                    let handle = try FileHandle(forWritingTo: file)
                    defer { try? handle.close() }
                    try handle.seekToEnd()
                    try handle.write(contentsOf: data)
                }
            } catch {
                print("MERMAID_DIAGNOSTIC_WRITE_FAILED")
            }
        }
    }

    static func category(_ failure: ChatMermaidFailure) -> String {
        switch failure {
        case .invalidRequest: "invalid_request"
        case .busy: "busy"
        case .unavailable: "unavailable"
        case .timedOut: "timed_out"
        case .invalidResult: "invalid_result"
        case .tooLarge: "too_large"
        case let .rendering(_, retryable): retryable ? "rendering_retryable" : "rendering_terminal"
        }
    }

    private struct Record: Encodable, Sendable {
        let schemaVersion = 1
        let sequence: Int
        let event: String
        let jobID: UUID?
        let phase: String
        let origin: String
        let category: String
        let elapsedMs: Double
        let unixSeconds: Double
        let uptimeSeconds: Double
        let capped: Bool
    }
}
#endif
