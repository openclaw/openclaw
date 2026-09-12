import Foundation
import Testing
@testable import OpenClaw

@MainActor
struct MacDesktopAvailabilityCoordinatorTests {
    typealias Owner = MacDesktopAvailabilityCoordinator

    private func withOwner(_ body: (Owner, DesktopPlatformProbe) throws -> Void) throws {
        let suite = "MacDesktopAvailabilityCoordinatorTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let platform = DesktopPlatformProbe()
        let owner = Owner(defaults: defaults, platform: platform)
        defer { owner.stop() }
        try body(owner, platform)
    }

    @Test func `execution assertion survives ordinary invocation completion and cancellation`() throws {
        try self.withOwner { owner, platform in
            owner.setRoute(generation: 1, connected: true, hostingEnabled: false)
            #expect(platform.assertions.isEmpty)
            let first = try owner.admit(executionId: "execution-one")
            owner.finishInvocation(first)
            let second = try owner.admit(executionId: "execution-one")
            #expect(first == second)
            #expect(platform.assertions.count == 1)

            let close = try #require(owner.beginClose(executionId: "execution-one"))
            #expect(platform.assertions.isEmpty)
            owner.finishClose(close)
            let oneShot = try owner.admit(executionId: nil)
            #expect(platform.assertions.count == 1)
            owner.finishInvocation(oneShot)
            #expect(platform.assertions.isEmpty)
        }
    }

    @Test func `closing reservation blocks stale admission and old close cannot retire a successor`() throws {
        try self.withOwner { owner, platform in
            owner.setRoute(generation: 1, connected: true, hostingEnabled: false)
            let first = try owner.admit(executionId: "execution")
            #expect(owner.beginClose(executionId: "unrelated") == nil)
            #expect(platform.assertions.count == 1)
            #expect(throws: Owner.AvailabilityError.executionClosed) { try owner.admit(executionId: "unrelated") }
            #expect(owner.beginClose(executionId: "unrelated") == nil)
            let close = try #require(owner.beginClose(executionId: "execution"))
            #expect(platform.assertions.isEmpty)
            #expect(throws: Owner.AvailabilityError.executionClosed) { try owner.validate(first) }
            #expect(throws: Owner.AvailabilityError.executionClosed) { try owner.admit(executionId: "execution") }
            #expect(owner.beginClose(executionId: "execution") == nil)
            owner.finishClose(close)
            let successor = try owner.admit(executionId: "execution")
            owner.finishClose(close)
            try owner.validate(successor)
            #expect(platform.assertions.count == 1)
        }
    }

    @Test func `exact permit invalidation retires suspended admission without touching a successor`() throws {
        try self.withOwner { owner, platform in
            var revoked: [[String]] = []
            owner.onExecutionsRevoked = { permits, _ in revoked.append(permits.compactMap(\.executionId)) }
            owner.setRoute(generation: 1, connected: true, hostingEnabled: false)
            let stale = try owner.admit(executionId: "execution")
            owner.invalidate(stale, reason: "stale-admission")
            #expect(platform.assertions.isEmpty)
            #expect(revoked == [["execution"]])
            #expect(owner.isRevoked(stale))
            #expect(throws: Owner.AvailabilityError.executionClosed) { try owner.validate(stale) }
            let close = try #require(owner.beginClose(executionId: "execution"))
            #expect(!owner.isRevoked(stale))
            owner.finishClose(close)
            let successor = try owner.admit(executionId: "execution")
            let assertion = platform.assertions
            owner.invalidate(stale, reason: "late-stale-admission")
            #expect(platform.assertions == assertion)
            #expect(revoked.count == 1)
            #expect(!owner.isRevoked(stale))
            try owner.validate(successor)
        }
    }

