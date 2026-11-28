import CoreGraphics
import Foundation
import Testing
@testable import OpenClawChatUI

/// Where a sent turn rests, and when its hold gives way to the reply. Viewport 600 pt, no top inset.
struct ChatReadingSentTurnTests {
    private static func geometry(
        offset: CGFloat,
        content: CGFloat,
        bottom: CGFloat = 0,
        floor: CGFloat = 0) -> ChatReadingGeometry
    {
        ChatReadingGeometry(
            offsetY: offset,
            contentHeight: content,
            viewportHeight: 600,
            insetTop: 0,
            insetBottom: bottom + floor,
            floorInset: floor)
    }

    /// Lays out one pass the way `ChatReadingPosition.reconcile` does: the room first, then the write.
    private static func pass(
        _ policy: inout ChatReadingPolicy,
        offset: CGFloat,
        content: CGFloat,
        bottom: CGFloat = 0,
        turn: ChatReadingRow,
        interacting: Bool = false) -> (floor: CGFloat, write: ChatReadingWrite?)
    {
        let floor = policy.floor(Self.geometry(offset: offset, content: content, bottom: bottom), row: { _ in turn })
        let write = policy.layout(
            Self.geometry(offset: offset, content: content, bottom: bottom, floor: floor),
            interacting: interacting,
            row: { $0 == turn.key ? turn : nil },
            topRow: { nil })
        return (floor, write)
    }

    private static let id = UUID()
    /// The sent turn, 80 pt tall, with 40 pt of list padding under it.
    private static let turn = ChatReadingRow(key: .cell(.row(id)), frame: CGRect(x: 0, y: 880, width: 390, height: 80))

    @Test func `keyboard down, the sent turn rests above the composer with room for the reply's first row`() {
        var policy = ChatReadingPolicy()
        policy.turnSent(Self.id, rest: .aboveComposer(reserve: 52), follows: false, glides: false)
        // Composer: 100 pt. The turn's bottom 52 pt over the list padding, above the composer.
        let first = Self.pass(&policy, offset: 400, content: 1000, bottom: 100, turn: Self.turn)
        #expect(first.write == ChatReadingWrite(y: 552, reason: .turn))
        #expect(first.floor == 52)
    }

    @Test func `keyboard down, the turn holds while the reply starts, rises with it up to the anchor, then stays`() {
        var policy = ChatReadingPolicy()
        policy.turnSent(Self.id, rest: .aboveComposer(reserve: 52), follows: false, glides: false)
        _ = Self.pass(&policy, offset: 400, content: 1000, bottom: 100, turn: Self.turn)
        // The reply's first row, 50 pt, fills the room: nothing moves.
        let working = Self.pass(&policy, offset: 552, content: 1050, bottom: 100, turn: Self.turn)
        #expect(working.write == nil)
        #expect(working.floor == 2)
        // Released: the turn rises with the reply's end...
        let growing = Self.pass(&policy, offset: 552, content: 1200, bottom: 100, turn: Self.turn)
        #expect(growing.write == ChatReadingWrite(y: 700, reason: .turn))
        // ...only up to the turn anchor (880 - (500 - 80) * 0.18); the rest of a long reply reads from
        // its start, below the fold, with Jump to latest.
        let long = Self.pass(&policy, offset: 700, content: 3000, bottom: 100, turn: Self.turn)
        #expect(long.write?.reason == .turn)
        #expect(abs((long.write?.y ?? 0) - 804.4) < 0.001)
        #expect(Self.pass(&policy, offset: 804.4, content: 3400, bottom: 100, turn: Self.turn).write == nil)
        #expect(policy.mode == .turn(Self.id))
    }

    @Test func `keyboard up, the sent turn rests above the composer and follows once the reply outgrows its room`() {
        var policy = ChatReadingPolicy()
        policy.turnSent(Self.id, rest: .aboveComposer(reserve: 52), follows: true, glides: false)
        // Keyboard and composer: 300 pt.
        let rest = Self.pass(&policy, offset: 700, content: 1000, bottom: 300, turn: Self.turn)
        #expect(rest.write == ChatReadingWrite(y: 752, reason: .follow))
        let working = Self.pass(&policy, offset: 752, content: 1050, bottom: 300, turn: Self.turn)
        #expect(working.write == nil)
        #expect(working.floor == 2)
        // Past the room the transcript follows the reply's end again.
        let reply = Self.pass(&policy, offset: 752, content: 1200, bottom: 300, turn: Self.turn)
        #expect(reply.floor == 0)
        #expect(reply.write == ChatReadingWrite(y: 900, reason: .follow))
    }

