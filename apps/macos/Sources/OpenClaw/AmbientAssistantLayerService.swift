import AppKit
import CoreGraphics
import EventKit
import Foundation
import OpenClawChatUI
import OpenClawKit

@MainActor
enum AmbientAssistantLayerService {
    static func makeSnapshot() async -> AmbientAssistantSurfaceSnapshot {
        let sessionKey = await GatewayConnection.shared.mainSessionKey()
        async let chat = Self.chatSummary(sessionKey: sessionKey)
        async let automation = Self.automationSummary()
        async let schedule = AmbientAssistantScheduleService.shared.summary()
        let work = WorkActivityStore.shared.current

        return AmbientAssistantSnapshotBuilder.makeSnapshot(inputs: AmbientAssistantLiveInputs(
            frontApp: NSWorkspace.shared.frontmostApplication?.localizedName ?? "Current app",
            sessionLabel: "\(sessionKey) session",
            gatewayLabel: "Gateway local",
            deviceLabel: "Mac local",
            permissionSummaries: [
                CGPreflightScreenCaptureAccess() ? "Screen: granted" : "Screen: optional",
                AXIsProcessTrusted() ? "Accessibility: granted" : "Accessibility: optional",
            ],
            chat: await chat,
            schedule: await schedule,
            automation: await automation,
            workLabel: work?.label))
    }

    private static func chatSummary(sessionKey: String) async -> AmbientAssistantChatSummary {
        do {
            let history = try await GatewayConnection.shared.chatHistory(
                sessionKey: sessionKey,
                limit: 12,
                maxChars: 4_000,
                timeoutMs: 3_000)
            let messages = Self.decodeChatMessages(history.messages ?? [])
            let lastUser = messages.last { $0.role == "user" }
            let lastAssistant = messages.last { $0.role == "assistant" && Self.messageText($0) != nil }
            let awaiting = Self.isAwaitingAssistant(lastUser: lastUser, lastAssistant: lastAssistant)
            return AmbientAssistantChatSummary(
                lastUserText: lastUser.flatMap(Self.messageText),
                lastAssistantText: lastAssistant.flatMap(Self.messageText),
                isAwaitingResponse: awaiting,
                error: nil)
        } catch {
            return AmbientAssistantChatSummary(
                lastUserText: nil,
                lastAssistantText: nil,
                isAwaitingResponse: false,
                error: error.localizedDescription)
        }
    }

    private static func automationSummary() async -> AmbientAssistantAutomationSummary {
        do {
            let status = try? await GatewayConnection.shared.cronStatus()
            let runs = try await GatewayConnection.shared.cronRunsAll(limit: 4)
            let schedulerLabel = Self.schedulerLabel(status: status)
            guard let latest = runs.first else {
                return AmbientAssistantAutomationSummary(
                    schedulerLabel: schedulerLabel,
                    latestTitle: nil,
                    latestDetail: nil,
                    latestTone: .ready,
                    error: nil)
            }
            return AmbientAssistantAutomationSummary(
                schedulerLabel: schedulerLabel,
                latestTitle: latest.jobName ?? latest.jobId,
                latestDetail: Self.cronDetail(from: latest),
                latestTone: Self.cronTone(from: latest),
                error: nil)
        } catch {
            return AmbientAssistantAutomationSummary(
                schedulerLabel: "Cron status unknown",
                latestTitle: nil,
                latestDetail: nil,
                latestTone: .error,
                error: error.localizedDescription)
        }
    }

    private static func decodeChatMessages(_ raw: [AnyCodable]) -> [OpenClawChatMessage] {
        raw.compactMap { item in
            guard let data = try? JSONEncoder().encode(item) else { return nil }
            return try? JSONDecoder().decode(OpenClawChatMessage.self, from: data)
        }
    }

