import Foundation

@MainActor
final class MacDesktopIdleAssertion {
    private static let lifetime: TimeInterval = 15
    private static let refreshInterval: TimeInterval = 5

    private let platform: any MacDesktopAvailabilityPlatform
    private var assertion: UInt32?
    private var refreshAt: TimeInterval = 0
    private var retired = false

    init(platform: any MacDesktopAvailabilityPlatform) {
        self.platform = platform
    }

    isolated deinit {
        self.release()
    }

    var isHeld: Bool {
        self.assertion != nil
    }

    func refresh(until deadline: TimeInterval? = nil) -> Bool {
        guard !self.retired else { return false }
        let now = self.platform.uptime
        guard self.assertion == nil || now >= self.refreshAt else { return true }
        let remaining = deadline.map { min(Self.lifetime, $0 - now) } ?? Self.lifetime
        guard remaining > 0 else {
            self.release()
            return false
        }
        let previous = self.assertion
        self.assertion = self.platform.makeIdleAssertion(timeout: remaining)
        if let previous { self.platform.releaseIdleAssertion(previous) }
        self.refreshAt = now + min(Self.refreshInterval, remaining)
        return self.isHeld
    }

    func release() {
        guard let assertion = self.assertion else { return }
        self.assertion = nil
        self.platform.releaseIdleAssertion(assertion)
    }

    func retire() {
        self.retired = true
        self.release()
    }
}
