import Foundation

/// Renders the approved five-field subset, not a second cron grammar. Everything outside it stays verbatim.
struct ChatInfoAutomationSchedule {
    var locale: Locale = .autoupdatingCurrent
    var timeZone: TimeZone = .autoupdatingCurrent
    var now = Date.now

    func cron(_ expression: String) -> String {
        let fields = expression.split(whereSeparator: \.isWhitespace).map(String.init)
        guard fields.count == 5, fields[3] == "*", fields[2] == "*" || fields[4] == "*",
              let minutes = Self.clockField(fields[0], limit: 60, allowsStep: true),
              let hours = Self.clockField(fields[1], limit: 24, allowsStep: Self.number(fields[0], range: 0...59) == 0)
        else { return expression }
        let day: String
        if fields[2] != "*" {
            let tokens = fields[2].components(separatedBy: ",")
            let days = tokens.compactMap { Self.number($0, range: 1...31) }
            guard days.count == tokens.count else { return expression }
            day = String(
                format: String(localized: "Days %@ of the month"),
                self.list(Set(days).sorted().map(String.init)))
        } else if fields[4] != "*" {
            guard let days = Self.weekdays(fields[4]) else { return expression }
            let calendar = self.calendar(in: .gmt)
            day = days == [1, 2, 3, 4, 5] ? String(localized: "Weekdays") : self
                .list(days.map { calendar.weekdaySymbols[$0] })
        } else {
            day = hours.count == 1 && minutes.count == 1 ? String(localized: "Daily") : ""
        }
        let clock: String
        if hours.count == 1, minutes.count == 1 {
            let date = Date(timeIntervalSince1970: Double(hours[0] * 3600 + minutes[0] * 60))
            clock = String(format: String(localized: "at %@"), self.time(date, zone: .gmt))
        } else if hours.count == 24 {
            switch minutes.count {
            case 60: clock = String(localized: "Every minute")
            case 1 where minutes[0] == 0: clock = String(localized: "Every hour")
            case 1: clock = String(
                    format: String(localized: "At minutes %@ of every hour"),
                    self.list(minutes.map(String.init)))
            default: clock = String(format: String(localized: "Every %lld minutes"), minutes[1])
            }
        } else if hours.count > 1, minutes == [0] {
            clock = String(format: String(localized: "Every %lld hours"), hours[1])
        } else {
            let hourList = self.list(hours.map(String.init))
            let minuteList = minutes.count == 60 ? String(localized: "Every minute") : self
                .list(minutes.map(String.init))
            clock = String(format: String(localized: "Hours: %@; minutes: %@; seconds: 0"), hourList, minuteList)
        }
        return day.isEmpty ? clock : "\(day) \(clock)"
    }

    func every(_ milliseconds: Int) -> String {
        let units: [(Int, Duration.UnitsFormatStyle.Unit)] = [
            (86_400_000, .days),
            (3_600_000, .hours),
            (60000, .minutes),
            (1000, .seconds),
            (1, .milliseconds),
        ]
        var remaining = milliseconds
        var parts: [String] = []
        if milliseconds >= 0 {
            for (scale, unit) in units {
                let value = remaining / scale
                remaining %= scale
                if value > 0 || (milliseconds == 0 && scale == 1) {
                    let duration = Duration.milliseconds(value * scale)
                    parts.append(duration.formatted(.units(
                        allowed: [unit],
                        width: .wide,
                        zeroValueUnits: .show(length: 1)).locale(self.locale)))
                }
            }
        }
        return String(format: String(localized: "Every %@"), parts.isEmpty ? "n/a" : parts.joined(separator: " "))
    }

    func at(_ value: String) -> String {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let withFraction = iso.date(from: value)
        iso.formatOptions = [.withInternetDateTime]
        let parsed = withFraction ?? iso.date(from: value)
        iso.formatOptions = [.withFullDate]
        guard let date = parsed ?? iso.date(from: value)
        else { return String(format: String(localized: "At %@"), value) }
        let calendar = self.calendar(in: self.timeZone)
        let distance = calendar.dateComponents(
            [.day],
            from: calendar.startOfDay(for: self.now),
            to: calendar.startOfDay(for: date)).day
        let time = self.time(date, zone: self.timeZone)
        if distance == 0 { return time }
        let format = DateFormatter()
        format.locale = self.locale
        format.timeZone = self.timeZone
        format.setLocalizedDateFormatFromTemplate(calendar.component(.year, from: date) == calendar.component(
            .year,
            from: self.now) ? "MMMd" : "yMMMd")
        let day = distance == 1 ? String(localized: "Tomorrow") : format.string(from: date)
        return String(format: String(localized: "%@ at %@"), day, time)
    }

    private static func number(_ token: String, range: ClosedRange<Int>) -> Int? {
        guard !token.isEmpty, token.utf8.allSatisfy({ (48...57).contains($0) }), let n = Int(token),
              range.contains(n) else { return nil }
        return n
    }

    private static func clockField(_ token: String, limit: Int, allowsStep: Bool) -> [Int]? {
        if token == "*" { return Array(0..<limit) }
        if allowsStep, token.hasPrefix("*/"), let step = self.number(String(token.dropFirst(2)), range: 1...limit),
           limit.isMultiple(of: step)
        {
            return Array(stride(from: 0, to: limit, by: step))
        }
        return self.number(token, range: 0...limit - 1).map { [$0] }
    }

    private static func weekdays(_ value: String) -> [Int]? {
        let names = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]
        func day(_ token: String) -> Int? {
            names.firstIndex(of: token.uppercased()) ?? self
                .number(token, range: 0...7)
        }
        var result = Set<Int>()
        for field in value.components(separatedBy: ",") {
            let bounds = field.components(separatedBy: "-")
            guard bounds.count <= 2, let first = day(bounds[0]), let end = day(bounds.last ?? "") else { return nil }
            let last = bounds.count == 2 && bounds.last?.uppercased() == "SUN" ? 7 : end
            guard first <= last else { return nil }
            for n in first...last {
                result.insert(n % 7)
            }
        }
        return result.sorted()
    }

    private func list(_ values: [String]) -> String {
        values.formatted(.list(type: .and).locale(self.locale))
    }

    private func calendar(in zone: TimeZone) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.locale = self.locale
        calendar.timeZone = zone
        return calendar
    }

    private func time(_ date: Date, zone: TimeZone) -> String {
        let format = DateFormatter()
        format.locale = self.locale
        format.timeZone = zone
        format.setLocalizedDateFormatFromTemplate("jm")
        return format.string(from: date).replacingOccurrences(of: "\u{202F}", with: " ")
    }
}