    private static func messageText(_ message: OpenClawChatMessage) -> String? {
        let text = message.content.compactMap(\.text).joined(separator: "\n")
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func isAwaitingAssistant(
        lastUser: OpenClawChatMessage?,
        lastAssistant: OpenClawChatMessage?) -> Bool
    {
        guard let lastUser else { return false }
        guard let lastAssistant else { return true }
        guard let userTime = lastUser.timestamp,
              let assistantTime = lastAssistant.timestamp
        else {
            return false
        }
        return userTime > assistantTime
    }

    private static func schedulerLabel(status: GatewayConnection.CronSchedulerStatus?) -> String {
        guard let status else { return "Cron status unknown" }
        let state = status.enabled ? "Cron enabled" : "Cron paused"
        let jobs = status.jobs == 1 ? "1 job" : "\(status.jobs) jobs"
        return "\(state) · \(jobs)"
    }

    private static func cronTone(from entry: CronRunLogEntry) -> AmbientAssistantTone {
        if entry.error != nil { return .error }
        let status = (entry.status ?? entry.action).lowercased()
        if status.contains("fail") || status.contains("error") { return .error }
        if status.contains("running") || status.contains("start") { return .working }
        return .success
    }

    private static func cronDetail(from entry: CronRunLogEntry) -> String {
        let detail = entry.error ?? entry.summary ?? entry.action
        let duration = entry.durationMs.map { " in \(Self.formatDuration(ms: $0))" } ?? ""
        return "\(Self.relativeLabel(for: entry.date))\(duration): \(Self.compact(detail, maxLength: 120))"
    }

    private static func formatDuration(ms: Int) -> String {
        if ms < 1_000 { return "\(ms)ms" }
        let seconds = Double(ms) / 1_000
        if seconds < 60 { return String(format: "%.1fs", seconds) }
        return "\(Int(seconds / 60))m"
    }

    private static func relativeLabel(for date: Date, now: Date = Date()) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(date)))
        if seconds < 60 { return "just now" }
        if seconds < 3_600 { return "\(seconds / 60)m ago" }
        if seconds < 86_400 { return "\(seconds / 3_600)h ago" }
        return "\(seconds / 86_400)d ago"
    }

    private static func compact(_ value: String?, maxLength: Int) -> String {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty else { return "No summary provided." }
        guard trimmed.count > maxLength else { return trimmed }
        let end = trimmed.index(trimmed.startIndex, offsetBy: max(1, maxLength - 1))
        return String(trimmed[..<end]).trimmingCharacters(in: .whitespacesAndNewlines) + "..."
    }
}

@MainActor
final class AmbientAssistantScheduleService {
    static let shared = AmbientAssistantScheduleService()

    private let store = EKEventStore()

    func summary(requestAccess: Bool = false, now: Date = Date()) async -> AmbientAssistantScheduleSummary {
        if requestAccess {
            _ = await self.requestFullScheduleAccess()
        }

        let eventStatus = EKEventStore.authorizationStatus(for: .event)
        let reminderStatus = EKEventStore.authorizationStatus(for: .reminder)
        let canReadEvents = Self.canRead(status: eventStatus)
        let canReadReminders = Self.canRead(status: reminderStatus)
        var items: [AmbientAssistantScheduleItem] = []

        if canReadEvents {
            items.append(contentsOf: self.eventItems(now: now))
        }
        if canReadReminders {
            items.append(contentsOf: await self.reminderItems(now: now))
        }

        return AmbientAssistantScheduleSummary(
            authorizationLabel: Self.authorizationLabel(eventStatus: eventStatus, reminderStatus: reminderStatus),
            items: items.sorted { ($0.sortDate ?? .distantFuture) < ($1.sortDate ?? .distantFuture) }.prefixArray(3),
            error: nil)
    }

    private func requestFullScheduleAccess() async -> Bool {
        async let events = self.requestFullEventAccess()
        async let reminders = self.requestFullReminderAccess()
        let eventsGranted = await events
        let remindersGranted = await reminders
        return eventsGranted || remindersGranted
    }

