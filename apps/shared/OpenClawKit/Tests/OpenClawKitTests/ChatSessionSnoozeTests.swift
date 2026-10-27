import Foundation
import Testing
@testable import OpenClawChatUI

struct ChatSessionSnoozeTests {
    @Test func `weekday morning presets preserve local clock times and next Monday`() throws {
        let now = try Self.date("2026-09-29T10:00:00-07:00")
        let presets = OpenClawChatSessionSnooze.presets(now: now, calendar: Self.calendar)

        #expect(presets.map(\.id) == ["hour", "three-hours", "evening", "tomorrow", "next-week"])
        #expect(presets.map(\.title) == ["In 1 hour", "In 3 hours", "This evening", "Tomorrow", "Next week"])
        #expect(try presets.map(\.wakeAt) == ([
            "2026-09-29T11:00:00-07:00",
            "2026-09-29T13:00:00-07:00",
            "2026-09-29T18:00:00-07:00",
            "2026-09-30T09:00:00-07:00",
            "2026-10-05T09:00:00-07:00",
        ].map(Self.date)))
    }

    @Test(arguments: ["2026-09-29T17:00:00-07:00", "2026-09-29T17:30:00-07:00"])
    func `evening is omitted when it is no more than an hour away`(timestamp: String) throws {
        let now = try Self.date(timestamp)
        let presets = OpenClawChatSessionSnooze.presets(now: now, calendar: Self.calendar)
        #expect(presets.map(\.id) == ["hour", "three-hours", "tomorrow", "next-week"])
        let tomorrow = try Self.date("2026-09-30T09:00:00-07:00")
        #expect(presets.first(where: { $0.id == "tomorrow" })?.wakeAt == tomorrow)
    }

    @Test func `Sunday omits the duplicate Monday preset and Monday selects the following week`() throws {
        let sunday = try OpenClawChatSessionSnooze.presets(
            now: Self.date("2026-09-27T10:00:00-07:00"), calendar: Self.calendar)
        #expect(sunday.map(\.id) == ["hour", "three-hours", "evening", "tomorrow"])
        #expect(try sunday.last?.wakeAt == (Self.date("2026-09-28T09:00:00-07:00")))

        let monday = try OpenClawChatSessionSnooze.presets(
            now: Self.date("2026-09-28T08:00:00-07:00"), calendar: Self.calendar)
        #expect(monday.last?.id == "next-week")
        #expect(try monday.last?.wakeAt == (Self.date("2026-10-05T09:00:00-07:00")))
    }

    @Test(arguments: [
        ("2026-03-08T01:30:00-08:00", [
            "2026-03-08T03:30:00-07:00", "2026-03-08T05:30:00-07:00",
            "2026-03-08T18:00:00-07:00", "2026-03-09T09:00:00-07:00",
        ]),
        ("2026-11-01T00:30:00-07:00", [
            "2026-11-01T01:30:00-07:00", "2026-11-01T02:30:00-08:00",
            "2026-11-01T18:00:00-08:00", "2026-11-02T09:00:00-08:00",
        ]),
    ])
    func `DST transition presets use elapsed hours and calendar mornings`(
        timestamp: String,
        expected: [String]) throws
    {
        let presets = try OpenClawChatSessionSnooze.presets(now: Self.date(timestamp), calendar: Self.calendar)
        #expect(try presets.map(\.wakeAt) == (expected.map(Self.date)))
    }

    @Test func `tomorrow does not skip a calendar day before the spring transition`() throws {
        let presets = try OpenClawChatSessionSnooze.presets(
            now: Self.date("2026-03-07T23:30:00-08:00"), calendar: Self.calendar)
        let tomorrow = try Self.date("2026-03-08T09:00:00-07:00")
        #expect(presets.first(where: { $0.id == "tomorrow" })?.wakeAt == tomorrow)
        #expect(try presets.last?.wakeAt == (Self.date("2026-03-09T09:00:00-07:00")))
    }

    @Test func `snoozed status accepts only finite future milliseconds`() {
        let now = Date(timeIntervalSince1970: 1000)
        let cases: [(Double?, Bool)] = [
            (nil, false), (999_999, false), (1_000_000, false), (1_000_001, true),
            (.nan, false), (.infinity, false), (-.infinity, false),
        ]
        for (wakeAt, expected) in cases {
            #expect(Self.entry(snoozedUntil: wakeAt).isSnoozed(at: now) == expected)
        }
    }

    @Test func `wake descriptions distinguish today tomorrow next week and later dates`() throws {
        let now = try Self.date("2026-09-29T10:00:00-07:00")
        func description(_ timestamp: String) throws -> String {
            try OpenClawChatSessionSnooze.wakeDescription(
                Self.date(timestamp), now: now, calendar: Self.calendar)
                .replacingOccurrences(of: "\u{202F}", with: " ")
                .replacingOccurrences(of: "\u{00A0}", with: " ")
        }

        #expect(try description("2026-09-29T18:00:00-07:00") == "6:00 PM")
        #expect(try description("2026-09-30T09:00:00-07:00") == "tomorrow 9:00 AM")
        let weekday = try description("2026-10-01T09:00:00-07:00")
        #expect(weekday.contains("Thu"))
        #expect(weekday.contains("9:00 AM"))
        #expect(!weekday.contains("Oct"))
        let boundary = try description("2026-10-06T10:00:00-07:00")
        #expect(boundary.contains("Tue"))
        #expect(boundary.contains("10:00 AM"))
        #expect(!boundary.contains("Oct"))
        let later = try description("2026-10-06T10:01:00-07:00")
        #expect(later.contains("Oct 6"))
        #expect(later.contains("10:01 AM"))
        #expect(!later.contains("Tue"))
    }

    @Test func `next wake ignores expired absent and invalid deadlines`() {
        let now = Date(timeIntervalSince1970: 1000)
        let deadlines: [Double?] = [nil, .infinity, .nan, 999_999, 1_000_000, 1_005_000, 1_002_000]
        let entries = deadlines.map { Self.entry(snoozedUntil: $0) }
        #expect(OpenClawChatSessionSnooze.nextWake(in: entries, now: now) == Date(timeIntervalSince1970: 1002))
        #expect(OpenClawChatSessionSnooze.nextWake(in: entries, now: Date(timeIntervalSince1970: 1005)) == nil)
        #expect(OpenClawChatSessionSnooze.nextWake(in: [], now: now) == nil)
    }

    @Test func `session list decoding preserves snooze facts and omitted fields`() throws {
        let response = try OpenClawChatGatewayPayloadCodec.decodeSessionsList(Data(#"""
        {"sessions":[
          {"key":"agent:main:later","snoozedUntil":1800000000125,"snoozedAt":1799996400125},
          {"key":"agent:main:active"}
        ]}
        """#.utf8), agentID: nil)
        try #require(response.sessions.count == 2)
        #expect(response.sessions[0].snoozedUntil == 1_800_000_000_125)
        #expect(response.sessions[0].snoozedAt == 1_799_996_400_125)
        #expect(response.sessions[1].snoozedUntil == nil)
        #expect(response.sessions[1].snoozedAt == nil)
    }

    @Test func `snooze patches encode integer milliseconds null and the observed identity`() throws {
        let cases: [(OpenClawChatSnoozePatch?, String)] = [
            (
                .until(Date(timeIntervalSince1970: 1_800_000_000.125)),
                #"{"expectedSessionId":"session-a","key":"agent:main:work","snoozedUntil":1800000000125}"#),
            (.wake, #"{"expectedSessionId":"session-a","key":"agent:main:work","snoozedUntil":null}"#),
            (nil, #"{"expectedSessionId":"session-a","key":"agent:main:work"}"#),
        ]
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        for (patch, expected) in cases {
            let request = OpenClawChatGatewayRequests.patchSession(
                sessionKey: "agent:main:work",
                agentID: nil,
                expectedSessionID: "session-a",
                label: nil,
                category: nil,
                pinned: nil,
                archived: nil,
                snoozedUntil: patch,
                unreadPatch: nil)
            #expect(request.method == "sessions.patch")
            #expect(try encoder.encode(request.params) == Data(expected.utf8))
        }
    }

    private static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.locale = Locale(identifier: "en_US_POSIX")
        calendar.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        return calendar
    }

    private static func date(_ timestamp: String) throws -> Date {
        try Date(timestamp, strategy: .iso8601)
    }

    private static func entry(snoozedUntil: Double?) -> OpenClawChatSessionEntry {
        var entry = OpenClawChatSessionEntry(key: "agent:main:work")
        entry.snoozedUntil = snoozedUntil
        return entry
    }
}
