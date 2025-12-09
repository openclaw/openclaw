import ClawdisProtocol
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
    let isPreview: Bool

    @Published var instances: [InstanceInfo] = []
    @Published var lastError: String?
    @Published var statusMessage: String?
    @Published var isLoading = false

    private let logger = Logger(subsystem: "com.steipete.clawdis", category: "instances")
    private var task: Task<Void, Never>?
    private let interval: TimeInterval = 30
    private var observers: [NSObjectProtocol] = []

    private struct PresenceEventPayload: Codable {
        let presence: [PresenceEntry]
    }

    init(isPreview: Bool = false) {
        self.isPreview = isPreview
    }

    func start() {
        guard !self.isPreview else { return }
        guard self.task == nil else { return }
        self.observeGatewayEvents()
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
        for token in self.observers {
            NotificationCenter.default.removeObserver(token)
        }
        self.observers.removeAll()
    }

    private func observeGatewayEvents() {
        let ev = NotificationCenter.default.addObserver(
            forName: .gatewayEvent,
            object: nil,
            queue: .main)
        { [weak self] note in
            guard let self,
                  let frame = note.object as? GatewayFrame else { return }
            switch frame {
            case let .event(evt) where evt.event == "presence":
                if let payload = evt.payload {
                    Task { @MainActor [weak self] in self?.handlePresenceEventPayload(payload) }
                }
            default:
                break
            }
        }
        let gap = NotificationCenter.default.addObserver(
            forName: .gatewaySeqGap,
            object: nil,
            queue: .main)
        { [weak self] _ in
            guard let self else { return }
            Task { await self.refresh() }
        }
        let snap = NotificationCenter.default.addObserver(
            forName: .gatewaySnapshot,
            object: nil,
            queue: .main)
        { [weak self] note in
            guard let self,
                  let frame = note.object as? GatewayFrame else { return }
            switch frame {
            case let .helloOk(hello):
                if JSONSerialization.isValidJSONObject(hello.snapshot.presence),
                   let data = try? JSONEncoder().encode(hello.snapshot.presence)
                {
                    Task { @MainActor [weak self] in self?.decodeAndApplyPresenceData(data) }
                }
            default:
                break
            }
        }
        self.observers = [ev, snap, gap]
    }

    func refresh() async {
        if self.isLoading { return }
        self.statusMessage = nil
        self.isLoading = true
        defer { self.isLoading = false }
        do {
            PresenceReporter.shared.sendImmediate(reason: "instances-refresh")
            let data = try await ControlChannel.shared.request(method: "system-presence")
            self.lastPayload = data
            if data.isEmpty {
                self.logger.error("instances fetch returned empty payload")
                self.instances = [self.localFallbackInstance(reason: "no presence payload")]
                self.lastError = nil
                self.statusMessage = "No presence payload from gateway; showing local fallback + health probe."
                await self.probeHealthIfNeeded(reason: "no payload")
                return
            }
            let decoded = try JSONDecoder().decode([PresenceEntry].self, from: data)
            let withIDs = self.normalizePresence(decoded)
            if withIDs.isEmpty {
                self.instances = [self.localFallbackInstance(reason: "no presence entries")]
                self.lastError = nil
                self.statusMessage = "Presence list was empty; showing local fallback + health probe."
                await self.probeHealthIfNeeded(reason: "empty list")
            } else {
                self.instances = withIDs
                self.lastError = nil
                self.statusMessage = nil
            }
        } catch {
            self.logger.error(
                """
                instances fetch failed: \(error.localizedDescription, privacy: .public) \
                len=\(self.lastPayload?.count ?? 0, privacy: .public) \
                utf8=\(self.snippet(self.lastPayload), privacy: .public)
                """)
            self.instances = [self.localFallbackInstance(reason: "presence decode failed")]
            self.lastError = nil
            self.statusMessage = "Presence data invalid; showing local fallback + health probe."
            await self.probeHealthIfNeeded(reason: "decode failed")
        }
    }

    private func localFallbackInstance(reason: String) -> InstanceInfo {
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
            reason: reason,
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

    private func probeHealthIfNeeded(reason: String? = nil) async {
        do {
            let data = try await ControlChannel.shared.health(timeout: 8)
            guard let snap = decodeHealthSnapshot(from: data) else { return }
            let entry = InstanceInfo(
                id: "health-\(snap.ts)",
                host: "gateway (health)",
                ip: nil,
                version: nil,
                lastInputSeconds: nil,
                mode: "health",
                reason: "health probe",
                text: "Health ok · linked=\(snap.web.linked)",
                ts: snap.ts)
            if !self.instances.contains(where: { $0.id == entry.id }) {
                self.instances.insert(entry, at: 0)
            }
            self.lastError = nil
            self.statusMessage =
                "Presence unavailable (\(reason ?? "refresh")); showing health probe + local fallback."
        } catch {
            self.logger.error("instances health probe failed: \(error.localizedDescription, privacy: .public)")
            if let reason {
                self.statusMessage =
                    "Presence unavailable (\(reason)), health probe failed: \(error.localizedDescription)"
            }
        }
    }

    private func decodeAndApplyPresenceData(_ data: Data) {
        do {
            let decoded = try JSONDecoder().decode([PresenceEntry].self, from: data)
            self.applyPresence(decoded)
        } catch {
            self.logger.error("presence decode from event failed: \(error.localizedDescription, privacy: .public)")
            self.lastError = error.localizedDescription
        }
    }

    func handlePresenceEventPayload(_ payload: ClawdisProtocol.AnyCodable) {
        do {
            let payloadData = try JSONEncoder().encode(payload)
            let wrapper = try JSONDecoder().decode(PresenceEventPayload.self, from: payloadData)
            self.applyPresence(wrapper.presence)
        } catch {
            self.logger.error("presence event decode failed: \(error.localizedDescription, privacy: .public)")
            self.lastError = error.localizedDescription
        }
    }

    private func normalizePresence(_ entries: [PresenceEntry]) -> [InstanceInfo] {
        entries.map { entry -> InstanceInfo in
            let key = entry.host ?? entry.ip ?? entry.text ?? entry.instanceid ?? "entry-\(entry.ts)"
            return InstanceInfo(
                id: key,
                host: entry.host,
                ip: entry.ip,
                version: entry.version,
                lastInputSeconds: entry.lastinputseconds,
                mode: entry.mode,
                reason: entry.reason,
                text: entry.text ?? "Unnamed node",
                ts: Double(entry.ts))
        }
    }

    private func applyPresence(_ entries: [PresenceEntry]) {
        let withIDs = self.normalizePresence(entries)
        self.instances = withIDs
        self.statusMessage = nil
        self.lastError = nil
    }
}

extension InstancesStore {
    static func preview(instances: [InstanceInfo] = [
        InstanceInfo(
            id: "local",
            host: "steipete-mac",
            ip: "10.0.0.12",
            version: "1.2.3",
            lastInputSeconds: 12,
            mode: "local",
            reason: "preview",
            text: "Local node: steipete-mac (10.0.0.12) · app 1.2.3",
            ts: Date().timeIntervalSince1970 * 1000),
        InstanceInfo(
            id: "gateway",
            host: "gateway",
            ip: "100.64.0.2",
            version: "1.2.3",
            lastInputSeconds: 45,
            mode: "remote",
            reason: "preview",
            text: "Gateway node · tunnel ok",
            ts: Date().timeIntervalSince1970 * 1000 - 45000),
    ]) -> InstancesStore {
        let store = InstancesStore(isPreview: true)
        store.instances = instances
        store.statusMessage = "Preview data"
        return store
    }
}
