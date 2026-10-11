import Foundation
import SwiftUI
import Testing
@testable import OpenClawChatUI

struct ChatScrollCommandTests {
    private let session = OpenClawChatSessionTarget(sessionKey: "main", agentID: "test")

    @Test func `an empty page retains the reading offset for the next page`() {
        let geometry = ChatHistoryScrollGeometry()
        let rowID = UUID()
        geometry.settledOffset = 300
        geometry.row = ChatScrollRowGeometry(targetID: rowID, preservationID: nil, contentMinY: 400)
        let first = geometry.preserve(rowID)
        let next = geometry.preserve(rowID)
        #expect(first.0 == rowID)
        #expect(first.1 == -100)
        #expect(next.0 == rowID)
        #expect(next.1 == -100)
    }

    @Test func `a replaced history window discards its stale paging geometry`() {
        let geometry = ChatHistoryScrollGeometry()
        let staleID = UUID()
        geometry.settledOffset = 300
        geometry.row = ChatScrollRowGeometry(targetID: staleID, preservationID: nil, contentMinY: 400)
        _ = geometry.preserve(staleID)
        let replacement = OpenClawChatMessage(
            role: "assistant",
            content: [.init(type: "text", text: "Replacement")],
            timestamp: nil)
        let presentation = ChatTranscriptPresentation(rows: [.message(replacement)], metadata: [:])
        let readingRow = geometry.validatedRow(in: presentation.rows)
        #expect(readingRow == nil)
        #expect(geometry.row == nil)
        #expect(geometry.pagingRowID == nil)
        let fallback = geometry.preserve(readingRow?.targetID ?? presentation.historyAnchorID)
        #expect(fallback.0 == replacement.id)
        #expect(fallback.1 == nil)
        #expect(geometry.pagingRowID == replacement.id)
        geometry.row = ChatScrollRowGeometry(targetID: replacement.id, preservationID: nil, contentMinY: 350)
        #expect(geometry.validatedRow(in: presentation.rows)?.targetID == replacement.id)
        #expect(geometry.preserve(replacement.id).1 == -50)
    }

    @Test func `a removed history row cannot arm deferred preservation`() throws {
        var command = ChatScrollCommand()
        command.enqueue(to: UUID(), anchor: .top, sessionTarget: self.session, offsetFromRow: -60)
        let queued = try #require(command.pending)
        command.cancelMissingPreservation(in: [])
        let consumed = command.take(queued, sessionTarget: self.session)
        #expect(consumed == nil)
        #expect(command.preserving == nil)
    }

    @Test func `prepend restores lazy frame refinements until reader departure and ignores stale geometry`() throws {
        var command = ChatScrollCommand()
        let rowID = UUID()
        command.enqueue(to: rowID, anchor: .top, sessionTarget: self.session, offsetFromRow: -60)
        let request = try #require(command.pending)
        let consumed = command.take(request, sessionTarget: self.session)
        let accepted = try #require(consumed)
        command.beginPreservation(accepted)
        let stale = ChatScrollRowGeometry(targetID: rowID, preservationID: nil, contentMinY: 900)
        let staleOffset = command.preservedOffset(for: stale, sessionTarget: self.session)
        #expect(staleOffset == nil)
        let measured = ChatScrollRowGeometry(targetID: rowID, preservationID: request.id, contentMinY: 900)
        let offset = command.preservedOffset(for: measured, sessionTarget: self.session)
        #expect(offset == 840)
        #expect(command.preserving == accepted)
        let refined = ChatScrollRowGeometry(targetID: rowID, preservationID: request.id, contentMinY: 940)
        #expect(command.preservedOffset(for: refined, sessionTarget: self.session) == 880)
        command.cancel()
        #expect(command.preservedOffset(for: refined, sessionTarget: self.session) == nil)
    }

    @Test func `reader departure or session change cancels post-layout preservation`() throws {
        for departs in [false, true] {
            var command = ChatScrollCommand()
            let rowID = UUID()
            command.enqueue(to: rowID, anchor: .top, sessionTarget: self.session, offsetFromRow: -60)
            let request = try #require(command.pending)
            let consumed = command.take(request, sessionTarget: self.session)
            let accepted = try #require(consumed)
            command.beginPreservation(accepted)
            if departs { command.cancel() }
            let measured = ChatScrollRowGeometry(targetID: rowID, preservationID: request.id, contentMinY: 900)
            let current = departs ? self.session : OpenClawChatSessionTarget(sessionKey: "other", agentID: "test")
            let offset = command.preservedOffset(for: measured, sessionTarget: current)
            #expect(offset == nil)
            #expect(command.preserving == nil)
        }
    }

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
