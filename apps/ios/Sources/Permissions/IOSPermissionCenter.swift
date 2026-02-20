import Contacts
import CoreMotion
import EventKit
import Foundation
import Photos

enum IOSPermissionKind: String, CaseIterable, Identifiable, Sendable {
    case photos
    case contacts
    case calendar
    case reminders
    case motion

    var id: String { self.rawValue }

    var title: String {
        switch self {
        case .photos:
            "Photos"
        case .contacts:
            "Contacts"
        case .calendar:
            "Calendar"
        case .reminders:
            "Reminders"
        case .motion:
            "Motion & Fitness"
        }
    }
}

enum IOSPermissionState: String, Equatable, Sendable {
    case granted
    case limited
    case writeOnly
    case denied
    case restricted
    case notDetermined
    case unavailable

    var label: String {
        switch self {
        case .granted:
            "Granted"
        case .limited:
            "Limited"
        case .writeOnly:
            "Write only"
        case .denied:
            "Denied"
        case .restricted:
            "Restricted"
        case .notDetermined:
            "Not requested"
        case .unavailable:
            "Unavailable"
        }
    }

    var isDeniedOrRestricted: Bool {
        self == .denied || self == .restricted
    }
}

struct IOSPermissionSnapshot: Equatable, Sendable {
    var photos: IOSPermissionState
    var contacts: IOSPermissionState
    var calendar: IOSPermissionState
    var reminders: IOSPermissionState
    var motion: IOSPermissionState

    static let initial = IOSPermissionSnapshot(
        photos: .notDetermined,
        contacts: .notDetermined,
        calendar: .notDetermined,
        reminders: .notDetermined,
        motion: .notDetermined)

    func state(for kind: IOSPermissionKind) -> IOSPermissionState {
        switch kind {
        case .photos:
            self.photos
        case .contacts:
            self.contacts
        case .calendar:
            self.calendar
        case .reminders:
            self.reminders
        case .motion:
            self.motion
        }
    }

    var photosAllowed: Bool {
        self.photos == .granted || self.photos == .limited
    }

    var contactsAllowed: Bool {
        self.contacts == .granted || self.contacts == .limited
    }

    var calendarReadAllowed: Bool {
        self.calendar == .granted
    }

    var calendarWriteAllowed: Bool {
        self.calendar == .granted || self.calendar == .writeOnly
    }

    var remindersReadAllowed: Bool {
        self.reminders == .granted
    }

    var remindersWriteAllowed: Bool {
        self.reminders == .granted || self.reminders == .writeOnly
    }

    var motionAllowed: Bool {
        self.motion == .granted
    }
}

@MainActor
enum IOSPermissionCenter {
    static func statusSnapshot() -> IOSPermissionSnapshot {
        IOSPermissionSnapshot(
            photos: self.mapPhotoStatus(PHPhotoLibrary.authorizationStatus(for: .readWrite)),
            contacts: self.mapContactsStatus(CNContactStore.authorizationStatus(for: .contacts)),
            calendar: self.mapEventKitStatus(EKEventStore.authorizationStatus(for: .event)),
            reminders: self.mapEventKitStatus(EKEventStore.authorizationStatus(for: .reminder)),
            motion: self.motionState())
    }

    static func request(_ kind: IOSPermissionKind) async -> IOSPermissionState {
        switch kind {
        case .photos:
            await self.requestPhotosIfNeeded()
        case .contacts:
            await self.requestContactsIfNeeded()
        case .calendar:
            await self.requestCalendarIfNeeded()
        case .reminders:
            await self.requestRemindersIfNeeded()
        case .motion:
            await self.requestMotionIfNeeded()
        }
        return self.statusSnapshot().state(for: kind)
    }

    private static func requestPhotosIfNeeded() async {
        guard PHPhotoLibrary.authorizationStatus(for: .readWrite) == .notDetermined else {
            return
        }
        _ = await withCheckedContinuation { (cont: CheckedContinuation<PHAuthorizationStatus, Never>) in
            PHPhotoLibrary.requestAuthorization(for: .readWrite) { status in
                cont.resume(returning: status)
            }
        }
    }

    private static func requestContactsIfNeeded() async {
        guard CNContactStore.authorizationStatus(for: .contacts) == .notDetermined else {
            return
        }
        let store = CNContactStore()
        _ = await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
            store.requestAccess(for: .contacts) { granted, _ in
                cont.resume(returning: granted)
            }
        }
    }

    private static func requestCalendarIfNeeded() async {
        let status = EKEventStore.authorizationStatus(for: .event)
        guard status == .notDetermined || status == .writeOnly else {
            return
        }
        let store = EKEventStore()
        _ = try? await store.requestFullAccessToEvents()
    }

    private static func requestRemindersIfNeeded() async {
        let status = EKEventStore.authorizationStatus(for: .reminder)
        guard status == .notDetermined || status == .writeOnly else {
            return
        }
        let store = EKEventStore()
        _ = try? await store.requestFullAccessToReminders()
    }

    private static func requestMotionIfNeeded() async {
        guard self.motionState() == .notDetermined else {
            return
        }

        let activityManager = CMMotionActivityManager()
        await self.runPermissionProbe { complete in
            let end = Date()
            activityManager.queryActivityStarting(
                from: end.addingTimeInterval(-120),
                to: end,
                to: OperationQueue()) { _, _ in
                    complete()
                }
        }

        let pedometer = CMPedometer()
        await self.runPermissionProbe { complete in
            let end = Date()
            pedometer.queryPedometerData(
                from: end.addingTimeInterval(-120),
                to: end) { _, _ in
                    complete()
                }
        }
    }

    private static func runPermissionProbe(start: (@escaping () -> Void) -> Void) async {
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            let lock = NSLock()
            var resumed = false
            start {
                lock.lock()
                defer { lock.unlock() }
                guard !resumed else { return }
                resumed = true
                cont.resume(returning: ())
            }
        }
    }

    private static func mapPhotoStatus(_ status: PHAuthorizationStatus) -> IOSPermissionState {
        switch status {
        case .authorized:
            .granted
        case .limited:
            .limited
        case .denied:
            .denied
        case .restricted:
            .restricted
        case .notDetermined:
            .notDetermined
        @unknown default:
            .restricted
        }
    }

    private static func mapContactsStatus(_ status: CNAuthorizationStatus) -> IOSPermissionState {
        switch status {
        case .authorized:
            .granted
        case .limited:
            .limited
        case .denied:
            .denied
        case .restricted:
            .restricted
        case .notDetermined:
            .notDetermined
        @unknown default:
            .restricted
        }
    }

    private static func mapEventKitStatus(_ status: EKAuthorizationStatus) -> IOSPermissionState {
        switch status {
        case .authorized, .fullAccess:
            .granted
        case .writeOnly:
            .writeOnly
        case .denied:
            .denied
        case .restricted:
            .restricted
        case .notDetermined:
            .notDetermined
        @unknown default:
            .restricted
        }
    }

    private static func motionState() -> IOSPermissionState {
        let available = CMMotionActivityManager.isActivityAvailable() || CMPedometer.isStepCountingAvailable()
        guard available else {
            return .unavailable
        }

        let activity = CMMotionActivityManager.authorizationStatus()
        let pedometer = CMPedometer.authorizationStatus()

        if activity == .authorized || pedometer == .authorized {
            return .granted
        }
        if activity == .restricted || pedometer == .restricted {
            return .restricted
        }
        if activity == .denied || pedometer == .denied {
            return .denied
        }
        return .notDetermined
    }
}
