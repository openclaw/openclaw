import Foundation
import SwiftUI
import Testing
@testable import OpenClawChatUI

struct ChatReaderScrollStateTests {
    #if os(iOS)
    @Test func `iOS initially restores to the live edge`() {
        #expect(chatReaderInitialRestorePolicy() == .liveEdge)
    }
    #elseif os(macOS)
    @Test func `macOS initially restores to the latest turn`() {
        #expect(chatReaderInitialRestorePolicy() == .latestTurn)
    }
    #endif

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
            visibleIDs: [previousUserID, newUserID],
            liveTurnID: newUserID)

        #expect(transition == .added(newUserID))
    }

    @Test func `history hydration after opening is not a new turn`() {
        let previous = UUID()
        let restored = UUID()
        #expect(chatReaderUserTransition(
            previousID: previous,
            visibleIDs: [previous, restored],
            liveTurnID: nil) == .unchanged)
    }

    @Test func `late first history row is not a new turn`() {
        #expect(chatReaderUserTransition(
            previousID: nil,
            visibleIDs: [UUID()],
            liveTurnID: nil) == .unchanged)
    }

    @Test func `a live text or voice turn after opening still anchors`() {
        let previous = UUID()
        let live = UUID()
        #expect(chatReaderUserTransition(
            previousID: previous,
            visibleIDs: [previous, live],
            liveTurnID: live) == .added(live))
    }

    @Test func `undated history cannot steal the opening position`() {
        #expect(chatReaderUserTransition(
            previousID: nil,
            visibleIDs: [UUID()],
            liveTurnID: nil) == .unchanged)
    }

    @Test func `a live user anchors even when narration adds a later boundary`() {
        let previous = UUID()
        let user = UUID()
        let notice = UUID()
        #expect(chatReaderUserTransition(
            previousID: previous,
            visibleIDs: [previous, user, notice],
            liveTurnID: user) == .added(user))
    }

    @Test func `removed transient content does not offer a latest jump`() {
        let userID = UUID()

        let hasNewerContent = chatReaderHasNewerContent(
            after: userID,
            visibleIDs: [userID],
            hasTransientContent: false)

        #expect(!hasNewerContent)
    }

    @Test func `assistant or transient content after the user offers a latest jump`() {
        let userID = UUID()
        let assistantID = UUID()

        #expect(chatReaderHasNewerContent(
            after: userID,
            visibleIDs: [userID, assistantID],
            hasTransientContent: false))
        #expect(chatReaderHasNewerContent(
            after: userID,
            visibleIDs: [userID],
            hasTransientContent: true))
    }

    @Test func `drags and system animated scrolls release the follow target`() {
        #expect(chatReaderScrollReleasesFollow(.interacting))
        #expect(chatReaderScrollReleasesFollow(.animating))
    }

    @Test func `idle alone does not release following`() {
        #expect(!chatReaderScrollReleasesFollow(.idle))
    }

    @Test func `touch down cancels following before a streaming tick can move the reader`() {
        #expect(chatReaderScrollReleasesFollow(.tracking))
        #expect(chatReaderScrollReleasesFollow(.decelerating))
    }

    @Test func `completed voice reply belongs only to its followed user turn`() throws {
        func message(_ role: String) throws -> OpenClawChatMessage {
            try JSONDecoder().decode(OpenClawChatMessage.self, from: Data(
                "{\"role\":\"\(role)\",\"content\":[{\"type\":\"text\",\"text\":\"reply\"}]}".utf8))
        }
        let oldReply = try message("assistant")
        let user = try message("user")
        let reply = try message("assistant")
        let nextUser = try message("user")
        #expect(!chatReaderHasAssistantReply(after: user.id, rows: [.message(oldReply), .message(user)]))
        #expect(chatReaderHasAssistantReply(after: user.id, rows: [.message(user), .message(reply)]))
        #expect(!chatReaderHasAssistantReply(
            after: user.id, rows: [.message(user), .message(nextUser), .message(reply)]))
    }

    @Test func `streaming at the live edge never offers a latest jump`() {
        // #108693: the first Writing tick of a turn makes structural "newer content" true
        // while the reader is still at the bottom; the geometry gate must win.
        #expect(!chatReaderShowsJumpToLatest(
            hasNewerContentBelow: true,
            isAtLiveEdge: true,
            hasVisibleContent: true,
            isLoading: false))
    }

    @Test func `newer content below the viewport offers a latest jump`() {
        #expect(chatReaderShowsJumpToLatest(
            hasNewerContentBelow: true,
            isAtLiveEdge: false,
            hasVisibleContent: true,
            isLoading: false))
    }

    @Test func `loading and empty transcripts suppress the latest jump`() {
        #expect(!chatReaderShowsJumpToLatest(
            hasNewerContentBelow: true,
            isAtLiveEdge: false,
            hasVisibleContent: true,
            isLoading: true))
        #expect(!chatReaderShowsJumpToLatest(
            hasNewerContentBelow: true,
            isAtLiveEdge: false,
            hasVisibleContent: false,
            isLoading: false))
    }
}
