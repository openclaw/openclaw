import Foundation
import OSLog

struct InstanceInfo: Identifiable, Codable {
    let id: String
    let host: String?
    let ip: String?
    let version: String?
    let lastInputSeconds: Int?
    let mode: String?
    let reason: String?
    let text: String
    let ts: Double

    var ageDescription: String {
        let date = Date(timeIntervalSince1970: ts / 1000)
        return age(from: date)
    }

    var lastInputDescription: String {
        guard let secs = lastInputSeconds else { return "unknown" }
        return "\(secs)s ago"
    }
}

@MainActor
final class InstancesStore: ObservableObject {
    static let shared = InstancesStore()

    @Published var instances: [InstanceInfo] = []
    @Published var lastError: String?
    @Published var isLoading = false

    private let logger = Logger(subsystem: "com.steipete.clawdis", category: "instances")
    private var task: Task<Void, Never>?
    private let interval: TimeInterval = 30

    func start() {
        guard self.task == nil else { return }
        self.task = Task.detached { [weak self] in
            guard let self else { return }
            await self.refresh()
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(self.interval * 1_000_000_000))
                await self.refresh()
            }
        }
    }

    func stop() {
        self.task?.cancel()
        self.task = nil
    }

    func refresh() async {
        if self.isLoading { return }
        self.isLoading = true
        defer { self.isLoading = false }
        do {
            let data = try await ControlChannel.shared.request(method: "system-presence")
            let decoded = try JSONDecoder().decode([InstanceInfo].self, from: data)
            let withIDs = decoded.map { entry -> InstanceInfo in
                let key = entry.host ?? entry.ip ?? entry.text
                return InstanceInfo(
                    id: key,
                    host: entry.host,
                    ip: entry.ip,
                    version: entry.version,
                    lastInputSeconds: entry.lastInputSeconds,
                    mode: entry.mode,
                    reason: entry.reason,
                    text: entry.text,
                    ts: entry.ts)
            }
            self.instances = withIDs
            self.lastError = nil
        } catch {
            self.logger.error("instances fetch failed: \(error.localizedDescription, privacy: .public)")
            self.lastError = error.localizedDescription
        }
    }
}
