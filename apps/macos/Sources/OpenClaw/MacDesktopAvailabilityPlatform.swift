import AppKit
import CoreFoundation
import Foundation
import IOKit
import IOKit.pwr_mgt

@MainActor
protocol MacDesktopAvailabilityPlatform {
    var uptime: TimeInterval { get }
    func consoleState() -> MacDesktopAvailabilityCoordinator.State
    func makeIdleAssertion(timeout: TimeInterval) -> UInt32?
    func releaseIdleAssertion(_ assertion: UInt32)
    func startMonitoring(_ changed: @escaping @MainActor @Sendable () -> Void) -> @MainActor () -> Void
}

@MainActor
final class LiveMacDesktopAvailabilityPlatform: MacDesktopAvailabilityPlatform {
    private var userActivityAssertions: [IOPMAssertionID: IOPMAssertionID] = [:]
    var uptime: TimeInterval {
        ProcessInfo.processInfo.systemUptime
    }

    func consoleState() -> MacDesktopAvailabilityCoordinator.State {
        let root = IORegistryGetRootEntry(kIOMainPortDefault)
        guard root != 0 else { return .unknown }
        defer { IOObjectRelease(root) }
        guard let users = IORegistryEntryCreateCFProperty(root, "IOConsoleUsers" as CFString, nil, 0)?
            .takeRetainedValue() as? [[String: Any]]
        else { return .unknown }
        return Self.consoleState(users: users, uid: getuid())
    }

    static func consoleState(users: [[String: Any]], uid: uid_t) -> MacDesktopAvailabilityCoordinator.State {
        let console = users.filter { Self.boolean($0["kCGSSessionOnConsoleKey"]) == true }
        guard console.count == 1, let user = console.first,
              let consoleUID = user["kCGSSessionUserIDKey"] as? NSNumber,
              let loggedIn = Self.boolean(user["kCGSessionLoginDoneKey"])
        else { return .unknown }
        guard loggedIn, consoleUID.uint32Value == uid, uid != 0 else { return .locked }
        // IOConsoleUsers omits this flag for a fully logged-in, unlocked console.
        guard let value = user["CGSSessionScreenIsLocked"] else { return .unlocked }
        guard let locked = Self.boolean(value) else { return .unknown }
        return locked ? .locked : .unlocked
    }

    private static func boolean(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }

    func makeIdleAssertion(timeout: TimeInterval) -> UInt32? {
        var assertion: IOPMAssertionID = 0
        let result = IOPMAssertionCreateWithDescription(
            kIOPMAssertPreventUserIdleDisplaySleep as CFString,
            "OpenClaw Computer use" as CFString,
            "An authorized desktop execution or opted-in worker host is active" as CFString,
            nil,
            nil,
            timeout,
            kIOPMAssertionTimeoutActionRelease as CFString,
            &assertion)
        guard result == kIOReturnSuccess else { return nil }
        var activity: IOPMAssertionID = 0
        // Display-idle prevention alone does not declare remote framebuffer activity.
        // Both assertions share the owner's short timeout and are released together.
        guard IOPMAssertionDeclareUserActivity(
            "OpenClaw remote desktop work" as CFString, kIOPMUserActiveRemote, &activity) == kIOReturnSuccess,
            IOPMAssertionSetProperty(
                activity,
                kIOPMAssertionTimeoutActionKey as CFString,
                kIOPMAssertionTimeoutActionRelease as CFString) == kIOReturnSuccess,
            IOPMAssertionSetProperty(
                activity, kIOPMAssertionTimeoutKey as CFString, NSNumber(value: timeout)) == kIOReturnSuccess
        else {
            IOPMAssertionRelease(assertion)
            if activity != 0 { IOPMAssertionRelease(activity) }
            return nil
        }
        self.userActivityAssertions[assertion] = activity
        return assertion
    }

    func releaseIdleAssertion(_ assertion: UInt32) {
        IOPMAssertionRelease(assertion)
        if let activity = self.userActivityAssertions.removeValue(forKey: assertion) {
            IOPMAssertionRelease(activity)
        }
    }

    func startMonitoring(_ changed: @escaping @MainActor @Sendable () -> Void) -> @MainActor () -> Void {
        let timer = Timer(timeInterval: 2, repeats: true) { _ in
            Task { @MainActor in changed() }
        }
        RunLoop.main.add(timer, forMode: .common)
        let workspace = NSWorkspace.shared.notificationCenter
        let workspaceObservers = [
            NSWorkspace.sessionDidBecomeActiveNotification,
            NSWorkspace.sessionDidResignActiveNotification,
            NSWorkspace.willSleepNotification,
            NSWorkspace.didWakeNotification,
        ].map { name in
            workspace.addObserver(forName: name, object: nil, queue: .main) { _ in
                Task { @MainActor in changed() }
            }
        }
        let distributed = DistributedNotificationCenter.default()
        let lockObservers = ["com.apple.screenIsLocked", "com.apple.screenIsUnlocked"].map { name in
            distributed.addObserver(forName: Notification.Name(name), object: nil, queue: .main) { _ in
                Task { @MainActor in changed() }
            }
        }
        return {
            timer.invalidate()
            workspaceObservers.forEach(workspace.removeObserver)
            lockObservers.forEach(distributed.removeObserver)
        }
    }
}
