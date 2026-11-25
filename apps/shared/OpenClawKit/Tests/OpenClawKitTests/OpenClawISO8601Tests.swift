import Foundation
import Testing
@testable import OpenClawKit

struct OpenClawISO8601Tests {
    private let instant = Date(timeIntervalSince1970: 1_794_132_000)

    @Test func `parses instants with and without fractional seconds`() {
        #expect(OpenClawISO8601.date(from: "2026-11-08T10:00:00Z") == self.instant)
        #expect(OpenClawISO8601.date(from: "2026-11-08T10:00:00.000Z") == self.instant)
        #expect(OpenClawISO8601.date(from: "2026-11-08T15:30:00.000+05:30") == self.instant)
        #expect(OpenClawISO8601.date(from: "2026-11-08T10:00:00.250Z") == self.instant.addingTimeInterval(0.25))
    }

    @Test func `rejects text that is not an ISO 8601 instant`() {
        #expect(OpenClawISO8601.date(from: "") == nil)
        #expect(OpenClawISO8601.date(from: "tomorrow at 10") == nil)
        #expect(OpenClawISO8601.date(from: "2026-11-08") == nil)
    }
}
