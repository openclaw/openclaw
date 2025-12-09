import Cocoa
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
            self.lastPayload = data
            if data.isEmpty {
                self.logger.error("instances fetch returned empty payload")
                self.instances = [self.localFallbackInstance()]
                self.lastError = "No presence data returned from relay yet."
                await self.probeHealthIfNeeded()
                return
            }
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
            if withIDs.isEmpty {
                self.instances = [self.localFallbackInstance()]
                self.lastError = nil
                await self.probeHealthIfNeeded()
            } else {
                self.instances = withIDs
                self.lastError = nil
            }
        } catch {
            self.logger.error(
                """
                instances fetch failed: \(error.localizedDescription, privacy: .public) \
                len=\(self.lastPayload?.count ?? 0, privacy: .public) \
                utf8=\(self.snippet(self.lastPayload), privacy: .public)
                """)
            self.instances = [self.localFallbackInstance()]
            self.lastError = "Decode failed: \(error.localizedDescription)"
            await self.probeHealthIfNeeded()
        }
    }

    private func localFallbackInstance() -> InstanceInfo {
        let host = Host.current().localizedName ?? "this-mac"
        let ip = Self.primaryIPv4Address()
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        let text = "Local node: \(host)\(ip.map { " (\($0))" } ?? "") · app \(version ?? "dev")"
        let ts = Date().timeIntervalSince1970 * 1000
        return InstanceInfo(
            id: "local-\(host)",
            host: host,
            ip: ip,
            version: version,
            lastInputSeconds: Self.lastInputSeconds(),
            mode: "local",
            reason: "fallback",
            text: text,
            ts: ts)
    }

    private static func lastInputSeconds() -> Int? {
        let anyEvent = CGEventType(rawValue: UInt32.max) ?? .null
        let seconds = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: anyEvent)
        if seconds.isNaN || seconds.isInfinite || seconds < 0 { return nil }
        return Int(seconds.rounded())
    }

    private static func primaryIPv4Address() -> String? {
        var addrList: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&addrList) == 0, let first = addrList else { return nil }
        defer { freeifaddrs(addrList) }

        var fallback: String?
        var en0: String?

        for ptr in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let flags = Int32(ptr.pointee.ifa_flags)
            let isUp = (flags & IFF_UP) != 0
            let isLoopback = (flags & IFF_LOOPBACK) != 0
            let name = String(cString: ptr.pointee.ifa_name)
            let family = ptr.pointee.ifa_addr.pointee.sa_family
            if !isUp || isLoopback || family != UInt8(AF_INET) { continue }

            var addr = ptr.pointee.ifa_addr.pointee
            var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let result = getnameinfo(
                &addr,
                socklen_t(ptr.pointee.ifa_addr.pointee.sa_len),
                &buffer,
                socklen_t(buffer.count),
                nil,
                0,
                NI_NUMERICHOST)
            guard result == 0 else { continue }
            let len = buffer.prefix { $0 != 0 }
            let bytes = len.map { UInt8(bitPattern: $0) }
            guard let ip = String(bytes: bytes, encoding: .utf8) else { continue }

            if name == "en0" { en0 = ip; break }
            if fallback == nil { fallback = ip }
        }

        return en0 ?? fallback
    }

    // MARK: - Helpers

    /// Keep the last raw payload for logging.
    private var lastPayload: Data?

    private func snippet(_ data: Data?, limit: Int = 256) -> String {
        guard let data else { return "<none>" }
        if data.isEmpty { return "<empty>" }
        let prefix = data.prefix(limit)
        if let asString = String(data: prefix, encoding: .utf8) {
            return asString.replacingOccurrences(of: "\n", with: " ")
        }
        return "<\(data.count) bytes non-utf8>"
    }

    private func probeHealthIfNeeded() async {
        do {
            let data = try await ControlChannel.shared.health(timeout: 8)
            guard let snap = decodeHealthSnapshot(from: data) else { return }
            let entry = InstanceInfo(
                id: "health-\(snap.ts)",
                host: "relay (health)",
                ip: nil,
                version: nil,
                lastInputSeconds: nil,
                mode: "health",
                reason: "health probe",
                text: "Health ok · linked=\(snap.web.linked) · ipc.exists=\(snap.ipc.exists)",
                ts: snap.ts)
            if !self.instances.contains(where: { $0.id == entry.id }) {
                self.instances.insert(entry, at: 0)
            }
            self.lastError = nil
        } catch {
            self.logger.error("instances health probe failed: \(error.localizedDescription, privacy: .public)")
        }
    }
}
