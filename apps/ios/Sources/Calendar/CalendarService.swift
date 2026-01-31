import EventKit
import Foundation
import OpenClawKit

final class CalendarService: CalendarServicing {
    func events(params: OpenClawCalendarEventsParams) async throws -> OpenClawCalendarEventsPayload {
        let store = EKEventStore()
        let status = EKEventStore.authorizationStatus(for: .event)
        let authorized = await Self.ensureAuthorization(store: store, status: status)
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

    private static func ensureAuthorization(store: EKEventStore, status: EKAuthorizationStatus) async -> Bool {
        switch status {
        case .authorized:
            return true
        case .notDetermined:
            return await withCheckedContinuation { cont in
                store.requestAccess(to: .event) { granted, _ in
                    cont.resume(returning: granted)
                }
            }
        case .restricted, .denied:
            return false
        case .fullAccess:
            return true
        case .writeOnly:
            return false
        @unknown default:
            return false
        }
    }

    private static func resolveRange(startISO: String?, endISO: String?) -> (Date, Date) {
        let formatter = ISO8601DateFormatter()
        let start = startISO.flatMap { formatter.date(from: $0) } ?? Date()
        let end = endISO.flatMap { formatter.date(from: $0) } ?? start.addingTimeInterval(7 * 24 * 3600)
        return (start, end)
    }
}
