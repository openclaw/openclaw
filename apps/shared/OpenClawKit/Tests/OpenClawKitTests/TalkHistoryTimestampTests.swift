import Testing
@testable import OpenClawKit

struct TalkHistoryTimestampTests {
    @Test func secondsTimestampsAreAcceptedWithSmallTolerance() {
        #expect(TalkHistoryTimestamp.isAfter(999.6, sinceSeconds: 1000))
        #expect(!TalkHistoryTimestamp.isAfter(999.4, sinceSeconds: 1000))
    }

    @Test func millisecondsTimestampsAreAcceptedWithSmallTolerance() {
        let sinceSeconds = 1_700_000_000.0
        let sinceMs = sinceSeconds * 1000
        #expect(TalkHistoryTimestamp.isAfter(sinceMs - 500, sinceSeconds: sinceSeconds))
        #expect(!TalkHistoryTimestamp.isAfter(sinceMs - 501, sinceSeconds: sinceSeconds))
    }
}
