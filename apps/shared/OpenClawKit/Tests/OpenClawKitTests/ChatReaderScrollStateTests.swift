import Foundation
import Testing
@testable import OpenClawChatUI

struct ChatReaderScrollStateTests {
    @Test func `optimistic turn removal keeps the older user as the baseline`() {
        let olderUserID = UUID()
        let optimisticUserID = UUID()

        let transition = chatReaderUserTransition(
            previousID: optimisticUserID,
            visibleIDs: [olderUserID])

        #expect(transition == .removed(latestRemainingID: olderUserID))
    }

    @Test func `only user removal clears the user baseline`() {
        let optimisticUserID = UUID()

        let transition = chatReaderUserTransition(
            previousID: optimisticUserID,
            visibleIDs: [])

        #expect(transition == .removed(latestRemainingID: nil))
    }

    @Test func `new user after the existing baseline starts a turn`() {
        let previousUserID = UUID()
        let newUserID = UUID()

        let transition = chatReaderUserTransition(
            previousID: previousUserID,
            visibleIDs: [previousUserID, newUserID])

        #expect(transition == .added(newUserID))
    }
}
