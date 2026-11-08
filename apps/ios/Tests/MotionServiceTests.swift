import CoreMotion
import Testing
@testable import OpenClaw

struct MotionServiceTests {
    @Test func `first motion query can request authorization`() {
        #expect(MotionService.allowsMotionQuery(.notDetermined))
    }

    @Test func `authorized motion queries remain allowed`() {
        #expect(MotionService.allowsMotionQuery(.authorized))
    }

    @Test func `denied motion queries remain blocked`() {
        #expect(!MotionService.allowsMotionQuery(.denied))
    }

    @Test func `restricted motion queries remain blocked`() {
        #expect(!MotionService.allowsMotionQuery(.restricted))
    }

    @Test func `activity entries end when the next activity starts`() {
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        let starts = [start, start.addingTimeInterval(1800), start.addingTimeInterval(2700)]
        let queryEnd = start.addingTimeInterval(3600)

        #expect(MotionService.activityEndDates(startDates: starts, queryEnd: queryEnd) == [
            start.addingTimeInterval(1800),
            start.addingTimeInterval(2700),
            queryEnd,
        ])
    }

    @Test func `activity end dates handle empty and late single entries`() {
        let start = Date(timeIntervalSince1970: 1_800_000_000)

        #expect(MotionService.activityEndDates(startDates: [], queryEnd: start).isEmpty)
        #expect(MotionService.activityEndDates(startDates: [start], queryEnd: start.addingTimeInterval(60)) == [
            start.addingTimeInterval(60),
        ])
        #expect(MotionService.activityEndDates(
            startDates: [start.addingTimeInterval(60)],
            queryEnd: start) == [start.addingTimeInterval(60)])
    }
}
