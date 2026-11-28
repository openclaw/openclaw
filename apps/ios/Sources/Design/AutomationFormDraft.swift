import Foundation
import OpenClawKit
import OpenClawProtocol

struct AutomationFormDraft: Equatable {
    enum Frequency: CaseIterable { case once, daily, weekdays, weekly, existing
        var title: String {
            switch self {
            case .once: String(localized: "Once")
            case .daily: String(localized: "Daily")
            case .weekdays: String(localized: "Weekdays")
            case .weekly: String(localized: "Weekly")
            case .existing: String(localized: "Current schedule")
            }
        }
    }

    var name: String
    var instructions: String
    var target: String
    var frequency: Frequency
    var date: Date
    var zone: TimeZone
    var weekday: Int

    init(job: AutomationGateway.Definition? = nil, now: Date = .now, zone: TimeZone = .current) {
        self.name = job?.title ?? ""
        self.instructions = job.flatMap { j in j.instructionsKey.flatMap { j.payload[$0]?.stringValue } } ?? ""
        self.target = job?.sessionTarget ?? "isolated"
        self.zone = job?.schedule["tz"]?.stringValue.flatMap(TimeZone.init(identifier:)) ?? zone
        self.date = now.addingTimeInterval(3600)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = self.zone
        self.weekday = calendar.component(.weekday, from: self.date) - 1
        self.frequency = job == nil ? .daily : .existing
        guard let schedule = job?.schedule else { return }
        if schedule["kind"]?.stringValue == "at", let at = schedule["at"]?.stringValue,
           let date = (try? Date(at, strategy: .iso8601)) ?? (try? Date(
               at,
               strategy: .iso8601.time(includingFractionalSeconds: true)))
        {
            self.date = date
            self.frequency = .once
        } else if schedule["kind"]?.stringValue == "cron", let expr = schedule["expr"]?.stringValue,
                  let tz = schedule["tz"]?.stringValue, TimeZone(identifier: tz) != nil
        {
            let fields = expr.split(separator: " ")
            guard fields.count == 5, fields[2] == "*", fields[3] == "*", let h = Int(fields[1]),
                  (0...23).contains(h), let m = Int(fields[0]), (0...59).contains(m),
                  let date = calendar.date(bySettingHour: h, minute: m, second: 0, of: now) else { return }
            switch fields[4] {
            case "*": self.frequency = .daily
            case "1-5": self.frequency = .weekdays
            default:
                guard let day = Int(fields[4]), (0...7).contains(day) else { return }
                self.frequency = .weekly
                self.weekday = day % 7
            }
            self.date = date
        }
    }

    func parameters(
        job: AutomationGateway.Definition?,
        original: Self,
        agentID: String?,
        now: Date = .now) throws -> AutomationGateway.Params
    {
        let title = self.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let message = self.instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasInstructions = job == nil || job?.instructionsKey != nil
        guard !title.isEmpty, !hasInstructions || !message.isEmpty else { throw AutomationFormError.invalid }
        var fields = AutomationGateway.Params()
        if job == nil || self.name != original
            .name { fields[job?.displayName == nil ? "name" : "displayName"] = .init(title) }
        if hasInstructions, job == nil || self.instructions != original.instructions {
            fields["payload"] = .init([
                "kind": job?.payload["kind"]?.stringValue ?? "agentTurn",
                job?.instructionsKey ?? "message": message,
            ])
        }
        if job == nil || self.target != original.target { fields["sessionTarget"] = .init(self.target) }
        if job == nil || self.frequency != original.frequency || self.date != original.date || self.weekday != original
            .weekday
        {
            var schedule = AutomationGateway.Params()
            switch self.frequency {
            case .existing: throw AutomationFormError.invalid
            case .once:
                guard self.date > now else { throw AutomationFormError.pastDate }
                schedule = ["kind": .init("at"), "at": .init(self.date.ISO8601Format())]
            case .daily, .weekdays, .weekly:
                var calendar = Calendar(identifier: .gregorian)
                calendar.timeZone = self.zone
                let day = self.frequency == .daily ? "*" : self.frequency == .weekdays ? "1-5" : String(self.weekday)
                let minute = calendar.component(.minute, from: self.date)
                let hour = calendar.component(.hour, from: self.date)
                let expr = "\(minute) \(hour) * * \(day)"
                schedule = ["kind": .init("cron"), "expr": .init(expr), "tz": .init(self.zone.identifier)]
                schedule["staggerMs"] = job?.schedule["kind"]?.stringValue == "cron" ? job?
                    .schedule["staggerMs"] : .init(0)
            }
            fields["schedule"] = .init(schedule)
        }
        if let job {
            var params = try job.revisionParams()
            params["patch"] = .init(fields)
            return params
        }
        fields["wakeMode"] = .init("now")
        if let agentID { fields["agentId"] = .init(agentID) }
        return fields
    }
}
