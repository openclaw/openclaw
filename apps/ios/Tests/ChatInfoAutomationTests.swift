import Foundation
import OpenClawChatUI
import OpenClawProtocol
import Testing
@testable import OpenClaw

struct ChatInfoAutomationTests {
    let formatter = ChatInfoAutomationSchedule(
        locale: Locale(identifier: "en_US"),
        timeZone: .gmt,
        now: Date(timeIntervalSince1970: 1_795_730_000))

    @Test func `covered clock and day rows match control UI`() {
        // Captured from sessionAutomationSchedule in the Control UI, en-US/UTC.
        let table = [
            "0 17 * * MON-FRI": "Weekdays at 5:00 PM",
            "0 9 * * *": "Daily at 9:00 AM",
            "*/15 * * * *": "Every 15 minutes",
            "0 */6 * * *": "Every 6 hours",
            "0 * * * *": "Every hour",
            "* * * * *": "Every minute",
            "15 * * * *": "At minutes 15 of every hour",
            "30 9 * * MON,WED,FRI": "Monday, Wednesday, and Friday at 9:30 AM",
            "0 9 * * 0,7": "Sunday at 9:00 AM",
            "0 18 1,15 * *": "Days 1 and 15 of the month at 6:00 PM",
            "*/20 8 * * *": "Hours: 8; minutes: 0, 20, and 40; seconds: 0",
            "* 2 * * *": "Hours: 2; minutes: Every minute; seconds: 0",
            "0 17 * * FRI-SUN": "Sunday, Friday, and Saturday at 5:00 PM",
            "0 17 * * MON,TUE-THU": "Monday, Tuesday, Wednesday, and Thursday at 5:00 PM",
            "*/60 * * * *": "Every hour",
            "0 */24 * * *": "Daily at 12:00 AM",
            "*/15 * * * MON-FRI": "Weekdays Every 15 minutes",
            "0 */6 1,15 * *": "Days 1 and 15 of the month Every 6 hours",
        ]
        for (expression, expected) in table {
            #expect(self.formatter.cron(expression) == expected)
        }
    }

    @Test func `raw means raw even when web understands the expression`() {
        for raw in [
            "0 9 * * FRI#2",
            "*/7 * * * *",
            "0 9 15W * *",
            "0 9 L * *",
            "0 9 * * ?",
            "0 9 * * +MON",
            "0 9 1 * MON",
            "0 9 * JAN *",
            "0 9 * 1 *",
            "0 0 9 * * *",
            "0 0 9 * * * 2030",
            "0 */5 * * *",
            "15 */6 * * *",
            "*/60 */6 * * *",
            "0 9 * * 6-0",
            "0 9 * * FRI-MON",
            "0 24 * * *",
            "60 9 * * *",
            "0 9 1-3 * *",
            "  0 9 * * FRI#2  ",
        ] {
            #expect(self.formatter.cron(raw) == raw)
        }
    }

    @Test func `one shots and exact durations match control UI`() {
        for (input, result) in [
            21_600_000: "Every 6 hours",
            90000: "Every 1 minute 30 seconds",
            1200: "Every 1 second 200 milliseconds",
            90_061_001: "Every 1 day 1 hour 1 minute 1 second 1 millisecond",
            0: "Every 0 milliseconds",
        ] {
            #expect(self.formatter.every(input) == result)
        }
        for (input, result) in [
            "2026-11-26T09:30:00.000Z": "9:30 AM",
            "2026-11-27T09:30:00.000Z": "Tomorrow at 9:30 AM",
            "2026-11-29T09:30:00.000Z": "Nov 29 at 9:30 AM",
            "2030-01-22T10:30:00.000Z": "Jan 22, 2030 at 10:30 AM",
            "invalid": "At invalid",
        ] {
            #expect(self.formatter.at(input) == result)
        }
        let brazil = ChatInfoAutomationSchedule(locale: Locale(identifier: "pt_BR"), timeZone: .gmt)
        #expect(brazil.cron("0 17 * * WED").contains("quarta-feira"))
        #expect(brazil.cron("0 17 * * *").contains("17:00"))
    }

    @Test func `chat reads its bindings while both profiles read the agent`() throws {
        let target = OpenClawChatSessionTarget(sessionKey: "agent:ink:notes", agentID: "ink")
        let chat = try #require(ChatInfoVisit.automationQuery(for: target, isProfile: false))
        #expect(chat.sessionkey == target.sessionKey && chat.sessionagentid == "ink" && chat.agentid == nil)
        #expect(chat.limit == 2 && chat.includedisabled == true && chat.compact == true)
        let profile = try #require(ChatInfoVisit.automationQuery(for: target, isProfile: true))
        #expect(profile.sessionkey == nil && profile.sessionagentid == nil && profile.agentid == "ink")
        #expect(profile.limit == 3 && profile.includedisabled == true && profile.compact == true)
        #expect(ChatInfoVisit.automationQuery(for: .init(sessionKey: "main", agentID: nil), isProfile: true) == nil)
    }

    @Test func `compact rows keep status and select exact job ID`() throws {
        let data = Data("""
        {"id":"id /?&","name":"Brief","enabled":false,"scheduleKind":"cron",
         "schedule":{"kind":"cron","expr":"0 9 * * FRI#2"},"lastRunStatus":"ok"}
        """.utf8)
        var job = try JSONDecoder().decode(ChatInfoAutomation.self, from: data)
        #expect(job.status == "Paused")
        #expect(job.timing(self.formatter) == "0 9 * * FRI#2")
        #expect(job.detailQuery == [URLQueryItem(name: "job", value: "id /?&")])
        job.lastRunStatus = "error"
        #expect(job.status == "Run failed")
    }
}
