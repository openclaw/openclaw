import EventKit
import Foundation
import OpenClawKit

final class CalendarService: CalendarServicing {
    private final class PermissionRequestBox: @unchecked Sendable {
        private let lock = NSLock()
        private var continuation: CheckedContinuation<Bool, Never>?
        private var hasResumed = false

        /// Whether the continuation has already been resumed (by a result or cancellation).
        var isResolved: Bool {
            self.lock.lock()
            defer { self.lock.unlock() }
            return self.hasResumed
        }

        func install(_ continuation: CheckedContinuation<Bool, Never>) {
            self.lock.lock()
            if self.hasResumed {
                self.lock.unlock()
                continuation.resume(returning: false)
                return
            }
            self.continuation = continuation
            self.lock.unlock()
        }

        func resume(_ value: Bool) {
            self.lock.lock()
            guard !self.hasResumed else {
                self.lock.unlock()
                return
            }
            self.hasResumed = true
            let continuation = self.continuation
            self.continuation = nil
            self.lock.unlock()
            continuation?.resume(returning: value)
        }
    }

    func events(params: OpenClawCalendarEventsParams) async throws -> OpenClawCalendarEventsPayload {
        let store = EKEventStore()
        let status = EKEventStore.authorizationStatus(for: .event)
        let authorized: Bool
        if status == .notDetermined || status == .writeOnly {
            authorized = await Self.requestEventAccess(store: store)
        } else {
            authorized = EventKitAuthorization.allowsRead(status: status)
        }
        guard authorized else {
            throw NSError(domain: "Calendar", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "CALENDAR_PERMISSION_REQUIRED: grant Calendar permission",
            ])
        }

        let (start, end) = Self.resolveRange(
            startISO: params.startISO,
            endISO: params.endISO)
        let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
        let events = store.events(matching: predicate)
        let limit = max(1, min(params.limit ?? 50, 500))
        let selected = Array(events.prefix(limit))

        let formatter = ISO8601DateFormatter()
        let payload = selected.map { event in
            OpenClawCalendarEventPayload(
                identifier: event.eventIdentifier ?? UUID().uuidString,
                title: event.title ?? "(untitled)",
                startISO: formatter.string(from: event.startDate),
                endISO: formatter.string(from: event.endDate),
                isAllDay: event.isAllDay,
                location: event.location,
                calendarTitle: event.calendar.title)
        }

        return OpenClawCalendarEventsPayload(events: payload)
    }

    func add(params: OpenClawCalendarAddParams) async throws -> OpenClawCalendarAddPayload {
        let store = EKEventStore()
        let status = EKEventStore.authorizationStatus(for: .event)
        let authorized: Bool
        if status == .notDetermined {
            authorized = await Self.requestWriteOnlyEventAccess(store: store)
        } else {
            authorized = EventKitAuthorization.allowsWrite(status: status)
        }
        guard authorized else {
            throw NSError(domain: "Calendar", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "CALENDAR_PERMISSION_REQUIRED: grant Calendar permission",
            ])
        }

        let title = params.title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else {
            throw NSError(domain: "Calendar", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "CALENDAR_INVALID: title required",
            ])
        }

        let formatter = ISO8601DateFormatter()
        guard let start = formatter.date(from: params.startISO) else {
            throw NSError(domain: "Calendar", code: 4, userInfo: [
                NSLocalizedDescriptionKey: "CALENDAR_INVALID: startISO required",
            ])
        }
        guard let end = formatter.date(from: params.endISO) else {
            throw NSError(domain: "Calendar", code: 5, userInfo: [
                NSLocalizedDescriptionKey: "CALENDAR_INVALID: endISO required",
            ])
        }

        let event = EKEvent(eventStore: store)
        event.title = title
        event.startDate = start
        event.endDate = end
        event.isAllDay = params.isAllDay ?? false
        if let location = params.location?.trimmingCharacters(in: .whitespacesAndNewlines), !location.isEmpty {
            event.location = location
        }
        if let notes = params.notes?.trimmingCharacters(in: .whitespacesAndNewlines), !notes.isEmpty {
            event.notes = notes
        }
        event.calendar = try Self.resolveCalendar(
            store: store,
            calendarId: params.calendarId,
            calendarTitle: params.calendarTitle)

        try store.save(event, span: .thisEvent)

        let payload = OpenClawCalendarEventPayload(
            identifier: event.eventIdentifier ?? UUID().uuidString,
            title: event.title ?? title,
            startISO: formatter.string(from: event.startDate),
            endISO: formatter.string(from: event.endDate),
            isAllDay: event.isAllDay,
            location: event.location,
            calendarTitle: event.calendar.title)

        return OpenClawCalendarAddPayload(event: payload)
    }

    private static func requestEventAccess(store: EKEventStore) async -> Bool {
        await self.awaitPermissionRequest { completion in
            if #available(iOS 17.0, *) {
                store.requestFullAccessToEvents { granted, _ in
                    completion(granted)
                }
            } else {
                store.requestAccess(to: .event) { granted, _ in
                    completion(granted)
                }
            }
        }
    }

    private static func requestWriteOnlyEventAccess(store: EKEventStore) async -> Bool {
        await self.awaitPermissionRequest { completion in
            if #available(iOS 17.0, *) {
                store.requestWriteOnlyAccessToEvents { granted, _ in
                    completion(granted)
                }
            } else {
                store.requestAccess(to: .event) { granted, _ in
                    completion(granted)
                }
            }
        }
    }

    private static func awaitPermissionRequest(
        _ start: @escaping (@Sendable @escaping (Bool) -> Void) -> Void) async -> Bool
    {
        let box = PermissionRequestBox()
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                box.install(continuation)
                /// If the task was already cancelled (onCancel raced ahead and
                /// resumed the continuation with false), skip starting the OS
                /// permission prompt entirely.
                guard !box.isResolved else { return }
                start { granted in
                    box.resume(granted)
                }
            }
        } onCancel: {
            box.resume(false)
        }
    }
}

