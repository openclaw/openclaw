import Foundation
import SwiftUI
import Testing
@testable import OpenClawChatUI

struct ChatScrollCommandTests {
    private let session = OpenClawChatSessionTarget(sessionKey: "main", agentID: "test")

    @Test func `a command is consumed before scrolling and cannot replay`() throws {
        var command = ChatScrollCommand()
        let targetID = UUID()
        let anchor = UnitPoint(x: 0.5, y: 0.18)
        command.enqueue(to: targetID, anchor: anchor, sessionTarget: self.session)
        let request = try #require(command.pending)

        let result = command.take(request, sessionTarget: self.session)
        let consumed = try #require(result)

        #expect(consumed.targetID == targetID)
        #expect(consumed.anchor == anchor)
        #expect(command.pending == nil)
        let replay = command.take(request, sessionTarget: self.session)
        #expect(replay == nil)
    }

    @Test func `a repeated target supersedes the earlier queued command`() throws {
        var command = ChatScrollCommand()
        let targetID = UUID()
        command.enqueue(to: targetID, anchor: .bottom, sessionTarget: self.session)
        let earlier = try #require(command.pending)
        command.enqueue(to: targetID, anchor: .bottom, sessionTarget: self.session)
        let latest = try #require(command.pending)

        #expect(earlier != latest)
        let stale = command.take(earlier, sessionTarget: self.session)
        #expect(stale == nil)
        #expect(command.pending == latest)
        let consumed = command.take(latest, sessionTarget: self.session)
        #expect(consumed == latest)
    }

    @Test func `reader departure cancels the queued command`() throws {
        var command = ChatScrollCommand()
        command.enqueue(to: UUID(), anchor: .top, sessionTarget: self.session)
        let request = try #require(command.pending)

        command.cancel()

        let consumed = command.take(request, sessionTarget: self.session)
        #expect(consumed == nil)
        #expect(command.pending == nil)
    }

    @Test(arguments: [
        OpenClawChatSessionTarget(sessionKey: "other", agentID: "test"),
        OpenClawChatSessionTarget(sessionKey: "main", agentID: "other"),
    ])
    func `a command cannot cross a session or agent change`(current: OpenClawChatSessionTarget) throws {
        var command = ChatScrollCommand()
        command.enqueue(to: UUID(), anchor: .bottom, sessionTarget: self.session)
        let request = try #require(command.pending)

        let consumed = command.take(request, sessionTarget: current)
        #expect(consumed == nil)
        #expect(command.pending == nil)
        let replay = command.take(request, sessionTarget: self.session)
        #expect(replay == nil)
    }

    @Test func `clearing a search or removing a turn cancels its queued target`() throws {
        var command = ChatScrollCommand()
        let targetID = UUID()
        command.enqueue(to: targetID, anchor: .top, sessionTarget: self.session)
        let request = try #require(command.pending)

        command.cancel(targetID: targetID)

        #expect(command.pending == nil)
        let consumed = command.take(request, sessionTarget: self.session)
        #expect(consumed == nil)
    }

    @Test func `invalidating another target preserves a newer jump to latest`() throws {
        var command = ChatScrollCommand()
        let olderTargetID = UUID()
        command.enqueue(to: olderTargetID, anchor: .top, sessionTarget: self.session)
        command.enqueue(to: UUID(), anchor: .bottom, sessionTarget: self.session)
        let jump = try #require(command.pending)

        command.cancel(targetID: olderTargetID)
        command.cancel(targetID: nil)

        #expect(command.pending == jump)
        let consumed = command.take(jump, sessionTarget: self.session)
        #expect(consumed == jump)
    }
}
