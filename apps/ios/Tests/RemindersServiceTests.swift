import EventKit
import Foundation
import Testing
@testable import OpenClaw

struct RemindersServiceTests {
    @Test(arguments: [
        (TimeZone(secondsFromGMT: 9 * 60 * 60), "2026-07-18T10:15:30+09:00"),
        (TimeZone(identifier: "America/New_York"), "2026-03-08T03:00:00-04:00"),
        (TimeZone(identifier: "Australia/Lord_Howe"), "2026-10-04T01:59:59+10:30"),
    ])
    func `due date uses Gregorian components and an absolute alarm`(zone: TimeZone?, dueISO: String) throws {
        let expectedDate = try #require(ISO8601DateFormatter().date(from: dueISO))
        let timeZone = try #require(zone)
        let reminder = EKReminder(eventStore: EKEventStore())

        try RemindersService.applyDueISO(dueISO, to: reminder, timeZone: timeZone)

        let start = try #require(reminder.startDateComponents)
        let due = try #require(reminder.dueDateComponents)
        let startCalendar = try #require(start.calendar)
        let dueCalendar = try #require(due.calendar)
        let reconstructedStartDate = try #require(startCalendar.date(from: start))
        let reconstructedDueDate = try #require(dueCalendar.date(from: due))
        let alarms = try #require(reminder.alarms)
        #expect(startCalendar.identifier == .gregorian)
        #expect(dueCalendar.identifier == .gregorian)
        #expect(start.timeZone == timeZone)
        #expect(due.timeZone == timeZone)
        #expect(reconstructedStartDate == expectedDate)
        #expect(reconstructedDueDate == expectedDate)
        #expect(alarms.count == 1)
        #expect(alarms[0].absoluteDate == expectedDate)
    }

    @Test(arguments: [
        ("America/New_York", "2026-11-01T01:30:15-04:00", false),
        ("America/New_York", "2026-11-01T01:30:15-05:00", true),
        ("Australia/Lord_Howe", "2026-04-05T01:45:15+11:00", false),
        ("Australia/Lord_Howe", "2026-04-05T01:45:15+10:30", true),
    ])
    func `repeated wall time preserves the requested due instant`(
        zone: String, dueISO: String, expectsStartRelativeAlarm: Bool) throws
    {
        let timeZone = try #require(TimeZone(identifier: zone))
        let formatter = ISO8601DateFormatter()
        let expected = try #require(formatter.date(from: dueISO))
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let fields: Set<Calendar.Component> = [.year, .month, .day, .hour, .minute, .second]
        let wallTime = calendar.dateComponents(fields, from: expected)
        let store = EKEventStore()
        let reminder = EKReminder(eventStore: store)
        reminder.title = "Repeated wall time"
        reminder.calendar = EKCalendar(for: .reminder, eventStore: store)

        try RemindersService.applyDueISO(dueISO, to: reminder, timeZone: timeZone)

        let start = try #require(reminder.startDateComponents)
        let due = try #require(reminder.dueDateComponents)
        for components in [start, due] {
            #expect(components.date == expected)
            for field in fields {
                #expect(components.value(for: field) == wallTime.value(for: field))
            }
        }
        let alarms = try #require(reminder.alarms)
        #expect(alarms.count == 1)
        let alarm = try #require(alarms.first)
        if expectsStartRelativeAlarm {
            #expect(alarm.absoluteDate == nil)
            #expect(alarm.relativeOffset == 0)
            let startDate = try #require(start.date)
            #expect(startDate.addingTimeInterval(alarm.relativeOffset) == expected)
        } else {
            #expect(alarm.absoluteDate == expected)
        }
        let payload = RemindersService.payload(from: reminder, formatter: formatter)
        #expect(payload.dueISO == formatter.string(from: expected))
    }

    @Test func `missing due leaves reminder unscheduled`() throws {
        let omittedValues: [String?] = [nil, "", " \n "]

        for dueISO in omittedValues {
            let reminder = EKReminder(eventStore: EKEventStore())
            try RemindersService.applyDueISO(dueISO, to: reminder)

            #expect(reminder.startDateComponents == nil)
            #expect(reminder.dueDateComponents == nil)
            #expect(!reminder.hasAlarms)
        }
    }

    @Test func `due serialization honors the components calendar`() throws {
        let timeZone = try #require(TimeZone(secondsFromGMT: 0))
        var gregorian = Calendar(identifier: .gregorian)
        gregorian.timeZone = timeZone
        let components = DateComponents(
            calendar: gregorian,
            timeZone: timeZone,
            year: 2026,
            month: 7,
            day: 18,
            hour: 10,
            minute: 15,
            second: 30)
        let expectedDate = try #require(gregorian.date(from: components))

        var buddhist = Calendar(identifier: .buddhist)
        buddhist.timeZone = timeZone
        #expect(buddhist.date(from: components) != expectedDate)
        let store = EKEventStore()
        let reminder = EKReminder(eventStore: store)
        reminder.title = "Calendar-aware reminder"
        reminder.calendar = EKCalendar(for: .reminder, eventStore: store)
        reminder.startDateComponents = components
        reminder.dueDateComponents = components
        let formatter = ISO8601DateFormatter()
        let payload = RemindersService.payload(from: reminder, formatter: formatter)
        #expect(payload.dueISO == formatter.string(from: expectedDate))
    }

    @Test func `payload includes reminder notes when present`() {
        let store = EKEventStore()
        let reminder = EKReminder(eventStore: store)
        reminder.title = "Reminder with notes"
        reminder.calendar = EKCalendar(for: .reminder, eventStore: store)
        let formatter = ISO8601DateFormatter()

        #expect(RemindersService.payload(from: reminder, formatter: formatter).notes == nil)

        reminder.notes = "Bring the signed form"
        #expect(RemindersService.payload(from: reminder, formatter: formatter).notes == "Bring the signed form")
    }
}
