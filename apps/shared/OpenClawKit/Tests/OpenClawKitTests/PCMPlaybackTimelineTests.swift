import Foundation
import Testing
@testable import OpenClawKit

struct PCMPlaybackTimelineTests {
    @Test func `bursts preserve the audible windows and drain grace`() {
        var timeline = PCMPlaybackTimeline()
        timeline.bytesPerSecond = 2000
        let loud = Data(Array(repeating: [UInt8(0xFF), 0x7F], count: 50).flatMap(\.self))
        timeline.append(loud + Data(repeating: 0, count: 100), elapsed: 0)
        timeline.append(loud, elapsed: 0.01)

        #expect(timeline.level(elapsed: 0.025) == 1)
        #expect(timeline.level(elapsed: 0.075) == 0)
        #expect(timeline.level(elapsed: 0.125) == 1)
        #expect(timeline.level(elapsed: 0.64) == 0)
        #expect(timeline.level(elapsed: 0.66) == nil)
    }

    @Test func `a stalled stream resumes at arrival and cancellation clears its tail`() {
        var timeline = PCMPlaybackTimeline()
        timeline.bytesPerSecond = 2000
        let loud = Data(Array(repeating: [UInt8(0xFF), 0x7F], count: 50).flatMap(\.self))
        timeline.append(loud, elapsed: 0)
        timeline.append(loud, elapsed: 0.3)

        #expect(timeline.level(elapsed: 0.2) == 0)
        #expect(timeline.level(elapsed: 0.325) == 1)
        timeline.clear()
        timeline.append(Data(repeating: 0, count: 100), elapsed: 0)
        #expect(timeline.level(elapsed: 0.025) == 0)
        #expect(timeline.level(elapsed: 0.56) == nil)
    }
}