    @Test func `close tombstone overflow blocks new admission until a new route`() throws {
        try self.withOwner { owner, platform in
            owner.setRoute(generation: 1, connected: true, hostingEnabled: false)
            let existing = try owner.admit(executionId: "existing")
            for index in 0..<128 {
                #expect(owner.beginClose(executionId: "closed-\(index)") == nil)
            }
            try owner.validate(existing)
            try owner.finishClose(#require(owner.beginClose(executionId: "existing")))
            #expect(platform.assertions.isEmpty)
            #expect(throws: Owner.AvailabilityError.capacity) { try owner.admit(executionId: "closed-127") }
            #expect(throws: Owner.AvailabilityError.capacity) { try owner.admit(executionId: "fresh") }
            owner.setRoute(generation: 2, connected: true, hostingEnabled: false)
            _ = try owner.admit(executionId: "fresh")
            #expect(platform.assertions.count == 1)
        }
    }

    @Test(arguments: [Owner.State.locked, .unknown])
    func `unavailable console revokes execution without reviving it on unlock`(_ unavailable: Owner.State) throws {
        try self.withOwner { owner, platform in
            var revoked: [[String]] = []
            var states: [Owner.State] = []
            owner.onExecutionsRevoked = { permits, _ in revoked.append(permits.compactMap(\.executionId)) }
            owner.onStateChanged = { states.append($0) }
            owner.setRoute(generation: 1, connected: true, hostingEnabled: false)
            let permit = try owner.admit(executionId: "execution")
            platform.state = unavailable
            platform.invalidate()
            #expect(platform.assertions.isEmpty)
            #expect(revoked == [["execution"]])
            platform.invalidate()
            #expect(revoked.count == 1)
            platform.state = .unlocked
            platform.invalidate()
            #expect(platform.assertions.isEmpty)
            #expect(throws: Owner.AvailabilityError.executionClosed) { try owner.validate(permit) }
            #expect(throws: Owner.AvailabilityError.executionClosed) { try owner.admit(executionId: "execution") }
            #expect(states == [.unlocked, unavailable, .unlocked])
            try owner.finishClose(#require(owner.beginClose(executionId: "execution")))
            _ = try owner.admit(executionId: "execution")
            #expect(platform.assertions.count == 1)
        }
    }

    @Test func `execution deadline stays fixed while short OS assertions renew`() throws {
        try self.withOwner { owner, platform in
            var reasons: [String] = []
            owner.onExecutionsRevoked = { _, reason in reasons.append(reason) }
            owner.setRoute(generation: 1, connected: true, hostingEnabled: false)
            let permit = try owner.admit(executionId: "execution")
            #expect(platform.timeouts == [15])
            platform.uptime = 5
            try owner.validate(permit)
            #expect(platform.timeouts == [15, 15])
            #expect(platform.assertions.count == 1)
            platform.uptime = 3599
            _ = try owner.admit(executionId: "execution")
            #expect(platform.timeouts.last == 1)
            platform.uptime = 3600
            platform.invalidate()
            #expect(platform.assertions.isEmpty)
            #expect(reasons == ["execution-expired"])
            #expect(throws: Owner.AvailabilityError.executionClosed) { try owner.admit(executionId: "execution") }
        }
    }

    @Test func `retired route and delayed cleanup cannot regain or remove successor authority`() throws {
        try self.withOwner { owner, platform in
            owner.setRoute(generation: 7, connected: true, hostingEnabled: false)
            let old = try owner.admit(executionId: "execution")
            owner.revoke(generation: 7, reason: "disconnect")
            #expect(platform.assertions.isEmpty)
            #expect(!platform.monitoring)
            owner.setRoute(generation: 7, connected: true, hostingEnabled: true)
            #expect(throws: Owner.AvailabilityError.unavailable) { try owner.validate(old) }
            owner.setRoute(generation: 8, connected: true, hostingEnabled: false)
            #expect(owner.isRevoked(old))
            #expect(throws: Owner.AvailabilityError.executionClosed) { try owner.admit(executionId: "execution") }
            #expect(owner.beginRevocationCleanup(old))
            #expect(owner.beginClose(executionId: "execution") == nil)
            owner.finishRevocationCleanup(old, succeeded: true)
            let successor = try owner.admit(executionId: "execution")
            owner.revoke(generation: 7, reason: "late-disconnect")
            owner.finishClose(old)
            #expect(throws: Owner.AvailabilityError.executionClosed) { try owner.validate(old) }
            try owner.validate(successor)
            #expect(platform.assertions.count == 1)
            #expect(platform.monitoring)
        }
    }

    @Test(arguments: [Owner.State.locked, .unknown])
    func `legacy input survives one shot power completion but is retired at the desktop boundary`(
        _ unavailable: Owner.State) throws
    {
        try self.withOwner { owner, platform in
            var revoked: [Owner.Permit] = []
            owner.onExecutionsRevoked = { permits, _ in revoked.append(contentsOf: permits) }
            owner.setRoute(generation: 1, connected: true, hostingEnabled: false)
            let down = try owner.admit(executionId: nil)
            owner.finishInvocation(down)
            let move = try owner.admit(executionId: nil)
            #expect(down.inputScopeId == move.inputScopeId)
            owner.finishInvocation(move)
            #expect(platform.assertions.isEmpty)
            platform.state = unavailable
            platform.invalidate()
            #expect(revoked.count == 1)
            #expect(revoked.first?.inputScopeId == down.inputScopeId)
            platform.state = .unlocked
            platform.invalidate()
            let next = try owner.admit(executionId: nil)
            #expect(next.inputScopeId != down.inputScopeId)
            #expect(owner.beginRevocationCleanup(move))
            owner.finishRevocationCleanup(move, succeeded: true)
            try owner.validate(next)
        }
    }

    @Test func `unattended assertion requires opt in and live hosting and resumes only after actual unlock`() throws {
        try self.withOwner { owner, platform in
            #expect(!owner.unattendedEnabled)
            owner.setRoute(generation: 1, connected: true, hostingEnabled: true)
            #expect(platform.assertions.isEmpty)
            owner.setUnattendedEnabled(true)
            #expect(platform.assertions.count == 1)
            owner.setRoute(generation: 1, connected: true, hostingEnabled: false)
            #expect(platform.assertions.isEmpty)
            owner.setRoute(generation: 1, connected: true, hostingEnabled: true)
            let execution = try owner.admit(executionId: "execution")
            platform.state = .locked
            platform.invalidate()
            #expect(platform.assertions.isEmpty)
            platform.state = .unlocked
            platform.invalidate()
            #expect(platform.assertions.count == 1)
            #expect(throws: Owner.AvailabilityError.executionClosed) { try owner.validate(execution) }
            owner.setUnattendedEnabled(false)
            #expect(platform.assertions.isEmpty)
        }
    }

    @Test func `failed assertion renewal releases the old assertion and revokes execution`() throws {
        try self.withOwner { owner, platform in
            owner.setRoute(generation: 1, connected: true, hostingEnabled: false)
            platform.assertionCreationSucceeds = false
            #expect(throws: Owner.AvailabilityError.assertionFailed) { try owner.admit(executionId: "failed") }
            #expect(platform.assertions.isEmpty)
            platform.assertionCreationSucceeds = true
            let permit = try owner.admit(executionId: "execution")
            platform.assertionCreationSucceeds = false
            platform.uptime = 5
            platform.invalidate()
            #expect(platform.assertions.isEmpty)
            platform.assertionCreationSucceeds = true
            #expect(throws: Owner.AvailabilityError.executionClosed) { try owner.validate(permit) }
            #expect(platform.assertions.isEmpty)
        }
    }

    @Test func `owner deallocation stops monitoring and releases power`() throws {
        let suite = "MacDesktopAvailabilityDeinit.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let platform = DesktopPlatformProbe()
        var owner: Owner? = Owner(defaults: defaults, platform: platform)
        owner?.setRoute(generation: 1, connected: true, hostingEnabled: false)
        _ = try owner?.admit(executionId: "execution")
        #expect(platform.monitoring)
        owner = nil
        #expect(!platform.monitoring)
        #expect(platform.assertions.isEmpty)
    }

    @Test func `console evidence recognizes an omitted unlocked flag only for a valid logged in user`() {
        let unlocked: [String: Any] = [
            "kCGSSessionOnConsoleKey": true,
            "kCGSSessionUserIDKey": 501,
            "kCGSessionLoginDoneKey": true,
            "CGSSessionScreenIsLocked": false,
        ]
        #expect(LiveMacDesktopAvailabilityPlatform.consoleState(users: [unlocked], uid: 501) == .unlocked)
        #expect(LiveMacDesktopAvailabilityPlatform.consoleState(users: [unlocked], uid: 502) == .locked)
        #expect(LiveMacDesktopAvailabilityPlatform.consoleState(users: [], uid: 501) == .unknown)
        #expect(LiveMacDesktopAvailabilityPlatform.consoleState(users: [unlocked, unlocked], uid: 501) == .unknown)
        for (field, value, expected) in [
            ("CGSSessionScreenIsLocked", true, Owner.State.locked),
            ("kCGSessionLoginDoneKey", false, .locked),
            ("kCGSSessionOnConsoleKey", false, .unknown),
        ] {
            var changed = unlocked
            changed[field] = value
            #expect(LiveMacDesktopAvailabilityPlatform.consoleState(users: [changed], uid: 501) == expected)
        }
        var missing = unlocked
        missing.removeValue(forKey: "CGSSessionScreenIsLocked")
        #expect(LiveMacDesktopAvailabilityPlatform.consoleState(users: [missing], uid: 501) == .unlocked)
        missing["CGSSessionScreenIsLocked"] = "invalid"
        #expect(LiveMacDesktopAvailabilityPlatform.consoleState(users: [missing], uid: 501) == .unknown)
        missing.removeValue(forKey: "CGSSessionScreenIsLocked")
        missing.removeValue(forKey: "kCGSessionLoginDoneKey")
        #expect(LiveMacDesktopAvailabilityPlatform.consoleState(users: [missing], uid: 501) == .unknown)
        for field in ["kCGSSessionOnConsoleKey", "kCGSessionLoginDoneKey", "CGSSessionScreenIsLocked"] {
            var malformed = unlocked
            malformed[field] = NSNumber(value: field == "CGSSessionScreenIsLocked" ? 0 : 1)
            #expect(LiveMacDesktopAvailabilityPlatform.consoleState(users: [malformed], uid: 501) == .unknown)
        }
    }
}

@MainActor
final class DesktopPlatformProbe: MacDesktopAvailabilityPlatform {
    var uptime: TimeInterval = 0
    var state: MacDesktopAvailabilityCoordinator.State = .unlocked
    var assertionCreationSucceeds = true
    var assertions: Set<UInt32> = []
    var timeouts: [TimeInterval] = []
    var monitoring: Bool {
        self.changed != nil
    }

    private var nextAssertion: UInt32 = 0
    private var changed: (@MainActor @Sendable () -> Void)?

    func consoleState() -> MacDesktopAvailabilityCoordinator.State {
        self.state
    }

    func makeIdleAssertion(timeout: TimeInterval) -> UInt32? {
        guard self.assertionCreationSucceeds else { return nil }
        self.nextAssertion += 1
        self.assertions.insert(self.nextAssertion)
        self.timeouts.append(timeout)
        return self.nextAssertion
    }

    func releaseIdleAssertion(_ assertion: UInt32) {
        self.assertions.remove(assertion)
    }

    func startMonitoring(_ changed: @escaping @MainActor @Sendable () -> Void) -> @MainActor () -> Void {
        self.changed = changed
        return { self.changed = nil }
    }

    func invalidate() {
        self.changed?()
    }
}