    private func requestFullEventAccess() async -> Bool {
        await withCheckedContinuation { continuation in
            self.store.requestFullAccessToEvents { granted, _ in
                continuation.resume(returning: granted)
            }
        }
    }

    private func requestFullReminderAccess() async -> Bool {
        await withCheckedContinuation { continuation in
            self.store.requestFullAccessToReminders { granted, _ in
                continuation.resume(returning: granted)
            }
        }
    }

    private func eventItems(now: Date) -> [AmbientAssistantScheduleItem] {
        let calendar = Calendar.current
        let end = calendar.date(byAdding: .day, value: 2, to: now) ?? now.addingTimeInterval(172_800)
        let predicate = self.store.predicateForEvents(withStart: now, end: end, calendars: nil)
        return self.store.events(matching: predicate)
            .filter { !$0.isAllDay || $0.endDate >= now }
            .sorted { $0.startDate < $1.startDate }
            .prefix(4)
            .map { event in
                AmbientAssistantScheduleItem(
                    id: event.eventIdentifier ?? event.title,
                    title: event.title ?? "Calendar event",
                    dueLabel: Self.dueLabel(for: event.startDate, now: now),
                    source: "Calendar",
                    sortDate: event.startDate)
            }
    }

    private func reminderItems(now: Date) async -> [AmbientAssistantScheduleItem] {
        let calendar = Calendar.current
        let start = calendar.startOfDay(for: now)
        let end = calendar.date(byAdding: .day, value: 2, to: now) ?? now.addingTimeInterval(172_800)
        let predicate = self.store.predicateForIncompleteReminders(
            withDueDateStarting: start,
            ending: end,
            calendars: nil)
        return await withCheckedContinuation { continuation in
            self.store.fetchReminders(matching: predicate) { reminders in
                let items = (reminders ?? [])
                    .compactMap { reminder -> (EKReminder, Date)? in
                        guard let due = reminder.dueDateComponents.flatMap({ calendar.date(from: $0) }) else { return nil }
                        return (reminder, due)
                    }
                    .sorted { $0.1 < $1.1 }
                    .prefix(4)
                    .map { reminder, due in
                        AmbientAssistantScheduleItem(
                            id: reminder.calendarItemIdentifier,
                            title: reminder.title ?? "Reminder",
                            dueLabel: Self.dueLabel(for: due, now: now),
                            source: "Reminder",
                            sortDate: due)
                    }
                continuation.resume(returning: items)
            }
        }
    }

    private static func canRead(status: EKAuthorizationStatus) -> Bool {
        switch status {
        case .authorized, .fullAccess:
            true
        default:
            false
        }
    }

    private static func authorizationLabel(
        eventStatus: EKAuthorizationStatus,
        reminderStatus: EKAuthorizationStatus) -> String
    {
        "\(entityLabel(name: "Calendar", status: eventStatus)) · \(entityLabel(name: "Reminders", status: reminderStatus))"
    }

    private static func entityLabel(name: String, status: EKAuthorizationStatus) -> String {
        switch status {
        case .authorized, .fullAccess:
            "\(name) granted"
        case .notDetermined:
            "\(name) permission needed"
        case .denied, .restricted:
            "\(name) permission denied"
        case .writeOnly:
            "\(name) read permission needed"
        @unknown default:
            "\(name) status unknown"
        }
    }

    private static func dueLabel(for date: Date, now: Date) -> String {
        let calendar = Calendar.current
        let formatter = DateFormatter()
        formatter.locale = .current
        if calendar.isDateInToday(date) {
            formatter.dateFormat = "HH:mm"
            return "Today \(formatter.string(from: date))"
        }
        if calendar.isDateInTomorrow(date) {
            formatter.dateFormat = "HH:mm"
            return "Tomorrow \(formatter.string(from: date))"
        }
        formatter.dateStyle = .short
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }
}

private extension Sequence {
    func prefixArray(_ maxLength: Int) -> [Element] {
        Array(self.prefix(maxLength))
    }
}
