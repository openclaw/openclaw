import EventKit
import Foundation
import OpenClawKit

final class RemindersService: RemindersServicing {
    func list(params: OpenClawRemindersListParams) async throws -> OpenClawRemindersListPayload {
        let store = EKEventStore()
        let status = EKEventStore.authorizationStatus(for: .reminder)
        let authorized = await Self.ensureAuthorization(store: store, status: status)
        guard authorized else {
            throw NSError(domain: "Reminders", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "REMINDERS_PERMISSION_REQUIRED: grant Reminders permission",
            ])
        }

        let limit = max(1, min(params.limit ?? 50, 500))
        let statusFilter = params.status ?? .incomplete

        let predicate = store.predicateForReminders(in: nil)
        let payload = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<[OpenClawReminderPayload], Error>) in
            store.fetchReminders(matching: predicate) { items in
                let formatter = ISO8601DateFormatter()
                let filtered = (items ?? []).filter { reminder in
                    switch statusFilter {
                    case .all:
                        return true
                    case .completed:
                        return reminder.isCompleted
                    case .incomplete:
                        return !reminder.isCompleted
                    }
                }
                let selected = Array(filtered.prefix(limit))
                let payload = selected.map { reminder in
                    let due = reminder.dueDateComponents.flatMap { Calendar.current.date(from: $0) }
                    return OpenClawReminderPayload(
                        identifier: reminder.calendarItemIdentifier,
                        title: reminder.title,
                        dueISO: due.map { formatter.string(from: $0) },
                        completed: reminder.isCompleted,
                        listName: reminder.calendar.title)
                }
                cont.resume(returning: payload)
            }
        }

        return OpenClawRemindersListPayload(reminders: payload)
    }

    private static func ensureAuthorization(store: EKEventStore, status: EKAuthorizationStatus) async -> Bool {
        switch status {
        case .authorized:
            return true
        case .notDetermined:
            return await withCheckedContinuation { cont in
                store.requestAccess(to: .reminder) { granted, _ in
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
}
