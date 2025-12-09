import Cocoa
import Darwin
import Foundation
import OSLog

@MainActor
final class PresenceReporter {
    static let shared = PresenceReporter()

    private let logger = Logger(subsystem: "com.steipete.clawdis", category: "presence")
    private var task: Task<Void, Never>?
    private let interval: TimeInterval = 180 // a few minutes

    func start() {
        guard self.task == nil else { return }
        self.task = Task.detached { [weak self] in
            guard let self else { return }
            await self.push(reason: "launch")
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(self.interval * 1_000_000_000))
                await self.push(reason: "periodic")
            }
        }
    }

    func stop() {
        self.task?.cancel()
        self.task = nil
    }

    @Sendable
    private func push(reason: String) async {
        let mode = await MainActor.run { AppStateStore.shared.connectionMode.rawValue }
        let text = Self.composePresenceSummary(mode: mode, reason: reason)
        do {
            try await ControlChannel.shared.sendSystemEvent(text)
        } catch {
            self.logger.error("presence send failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Fire an immediate presence beacon (e.g., right after connecting).
    func sendImmediate(reason: String = "connect") {
        Task { await self.push(reason: reason) }
    }

    private static func composePresenceSummary(mode: String, reason: String) -> String {
        let host = Host.current().localizedName ?? "unknown-host"
        let ip = Self.primaryIPv4Address() ?? "ip-unknown"
        let version = Self.appVersionString()
        let lastInput = Self.lastInputSeconds()
        let lastLabel = lastInput.map { "last input \($0)s ago" } ?? "last input unknown"
        return "Node: \(host) (\(ip)) · app \(version) · \(lastLabel) · mode \(mode) · reason \(reason)"
    }

    private static func appVersionString() -> String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
        if let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String {
            return "\(version) (\(build))"
        }
        return version
    }

    private static func lastInputSeconds() -> Int? {
        let anyEvent = CGEventType(rawValue: UInt32.max) ?? .null
        let seconds = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: anyEvent)
        if seconds.isNaN || seconds.isInfinite || seconds < 0 { return nil }
        return Int(seconds.rounded())
    }

    private static func primaryIPv4Address() -> String? {
        var addrList: UnsafeMutablePointer<ifaddrs>? = nil
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
            let result = getnameinfo(&addr, socklen_t(ptr.pointee.ifa_addr.pointee.sa_len), &buffer, socklen_t(buffer.count), nil, 0, NI_NUMERICHOST)
            guard result == 0 else { continue }
            let len = buffer.prefix { $0 != 0 }
            let ip = String(decoding: len.map { UInt8(bitPattern: $0) }, as: UTF8.self)

            if name == "en0" { en0 = ip; break }
            if fallback == nil { fallback = ip }
        }

        return en0 ?? fallback
    }
}
