import CoreGraphics
import Foundation
import Testing
@testable import OpenClawChatUI

/// One test per distinct reading-position rule; the viewport is 600 pt with no insets.
struct ChatReadingPositionTests {
    private static func geometry(offset: CGFloat, content: CGFloat) -> ChatReadingGeometry {
        ChatReadingGeometry(offsetY: offset, contentHeight: content, viewportHeight: 600, insetTop: 0, insetBottom: 0)
    }

    private static func row(_ key: ChatReadingRowKey, y: CGFloat, height: CGFloat = 100) -> ChatReadingRow {
        ChatReadingRow(key: key, frame: CGRect(x: 0, y: y, width: 390, height: height))
    }

    private static func layout(
        _ policy: inout ChatReadingPolicy,
        _ geometry: ChatReadingGeometry,
        interacting: Bool = false,
        rows: [ChatReadingRow] = [],
        top: ChatReadingRow? = nil) -> ChatReadingWrite?
    {
        policy.layout(
            geometry,
            interacting: interacting,
            row: { key in rows.first { $0.key == key } },
            topRow: { top })
    }

    private static func key() -> ChatReadingRowKey {
        .cell(.row(UUID()))
    }

    // MARK: Streaming

    @Test func `streaming while following pins the bottom edge in the same pass`() {
        var policy = ChatReadingPolicy()
        #expect(Self.layout(&policy, Self.geometry(offset: 400, content: 1000)) == nil)
        #expect(Self.layout(&policy, Self.geometry(offset: 400, content: 1100)) ==
            ChatReadingWrite(y: 500, reason: .follow))
    }

    @Test func `streaming while reading moves nothing`() {
        var policy = ChatReadingPolicy()
        let held = Self.row(Self.key(), y: 150, height: 200)
        policy.readerSettled(Self.geometry(offset: 200, content: 1000), topRow: held)
        #expect(Self.layout(&policy, Self.geometry(offset: 200, content: 1300), rows: [held]) == nil)
        #expect(policy.mode == nil)
    }

    @Test func `following never fights the reader's finger or fling`() {
        var policy = ChatReadingPolicy()
        #expect(Self.layout(&policy, Self.geometry(offset: 100, content: 1100), interacting: true) == nil)
    }

    // MARK: Send

    @Test func `send with the keyboard up follows the new message at the bottom`() {
        var policy = ChatReadingPolicy()
        policy.readerSettled(Self.geometry(offset: 0, content: 2000), topRow: nil)
        policy.setMode(.latest)
        #expect(Self.layout(&policy, Self.geometry(offset: 0, content: 2000)) ==
            ChatReadingWrite(y: 1400, reason: .follow))
    }

    @Test func `send with the keyboard down puts the new turn's top at 18 percent`() {
        var policy = ChatReadingPolicy()
        let turnID = UUID()
        let turn = Self.row(.cell(.row(turnID)), y: 1200, height: 100)
        policy.setMode(.turn(turnID))
        // Not laid out yet: wait for the pass that places it.
        #expect(Self.layout(&policy, Self.geometry(offset: 0, content: 2000)) == nil)
        // 1200 - (600 - 100) * 0.18
        #expect(Self.layout(&policy, Self.geometry(offset: 0, content: 2000), rows: [turn]) ==
            ChatReadingWrite(y: 1110, reason: .turn))
        // The reply growing below keeps it there without another write.
        #expect(Self.layout(&policy, Self.geometry(offset: 1110, content: 2400), rows: [turn]) == nil)
    }

    @Test func `a turn near the end is clamped to the bottom until the reply fills in`() {
        var policy = ChatReadingPolicy()
        let turnID = UUID()
        let turn = Self.row(.cell(.row(turnID)), y: 1200, height: 100)
        policy.setMode(.turn(turnID))
        #expect(Self.layout(&policy, Self.geometry(offset: 0, content: 1300), rows: [turn]) ==
            ChatReadingWrite(y: 700, reason: .turn))
    }

    // MARK: Disclosure

    @Test func `expanding a disclosure at the bottom while following holds the header`() {
        var policy = ChatReadingPolicy()
        let header = Self.row(Self.key(), y: 500)
        policy.disclosureWillToggle(Self.geometry(offset: 400, content: 1000), topRow: header)
        #expect(policy.mode == nil)
        // The row grows below the header across the animation: offset delta 0 on every pass.
        for content: CGFloat in [1080, 1200, 1300] {
            #expect(Self.layout(&policy, Self.geometry(offset: 400, content: content), rows: [header]) == nil)
        }
        // The bottom edge left the viewport: following does not resume.
        policy.disclosureDidSettle(Self.geometry(offset: 400, content: 1300))
        #expect(policy.mode == nil)
        #expect(Self.layout(&policy, Self.geometry(offset: 400, content: 1400), rows: [header]) == nil)
    }

    @Test func `collapsing a disclosure at the bottom holds the header and resumes following`() {
        var policy = ChatReadingPolicy()
        let header = Self.row(Self.key(), y: 500)
        policy.disclosureWillToggle(Self.geometry(offset: 400, content: 1000), topRow: header)
        // Content still taller than the viewport: no clamp, even with blank space below.
        #expect(Self.layout(&policy, Self.geometry(offset: 400, content: 900), rows: [header]) == nil)
        // The bottom edge is visible: following resumes, with no write of its own.
        policy.disclosureDidSettle(Self.geometry(offset: 400, content: 900))
        #expect(policy.mode == .latest)
    }

    @Test func `a disclosure collapsing below the viewport height clamps only to the top`() {
        var policy = ChatReadingPolicy()
        let header = Self.row(Self.key(), y: 450)
        policy.disclosureWillToggle(Self.geometry(offset: 400, content: 1000), topRow: header)
        #expect(Self.layout(&policy, Self.geometry(offset: 400, content: 560), rows: [header]) ==
            ChatReadingWrite(y: 0, reason: .anchor))
    }

    @Test func `a disclosure toggled while reading holds the header and does not resume following`() {
        var policy = ChatReadingPolicy()
        let header = Self.row(Self.key(), y: 300)
        policy.readerSettled(Self.geometry(offset: 200, content: 2000), topRow: header)
        policy.disclosureWillToggle(Self.geometry(offset: 200, content: 2000), topRow: header)
        #expect(Self.layout(&policy, Self.geometry(offset: 200, content: 2400), rows: [header]) == nil)
        policy.disclosureDidSettle(Self.geometry(offset: 1800, content: 2400))
        #expect(policy.mode == nil)
    }

    // MARK: Older page

    /// The harness's landing: List re-estimates rows above and compensates (-746 pt on offset and
    /// content) in the same pass the 2512 pt page arrives, mid-fling.
    @Test func `an older page landing mid-fling keeps the rows on screen still`() {
        var policy = ChatReadingPolicy()
        policy.setMode(nil)
        policy.olderPageWillPrepend(Self.geometry(offset: 1177, content: 5000))
        #expect(policy.needsNextPass)
        // A frame of the fling before the rows land is the reader's.
        #expect(Self.layout(&policy, Self.geometry(offset: 1173, content: 5000), interacting: true) == nil)
        // A row at content y T was at screen T - 1173; it lands at T + 2512 - 746 and must stay.
        let landed = Self.layout(&policy, Self.geometry(offset: 427, content: 6766), interacting: true)
        #expect(landed == ChatReadingWrite(y: 1173 + 2512 - 746, reason: .prepend))
        // List compensating a row that self-sizes after the landing is not corrected again.
        #expect(Self.layout(&policy, Self.geometry(offset: 2939 + 744, content: 6766 + 744), interacting: true) ==
            nil)
    }

    @Test func `a settled prepend leaves later content changes alone`() {
        var policy = ChatReadingPolicy()
        policy.setMode(nil)
        policy.olderPageWillPrepend(Self.geometry(offset: 1000, content: 5000))
        #expect(Self.layout(&policy, Self.geometry(offset: 1000, content: 7000)) ==
            ChatReadingWrite(y: 3000, reason: .prepend))
        for _ in 0..<ChatReadingPolicy.prependSettlePasses {
            #expect(Self.layout(&policy, Self.geometry(offset: 3000, content: 7000)) == nil)
        }
        #expect(policy.prepend == nil)
        #expect(!policy.needsNextPass)
        // A reply streaming in at the bottom afterwards moves nothing.
        let top = Self.row(Self.key(), y: 3050)
        #expect(Self.layout(&policy, Self.geometry(offset: 3000, content: 7400), rows: [top], top: top) == nil)
        #expect(Self.layout(&policy, Self.geometry(offset: 3000, content: 7800), rows: [top], top: top) == nil)
    }

    @Test func `a prepend that never lands is abandoned`() {
        var policy = ChatReadingPolicy()
        policy.setMode(nil)
        policy.olderPageWillPrepend(Self.geometry(offset: 1000, content: 5000))
        for _ in 0..<ChatReadingPolicy.prependPassLimit {
            _ = Self.layout(&policy, Self.geometry(offset: 1000, content: 5000))
        }
        #expect(policy.prepend == nil)
    }

    @Test func `an older page while following holds nothing`() {
        var policy = ChatReadingPolicy()
        policy.olderPageWillPrepend(Self.geometry(offset: 0, content: 500))
        #expect(policy.prepend == nil)
        #expect(policy.mode == .latest)
    }

    // MARK: Width changes

    @Test func `a split sidebar or rotation keeps the top row at its screen Y`() {
        var policy = ChatReadingPolicy()
        let key = Self.key()
        policy.readerSettled(Self.geometry(offset: 1000, content: 4000), topRow: Self.row(key, y: 1100))
        // Narrower rows above it grew 400 pt.
        let relaid = Self.row(key, y: 1500, height: 140)
        #expect(Self.layout(&policy, Self.geometry(offset: 1000, content: 5000), rows: [relaid]) ==
            ChatReadingWrite(y: 1400, reason: .anchor))
    }

    // MARK: Finalization

    @Test func `finalization keeps the answer where the reader left it`() {
        var policy = ChatReadingPolicy()
        // Reading inside the live answer: its top is 100 pt above the viewport.
        policy.readerSettled(
            Self.geometry(offset: 1000, content: 3000),
            topRow: Self.row(.answer("run"), y: 900, height: 1500))
        // Settled tool rows collapsed into one Worked row above; the final row replaced the live cell.
        let final = Self.row(.answer("run"), y: 500, height: 1520)
        #expect(Self.layout(&policy, Self.geometry(offset: 1000, content: 2620), rows: [final]) ==
            ChatReadingWrite(y: 600, reason: .anchor))
    }

    @Test func `rows changing during the reader's fling are left to List`() {
        var policy = ChatReadingPolicy()
        policy.readerSettled(
            Self.geometry(offset: 1000, content: 3000),
            topRow: Self.row(.answer("run"), y: 900, height: 1500))
        let final = Self.row(.answer("run"), y: 500, height: 1520)
        #expect(Self.layout(
            &policy,
            Self.geometry(offset: 1100, content: 2620),
            interacting: true,
            rows: [final]) == nil)
    }

    @Test func `a held row that leaves the List re-anchors without moving`() {
        var policy = ChatReadingPolicy()
        policy.readerSettled(Self.geometry(offset: 0, content: 2000), topRow: Self.row(Self.key(), y: 0))
        let next = Self.row(Self.key(), y: 120)
        #expect(Self.layout(&policy, Self.geometry(offset: 0, content: 2100), top: next) == nil)
        #expect(policy.anchor?.key == next.key)
    }

    // MARK: Jump, reader scroll

    @Test func `jump to latest is one unanimated write to the bottom`() {
        var policy = ChatReadingPolicy()
        policy.readerSettled(Self.geometry(offset: 0, content: 2000), topRow: Self.row(Self.key(), y: 0))
        #expect(policy.jumpToLatest(Self.geometry(offset: 0, content: 2000)) ==
            ChatReadingWrite(y: 1400, reason: .jump))
        #expect(policy.mode == .latest)
        #expect(policy.anchor == nil)
    }

    @Test func `the reader's scroll releases following and its end holds the top row`() {
        var policy = ChatReadingPolicy()
        policy.setMode(nil)
        #expect(Self.layout(&policy, Self.geometry(offset: 900, content: 2000), interacting: true) == nil)
        let top = Self.row(Self.key(), y: 880)
        policy.readerSettled(Self.geometry(offset: 900, content: 2000), topRow: top)
        #expect(policy.mode == nil)
        #expect(policy.anchor == ChatReadingPolicy.Anchor(top, offsetY: 900))
    }

    // MARK: Row keys

    @Test func `the live cell and the final answer row share one key`() {
        let user = OpenClawChatMessage(
            role: "user",
            content: [.init(type: "text", text: "Request")],
            timestamp: 1,
            transcriptRunID: "run")
        let answer = OpenClawChatMessage(
            role: "assistant",
            content: [.init(type: "text", text: "Answer")],
            timestamp: 2,
            transcriptRunID: "run",
            phase: "final_answer")
        let live = ChatAssistantListCell.cells([ChatAssistantRunGroup(
            id: .run("run", user.id, 0),
            runID: "run",
            parts: [.row(.message(answer))],
            includesLive: true)][...])
        let final = ChatAssistantListCell.cells([ChatAssistantRunGroup(
            id: .run("run", user.id, 0),
            runID: "run",
            parts: [.row(.message(answer))])][...])
        // While live, an earlier reply keeps its own key and the live cell is the answer.
        #expect(ChatReadingRowKey(live[0]) == .cell(.row(answer.id)))
        #expect(ChatReadingRowKey(live[1]) == .answer("run"))
        #expect(ChatReadingRowKey(final[0]) == .answer("run"))
        let userCells = ChatAssistantListCell.cells(ChatAssistantRunGroup.build(
            ChatTranscriptRow.build(from: [user]),
            liveRunID: nil,
            hasLiveContent: false,
            searchActive: false)[...])
        #expect(userCells.map(ChatReadingRowKey.init) == [.cell(.row(user.id))])
    }
}
