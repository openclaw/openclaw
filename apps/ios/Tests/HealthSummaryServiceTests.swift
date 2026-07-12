import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

struct HealthSummaryServiceTests {
    @Test func `date ranges include today and the requested number of calendar days`() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: "America/Los_Angeles"))
        let now = try #require(ISO8601DateFormatter().date(from: "2026-07-12T18:30:00Z"))

        let today = HealthSummaryService.dateRange(period: .today, now: now, calendar: calendar)
        let sevenDays = HealthSummaryService.dateRange(period: .sevenDays, now: now, calendar: calendar)
        let thirtyDays = HealthSummaryService.dateRange(period: .thirtyDays, now: now, calendar: calendar)

        #expect(today.end == now)
        #expect(calendar.dateComponents([.day], from: sevenDays.start, to: today.start).day == 6)
        #expect(calendar.dateComponents([.day], from: thirtyDays.start, to: today.start).day == 29)
        #expect(calendar.component(.hour, from: today.start) == 0)
    }

    @Test func `sleep intervals are clipped and merged before aggregation`() throws {
        let formatter = ISO8601DateFormatter()
        let range = try DateInterval(
            start: #require(formatter.date(from: "2026-07-12T00:00:00Z")),
            end: #require(formatter.date(from: "2026-07-12T12:00:00Z")))
        let intervals = try [
            DateInterval(
                start: #require(formatter.date(from: "2026-07-11T23:30:00Z")),
                end: #require(formatter.date(from: "2026-07-12T01:00:00Z"))),
            DateInterval(
                start: #require(formatter.date(from: "2026-07-12T00:30:00Z")),
                end: #require(formatter.date(from: "2026-07-12T02:00:00Z"))),
            DateInterval(
                start: #require(formatter.date(from: "2026-07-12T03:00:00Z")),
                end: #require(formatter.date(from: "2026-07-12T04:00:00Z"))),
        ]

        #expect(HealthSummaryService.mergedDuration(intervals: intervals, clippedTo: range) == 3 * 60 * 60)
        #expect(HealthSummaryService.mergedDuration(intervals: [], clippedTo: range) == nil)
    }

    @Test func `limited Health history never masquerades as a full period`() throws {
        let formatter = ISO8601DateFormatter()
        let start = try #require(formatter.date(from: "2026-07-06T00:00:00Z"))
        let beforeStart = try #require(formatter.date(from: "2026-07-05T00:00:00Z"))
        let afterStart = try #require(formatter.date(from: "2026-07-10T00:00:00Z"))

        #expect(HealthSummaryService.authorizationCovers(startDate: start, earliestAuthorizedDates: []))
        #expect(HealthSummaryService.authorizationCovers(
            startDate: start,
            earliestAuthorizedDates: [beforeStart, start]))
        #expect(!HealthSummaryService.authorizationCovers(
            startDate: start,
            earliestAuthorizedDates: [beforeStart, afterStart]))
    }
}
