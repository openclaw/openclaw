import Foundation

public enum OpenClawChatSnoozePatch: Sendable {
    case until(Date)
    case wake
}

public enum OpenClawChatSessionSnooze: Sendable {
    public struct Preset: Sendable {
        public let id: String
        public let title: String
        public let wakeAt: Date

        public init(id: String, title: String, wakeAt: Date) {
            self.id = id
            self.title = title
            self.wakeAt = wakeAt
        }
    }

    public static func presets(now: Date = .now, calendar: Calendar = .current) -> [Preset] {
        guard let oneHour = calendar.date(byAdding: .hour, value: 1, to: now),
              let threeHours = calendar.date(byAdding: .hour, value: 3, to: now)
        else { return [] }
        var presets = [
            Preset(id: "hour", title: String(localized: "In 1 hour"), wakeAt: oneHour),
            Preset(id: "three-hours", title: String(localized: "In 3 hours"), wakeAt: threeHours),
        ]
        let today = calendar.startOfDay(for: now)
        if let evening = calendar.date(bySettingHour: 18, minute: 0, second: 0, of: today), evening > oneHour {
            presets.append(Preset(id: "evening", title: String(localized: "This evening"), wakeAt: evening))
        }
        guard let tomorrow = calendar.date(byAdding: .day, value: 1, to: today),
              let tomorrowMorning = calendar.date(bySettingHour: 9, minute: 0, second: 0, of: tomorrow)
        else { return presets }
        presets.append(Preset(id: "tomorrow", title: String(localized: "Tomorrow"), wakeAt: tomorrowMorning))

        let daysUntilMonday = (9 - calendar.component(.weekday, from: today)) % 7
        if let monday = calendar.date(byAdding: .day, value: daysUntilMonday == 0 ? 7 : daysUntilMonday, to: today),
           let mondayMorning = calendar.date(bySettingHour: 9, minute: 0, second: 0, of: monday),
           mondayMorning != tomorrowMorning
        {
            presets.append(Preset(id: "next-week", title: String(localized: "Next week"), wakeAt: mondayMorning))
        }
        return presets
    }

    public static func wakeDescription(
        _ wakeAt: Date,
        now: Date = .now,
        calendar: Calendar = .current) -> String
    {
        var style = Date.FormatStyle(
            locale: calendar.locale ?? .current,
            calendar: calendar,
            timeZone: calendar.timeZone)
            .hour().minute()
        let time = wakeAt.formatted(style)
        if calendar.isDate(wakeAt, inSameDayAs: now) {
            return time
        }
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now),
           calendar.isDate(wakeAt, inSameDayAs: tomorrow)
        {
            return String(format: String(localized: "tomorrow %@"), time)
        }
        if let nextWeek = calendar.date(byAdding: .day, value: 7, to: now), wakeAt > now, wakeAt <= nextWeek {
            style = style.weekday(.abbreviated)
        } else {
            style = style.month(.abbreviated).day()
        }
        return wakeAt.formatted(style)
    }

    public static func nextWake(in entries: [OpenClawChatSessionEntry], now: Date = .now) -> Date? {
        entries.lazy
            .filter { $0.isSnoozed(at: now) }
            .compactMap(\.snoozedUntil)
            .min()
            .map { Date(timeIntervalSince1970: $0 / 1000) }
    }
}