    @Test func `keyboard up, a working row left under the finished reply neither lifts nor drops the turn`() {
        var policy = ChatReadingPolicy()
        policy.turnSent(Self.id, rest: .aboveComposer(reserve: 52), follows: true, glides: false)
        _ = Self.pass(&policy, offset: 700, content: 1000, bottom: 300, turn: Self.turn)
        // A finished reply lands while the run has not cleared: the working row is still under it.
        let reply = ChatReadingRow(key: .cell(.row(UUID())), frame: CGRect(x: 0, y: 960, width: 390, height: 140))
        let working = ChatReadingRow(key: .answer("run"), frame: CGRect(x: 0, y: 1100, width: 390, height: 50))
        let rows = [Self.turn, reply, working]
        let tail = ChatReadingPolicy.settlingTail(turn: Self.turn, rows: rows, workingRowOnly: true)
        #expect(tail == 50)
        let both = Self.pass(&policy, offset: 752, content: 1190 - tail, bottom: 300, turn: Self.turn)
        #expect(both.write == ChatReadingWrite(y: 840, reason: .follow))
        // The run clears and the working row goes: nothing moves.
        #expect(Self.pass(&policy, offset: 840, content: 1140, bottom: 300, turn: Self.turn).write == nil)
        // The reply row's marker can register a pass late: the gap above the working row is the reply.
        #expect(ChatReadingPolicy.settlingTail(turn: Self.turn, rows: [Self.turn, working], workingRowOnly: true) == 50)
        // Words in the live cell, or the working row straight under the turn: the live cell counts.
        #expect(ChatReadingPolicy.settlingTail(turn: Self.turn, rows: rows, workingRowOnly: false) == 0)
        let waiting = ChatReadingRow(key: .answer("run"), frame: CGRect(x: 0, y: 960, width: 390, height: 50))
        #expect(ChatReadingPolicy.settlingTail(turn: Self.turn, rows: [Self.turn, waiting], workingRowOnly: true) == 0)
    }

    @Test func `the glide leaves from where the transcript was and lands on the rest on the spring`() {
        var policy = ChatReadingPolicy()
        policy.turnSent(Self.id, rest: .aboveComposer(reserve: 52), follows: false, glides: true)
        // The pass that lays the turn out keeps the old offset; the frames carry it to the rest.
        #expect(Self.pass(&policy, offset: 400, content: 1000, bottom: 100, turn: Self.turn).write == nil)
        let geometry = Self.geometry(offset: 400, content: 1000, bottom: 100, floor: 52)
        let row: (ChatReadingRowKey) -> ChatReadingRow? = { $0 == Self.turn.key ? Self.turn : nil }
        let early = policy.glideFrame(geometry, elapsed: 0.1, interacting: false, row: row)
        #expect(abs((early?.y ?? 0) - (400 + 152 * ChatSendMotion.rise.progress(0.1))) < 0.01)
        let landed = policy.glideFrame(geometry, elapsed: ChatSendMotion.settle, interacting: false, row: row)
        #expect(landed == ChatReadingWrite(y: 552, reason: .turn))
        #expect(policy.glide == nil)
    }

    @Test func `the reader's touch during the glide gives the scroll back to them`() {
        var policy = ChatReadingPolicy()
        policy.turnSent(Self.id, rest: .aboveComposer(reserve: 52), follows: false, glides: true)
        _ = Self.pass(&policy, offset: 400, content: 1000, bottom: 100, turn: Self.turn)
        #expect(Self.pass(&policy, offset: 450, content: 1000, bottom: 100, turn: Self.turn, interacting: true)
            .write == nil)
        #expect(policy.glide == nil)
    }

    @Test func `the send's springs start still, rise past nine tenths in 0.2 s and end at settle`() {
        #expect(ChatSendMotion.rise.progress(0) == 0)
        #expect(abs(ChatSendMotion.rise.progress(0.1) - 0.594) < 0.005)
        #expect(ChatSendMotion.rise.progress(0.2) > 0.93)
        #expect(ChatSendMotion.slide.progress(0.165) > ChatSendMotion.rise.progress(0.165))
        #expect(ChatSendMotion.rise.progress(ChatSendMotion.settle) == 1)
    }
}
