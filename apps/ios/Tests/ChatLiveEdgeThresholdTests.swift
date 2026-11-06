import Testing
@testable import OpenClawChatUI

struct ChatLiveEdgeThresholdTests {
    @Test @MainActor func smallScrollUpIsOutsideTheLiveEdgeTolerance() {
        for distance in [15.0, 24.0, 40.0, 49.0] {
            #expect(!chatReaderIsAtLiveEdge(distanceFromBottom: distance))
        }
    }

    @Test func bottomBounceAndToleranceRemainAtTheLiveEdge() {
        for distance in [-20.0, 0.0, 6.0, 12.0] {
            #expect(chatReaderIsAtLiveEdge(distanceFromBottom: distance))
        }
        #expect(!chatReaderIsAtLiveEdge(distanceFromBottom: 12.01))
    }
}