#if DEBUG
extension CalendarService {
    final class _TestPermissionRequestBox: @unchecked Sendable {
        private let box = PermissionRequestBox()
        private let lock = NSLock()
        private var installWaiters: [CheckedContinuation<Void, Never>] = []
        private var hasInstalled = false

        func resume(_ value: Bool) {
            self.box.resume(value)
        }

        private var isInstalled: Bool {
            self.lock.lock()
            defer { self.lock.unlock() }
            return self.hasInstalled
        }

        private func enqueueInstallWaiter(_ continuation: CheckedContinuation<Void, Never>) {
            self.lock.lock()
            if self.hasInstalled {
                self.lock.unlock()
                continuation.resume()
                return
            }
            self.installWaiters.append(continuation)
            self.lock.unlock()
        }

        func waitUntilInstalled() async {
            guard !self.isInstalled else { return }
            await withCheckedContinuation { continuation in
                self.enqueueInstallWaiter(continuation)
            }
        }

        func installAndAwait() async -> Bool {
            await withCheckedContinuation { continuation in
                self.lock.lock()
                self.hasInstalled = true
                self.box.install(continuation)
                let waiters = self.installWaiters
                self.installWaiters.removeAll()
                self.lock.unlock()
                for waiter in waiters {
                    waiter.resume()
                }
            }
        }
    }
}
#endif

extension CalendarService {
    private static func resolveCalendar(
        store: EKEventStore,
        calendarId: String?,
        calendarTitle: String?) throws -> EKCalendar
    {
        if let id = calendarId?.trimmingCharacters(in: .whitespacesAndNewlines), !id.isEmpty,
           let calendar = store.calendar(withIdentifier: id)
        {
            return calendar
        }

        if let title = calendarTitle?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty {
            if let calendar = store.calendars(for: .event).first(where: {
                $0.title.compare(title, options: [.caseInsensitive, .diacriticInsensitive]) == .orderedSame
            }) {
                return calendar
            }
            throw NSError(domain: "Calendar", code: 6, userInfo: [
                NSLocalizedDescriptionKey: "CALENDAR_NOT_FOUND: no calendar named \(title)",
            ])
        }

        if let fallback = store.defaultCalendarForNewEvents {
            return fallback
        }

        throw NSError(domain: "Calendar", code: 7, userInfo: [
            NSLocalizedDescriptionKey: "CALENDAR_NOT_FOUND: no default calendar",
        ])
    }

    private static func resolveRange(startISO: String?, endISO: String?) -> (Date, Date) {
        let formatter = ISO8601DateFormatter()
        let start = startISO.flatMap { formatter.date(from: $0) } ?? Date()
        let end = endISO.flatMap { formatter.date(from: $0) } ?? start.addingTimeInterval(7 * 24 * 3600)
        return (start, end)
    }
}
