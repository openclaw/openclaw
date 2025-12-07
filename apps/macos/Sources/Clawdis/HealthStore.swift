import Foundation
import SwiftUI

struct HealthSnapshot: Codable, Sendable {
    struct Web: Codable, Sendable {
        struct Connect: Codable, Sendable {
            let ok: Bool
            let status: Int?
            let error: String?
            let elapsedMs: Double?
        }

        let linked: Bool
        let authAgeMs: Double?
        let connect: Connect?
    }

    struct SessionInfo: Codable, Sendable {
        let key: String
        let updatedAt: Double?
        let age: Double?
    }

    struct Sessions: Codable, Sendable {
        let path: String
        let count: Int
        let recent: [SessionInfo]
    }

    struct IPC: Codable, Sendable {
        let path: String
        let exists: Bool
    }

    let ts: Double
    let durationMs: Double
    let web: Web
    let heartbeatSeconds: Int?
    let sessions: Sessions
    let ipc: IPC
}

enum HealthState: Equatable {
    case unknown
    case ok
    case linkingNeeded
    case degraded(String)

    var tint: Color {
        switch self {
        case .ok: .green
        case .linkingNeeded: .red
        case .degraded: .orange
        case .unknown: .secondary
        }
    }
}

@MainActor
final class HealthStore: ObservableObject {
    static let shared = HealthStore()

    @Published private(set) var snapshot: HealthSnapshot?
    @Published private(set) var lastSuccess: Date?
    @Published private(set) var lastError: String?
    @Published private(set) var isRefreshing = false

    private var loopTask: Task<Void, Never>?
    private let refreshInterval: TimeInterval = 60

    private init() {
        self.start()
    }

    func start() {
        guard self.loopTask == nil else { return }
        self.loopTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                await self.refresh()
                try? await Task.sleep(nanoseconds: UInt64(self.refreshInterval * 1_000_000_000))
            }
        }
    }

    func stop() {
        self.loopTask?.cancel()
        self.loopTask = nil
    }

    func refresh(onDemand: Bool = false) async {
        guard !self.isRefreshing else { return }
        self.isRefreshing = true
        defer { self.isRefreshing = false }

        let response = await ShellRunner.run(
            command: CommandResolver.clawdisCommand(subcommand: "health", extraArgs: ["--json"]),
            cwd: nil,
            env: nil,
            timeout: 15)

        guard response.ok, let data = response.payload, !data.isEmpty else {
            self.lastError = response.message ?? "health probe failed"
            if onDemand { self.snapshot = nil }
            return
        }

        do {
            let decoded = try JSONDecoder().decode(HealthSnapshot.self, from: data)
            self.snapshot = decoded
            self.lastSuccess = Date()
            self.lastError = nil
        } catch {
            self.lastError = error.localizedDescription
            if onDemand { self.snapshot = nil }
        }
    }

    var state: HealthState {
        guard let snap = self.snapshot else { return .unknown }
        if !snap.web.linked { return .linkingNeeded }
        if let connect = snap.web.connect, !connect.ok {
            let reason = connect.error ?? "connect failed"
            return .degraded(reason)
        }
        return .ok
    }

    var summaryLine: String {
        if self.isRefreshing { return "Health check running…" }
        if let error = self.lastError { return "Health check failed: \(error)" }
        guard let snap = self.snapshot else { return "Health check pending" }
        if !snap.web.linked { return "Not linked — run clawdis login" }
        let auth = snap.web.authAgeMs.map { msToAge($0) } ?? "unknown"
        if let connect = snap.web.connect, !connect.ok {
            let code = connect.status.map(String.init) ?? "?"
            return "Link stale? status \(code)"
        }
        return "linked · auth \(auth) · socket ok"
    }
}

func msToAge(_ ms: Double) -> String {
    let minutes = Int(round(ms / 60000))
    if minutes < 1 { return "just now" }
    if minutes < 60 { return "\(minutes)m" }
    let hours = Int(round(Double(minutes) / 60))
    if hours < 48 { return "\(hours)h" }
    let days = Int(round(Double(hours) / 24))
    return "\(days)d"
}
