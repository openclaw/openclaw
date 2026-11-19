import Foundation
import OpenClawKit
import Testing
@testable import OpenClawChatUI

@Suite("Completed transcript work")
struct ChatCompletedWorkTests {
    @Test func `canonical signature retires keyed live narration`() throws {
        var narration = ChatNarration()
        narration.receive(OpenClawAgentEventPayload(
            runId: "run",
            seq: 1,
            stream: "assistant",
            ts: 1,
            data: [
                "text": AnyCodable("Checking"),
                "phase": AnyCodable("commentary"),
                "itemId": AnyCodable("item"),
            ]), history: [])
        let live = try #require(narration.projecting([]).first)
        let recorded = OpenClawChatMessage(
            role: "assistant",
            content: [.init(
                type: "text",
                text: "Checking",
                textSignature: #"{"v":1,"id":"item","phase":"commentary"}"#)],
            timestamp: 1,
            transcriptRunID: "run",
            phase: "commentary")
        #expect(narration.projecting([recorded]).count == 1)
        let reconciled = narration.reconcile([recorded], settled: false)
        #expect(reconciled.changed)
        #expect(reconciled.messages.first?.id == live.id)
        #expect(narration.projecting(reconciled.messages).count == 1)
    }

    @Test func `commentary media stays visible including mixed envelopes`() throws {
        for media in [
            #"{"type":"image","source":{"type":"base64","mediaType":"image/png","data":"AA=="}}"#,
            #"{"type":"text","text":"image","preview":{"kind":"canvas","surface":"assistant_message","render":"url","# +
                #""url":"/__openclaw__/canvas/documents/widget-1/index.html","sandbox":"scripts"}}"#,
        ] {
            let message = try Self.decode("""
            {"role":"assistant","phase":"commentary","timestamp":1,"content":[
            {"type":"text","text":"Checking"},\(media)]}
            """)
            let final = Self.message("assistant", "Done", at: 2, phase: "final_answer")
            #expect(!message.isCollapsibleWork)
            #expect(Self.visibleIDs(Self.collapse([message, final])).contains(message.id))
        }
    }

    @Test func `hidden fallback tools stay absent with search or folding disabled`() {
        let tool = OpenClawChatPendingToolCall(
            toolCallId: "hidden", name: "read", args: nil, startedAt: 1, isError: nil, diffStat: nil)
        for folding in [false, true] {
            let tools = ChatTranscriptRow.fallbackTools([tool])([], folding)
            #expect(tools.isEmpty)
        }
    }

    @Test func `spoken rendition stays visible when a consult answer is persisted later`() throws {
        let voice = try Self.decode(#"""
        {"role":"assistant","content":"The latest build is on your phone.","timestamp":1000,
         "model":"realtime-voice","provenance":{"kind":"realtime_voice","sourceChannel":"talk"}}
        """#)
        let consult = Self.message("assistant", "The build went on at about 14:15.", at: 2000, phase: "final_answer")
        let rows = Self.collapse([voice, consult])
        #expect(Self.visibleIDs(rows) == [voice.id, consult.id])
        #expect(Self.work(in: rows).isEmpty)
    }

    @Test func `completed work folds around visible answers and leaves unresolved tails exposed`() throws {
        let user = Self.message("user", "Check the layout", at: 1000)
        let progress = Self.message("assistant", "Checking", at: 2000, phase: "commentary")
        let tool = Self.message("toolResult", "checked", at: 3000)
        let answer = Self.message("assistant", "The layout is ready", at: 6000, phase: "final_answer")
        let trailing = Self.message("assistant", "Saved the report", at: 7000, phase: "commentary")
        let failed = Self.message("toolResult", #"{"status":"failed"}"#, at: 8000)
        let unresolved = Self.toolCall(at: 9000)
        let independent = Self.message("toolResult", "heartbeat", at: 10000, run: "another-run")
        let source = [user, progress, tool, answer, trailing, failed, unresolved, independent]
        let rows = Self.collapse(source)
        let work = try #require(Self.work(in: rows).first)

        #expect(work.messages.map(\.id) == [tool.id])
        #expect(work.durationMilliseconds == nil)
        #expect(Self.visibleIDs(rows) == [
            user.id,
            progress.id,
            answer.id,
            trailing.id,
            failed.id,
            unresolved.id,
            independent.id,
        ])
        #expect(Self.collapse([user, progress, failed, unresolved]) == ChatTranscriptRow.build(
            from: [user, progress, failed, unresolved]))
    }

    @Test func `unphased last reply and mixed final phase media remain visible`() throws {
        let progress = Self.message("assistant", "Checking", at: 2000)
        let firstAnswer = Self.message("assistant", "First answer", at: 4000, phase: "final_answer")
        let mixed = try Self.decode(#"""
        {"role":"assistant","timestamp":5000,"phase":"commentary","content":[
          {"type":"text","text":"Progress","textSignature":"{\"v\":1,\"phase\":\"commentary\"}"},
          {"type":"text","text":"Final answer","textSignature":"{\"v\":1,\"phase\":\"final_answer\"}"}
        ]}
        """#)
        let media = OpenClawChatMessage(
            role: "assistant",
            content: [.init(type: "image", text: nil, mimeType: "image/png", fileName: "layout.png", content: nil)],
            timestamp: 6000)
        let rows = Self.collapse([progress, firstAnswer, mixed, media])
        #expect(Self.work(in: rows).isEmpty)
        #expect(Self.visibleIDs(rows) == [progress.id, firstAnswer.id, mixed.id, media.id])
        #expect(Self.visibleIDs(Self.collapse([progress, Self.toolCall(at: 3000), mixed])) == [progress.id, mixed.id])
        let legacyFinal = Self.message("assistant", "Legacy final", at: 7000)
        #expect(Self.visibleIDs(Self.collapse([progress, Self.toolCall(at: 3000), legacyFinal])) == [
            progress.id,
            legacyFinal.id,
        ])
    }

    @Test func `later run commentary cannot turn its unanswered tools into completed work`() {
        let tool = Self.toolCall(at: 1000)
        let final = Self.message("assistant", "Done", at: 2000, run: "answered", phase: "final_answer")
        let progress = Self.message(
            "assistant",
            "Checking another item",
            at: 3000,
            run: "unanswered",
            phase: "commentary")
        let result = Self.message("toolResult", "Checked", at: 4000, run: "unanswered")
        let rows = Self.collapse([tool, final, progress, result])
        #expect(Self.work(in: rows).first?.messages.map(\.id) == [tool.id])
        #expect(Self.visibleIDs(rows) == [final.id, progress.id, result.id])
    }

    @Test(arguments: [false, true], [false, true])
    func `assistant text with unfinished tools cannot complete work or hide a failure tail`(
        hasFailedResult: Bool,
        hasType: Bool)
    {
        let progress = Self.message("assistant", "Checking", at: 1000, phase: "commentary")
        let final = Self.message("assistant", "First item is ready", at: 2000, phase: "final_answer")
        let failed = Self.message("toolResult", #"{"status":"failed"}"#, at: 3000)
        let results: [OpenClawChatMessageContent] = hasFailedResult ? [.init(
            type: "tool_result",
            text: #"{"status":"failed"}"#,
            mimeType: nil,
            fileName: nil,
            content: nil,
            id: "call")] : []
        let unfinished = OpenClawChatMessage(
            role: "assistant",
            content: [.init(type: "text", text: "Trying another check", mimeType: nil, fileName: nil, content: nil)] +
                [.init(
                    type: hasType ? "toolCall" : nil,
                    text: nil,
                    mimeType: nil,
                    fileName: nil,
                    content: nil,
                    id: "call",
                    name: "read",
                    arguments: AnyCodable(["path": "layout.md"]))] + results,
            timestamp: 4000)
        #expect(Self.work(in: Self.collapse([progress, unfinished])).isEmpty)
        let rows = Self.collapse([progress, final, failed, unfinished])
        #expect(Self.work(in: rows).isEmpty)
        #expect(Self.visibleIDs(rows) == [progress.id, final.id, failed.id, unfinished.id, unfinished.id])
    }

    @Test func `overlapping steers extend the same chronological chain until its last input is answered`() {
        let first = Self.message("user", "Start", at: 1000, run: "first")
        let second = Self.message("user", "Use blue", at: 3000, run: "second", steer: "first")
        let third = Self.message("user", "Keep the header", at: 5000, run: "third", steer: "second")
        let intermediate = Self.message("assistant", "Header is ready", at: 7000, phase: "final_answer")
        let fourth = Self.message("user", "Check the footer too", at: 8000, run: "fourth", steer: "first")
        let source = [
            first,
            Self.toolCall(at: 2000),
            second,
            Self.toolCall(at: 4000),
            third,
            Self.toolCall(at: 6000),
            intermediate,
            fourth,
            Self.toolCall(at: 9000),
        ]
        #expect(Self.work(in: Self.collapse(source)).isEmpty)
        #expect(Self.work(in: Self.collapse(source, working: true)).count == 4)
        let final = Self.message("assistant", "All finished", at: 10000, phase: "final_answer")
        #expect(Self.work(in: Self.collapse(source + [final])).count == 4)
        #expect(Self.visibleIDs(Self.collapse(source + [final])) == [
            first.id,
            second.id,
            third.id,
            intermediate.id,
            fourth.id,
            final.id,
        ])
    }

    @Test func `live turns fold tools while search remains expanded`() {
        let first = [
            Self.message("user", "First", at: 0),
            Self.toolCall(at: 1),
            Self.message("assistant", "Done", at: 2),
        ]
        let second = [
            Self.message("user", "Second", at: 3),
            Self.toolCall(at: 4),
            Self.message("assistant", "Answer so far", at: 5),
        ]
        #expect(Self.work(in: Self.collapse(first + second, working: true)).count == 2)
        let raw = ChatTranscriptRow.build(from: first + second)
        #expect(ChatTranscriptRow.collapseCompletedWork(raw, runWorking: false, searchActive: true) == raw)
        let active = Self.message("assistant", "Checking", at: 6, run: "active", phase: "commentary")
        #expect(ChatTranscriptRow.collapseCompletedWork(
            ChatTranscriptRow.build(from: [active] + first), runWorking: false, activeRunIDs: ["active"])
            .first == .message(active))
    }

    @Test func `forwarded projected and structural boundaries do not donate work to another answer`() {
        let work = Self.toolCall(at: 1)
        let boundary = Self.message("assistant", "Forwarded", at: 2, provenance: .init(
            kind: "inter_session", sourceTool: "sessions_send"))
        let answer = Self.message("assistant", "Done", at: 4)
        let localWork = Self.toolCall(at: 3)
        let rows = Self.collapse([work, boundary, localWork, answer])
        #expect(Self.visibleIDs(rows) == [work.id, boundary.id, answer.id])
        #expect(Self.work(in: rows).first?.messages.map(\.id) == [localWork.id])
        let projected = Self.message("assistant", "new run", at: 2, boundary: true, phase: "commentary")
        #expect(Self.visibleIDs(Self.collapse([work, projected, answer])).first == work.id)
        let marker = OpenClawChatMessage(
            role: "system", content: [], timestamp: 2, historyMarker: .init(kind: "compaction"))
        let divided = Self.collapse([work, marker, localWork, answer])
        #expect(Self.visibleIDs(divided) == [work.id, answer.id])
        #expect(Self.work(in: divided).first?.messages.map(\.id) == [localWork.id])
        let user = Self.message("user", "Start", at: 0, run: "first")
        let steer = Self.message("user", "Continue", at: 2.5, steer: "first")
        let continued = Self.collapse([user, work, marker, steer, localWork, answer])
        #expect(Self.visibleIDs(continued) == [user.id, work.id, steer.id, answer.id])
        #expect(Self.work(in: continued).map { $0.messages.map(\.id) } == [[localWork.id]])
    }

    @Test func `steer continuations fold live tools and finish on their own side of input`() {
        let original = Self.message("user", "Start", at: 1000, run: "original")
        let work = Self.toolCall(at: 2000)
        let steer = Self.message("user", "Use blue", at: 3000, run: "steer", steer: "original")
        let continuedWork = Self.toolCall(at: 4000)
        let answer = Self.message("assistant", "Finished", at: 6000)
        let source = [original, work, steer, continuedWork, answer]
        #expect(Self.work(in: Self.collapse(source, working: true)).map { $0.messages.map(\.id) } ==
            [[work.id], [continuedWork.id]])
        let rows = Self.collapse(source)
        #expect(Self.visibleIDs(rows) == [original.id, steer.id, answer.id])
        let groups = Self.work(in: rows)
        #expect(groups.map { $0.messages.map(\.id) } == [[work.id], [continuedWork.id]])
        #expect(groups.map(\.durationMilliseconds) == [nil, nil])
        let prepended = Self.toolCall(at: 1500)
        let refreshed = Self.collapse([original, prepended, work, steer, continuedWork, answer])
        #expect(Self.work(in: refreshed).map(\.id) == groups.map(\.id))
    }

    @MainActor
    @Test func `retained consult answer keeps its place when later history arrives`() {
        let question = Self.message("user", "Count files", at: 1)
        let consult = Self.message("assistant", "Thirteen files.", at: 2)
        let spoken = Self.message("assistant", "Thirteen.", at: 3)
        let typed = Self.message("user", "Thanks", at: 4)
        let reply = Self.message("assistant", "You are welcome.", at: 5)
        let merged = OpenClawChatViewModel.insertingRetainedMessages(
            [consult.id],
            from: [question, consult, spoken],
            into: [question, spoken, typed, reply])
        #expect(merged.map(\.id) == [question.id, consult.id, spoken.id, typed.id, reply.id])
        let orphan = OpenClawChatViewModel.insertingRetainedMessages(
            [consult.id], from: [consult, question], into: [question, spoken])
        #expect(orphan.map(\.id) == [consult.id, question.id, spoken.id])
        // With no surviving neighbor, retained rows are newer than the history and keep their order at the end.
        let unanchored = OpenClawChatViewModel.insertingRetainedMessages(
            [typed.id, reply.id], from: [typed, reply], into: [question, spoken])
        #expect(unanchored.map(\.id) == [question.id, spoken.id, typed.id, reply.id])
    }

    @Test @MainActor func `gateway split projections keep work and stable display IDs`() async throws {
        // Real history projects text and tools with the same canonical ID, then
        // delivers the parent's final answer on a requester-settle run.
        let text = try Self.decode(#"""
        {"role":"assistant","timestamp":2000,"__openclaw":{"id":"shared","runId":"parent"},
         "openclawStreamFallback":{"source":"segment","itemId":"checking-layout"},
         "content":[{"type":"text","text":"Checking the mobile layout"}]}
        """#)
        let tool = try Self.decode(#"""
        {"role":"assistant","timestamp":2000,"__openclaw":{"id":"shared","runId":"parent"},
         "content":[{"type":"thinking","thinking":"Inspect layout"},
                    {"type":"toolCall","id":"read-1","name":"read"}]}
        """#)
        let result = Self.message("toolResult", "Layout reviewed", at: 3000, run: "parent")
        let final = Self.message("assistant", "Use consistent padding", at: 5000, run: "announce:requester-settle")
        let original = [text, tool, result, final]
        let raw = try original.map { try JSONDecoder().decode(AnyCodable.self, from: JSONEncoder().encode($0)) }
        let decoded = await OpenClawChatViewModel.decodeMessages(raw)
        #expect(decoded.count == 4)
        let refreshed = await OpenClawChatViewModel.reconcileMessageIDs(
            previous: decoded, incoming: OpenClawChatViewModel.decodeMessages(raw))
        #expect(refreshed.map(\.id) == decoded.map(\.id))
        #expect(Set(refreshed.map(\.id)).count == 4)
        #expect(Self.work(in: Self.collapse(refreshed)).first?.messages.count == 2)
        let cached = OpenClawChatSQLiteTranscriptCache.cacheableMessages(decoded)
        #expect(OpenClawChatViewModel.dedupeMessages(cached).count == 4)
    }

    @Test @MainActor func `phase and boundary metadata survive decode cache sanitize and canonical copies`() throws {
        let raw = #"""
        {"role":"user","phase":"commentary","__openclaw":{"turnBoundary":true,"steerTargetRunId":"active"},
         "content":[{"type":"text","text":"Use blue","textSignature":"{\"v\":1,\"phase\":\"commentary\"}"}]}
        """#
        let message = try Self.decode(raw)
        let copies = [
            message,
            OpenClawChatViewModel.stripInboundMetadata(from: message),
            OpenClawChatViewModel.adoptingCanonicalMessage(message, over: message),
        ] +
            OpenClawChatSQLiteTranscriptCache.cacheableMessages([message])
        for copy in copies {
            let decoded = try JSONDecoder().decode(OpenClawChatMessage.self, from: JSONEncoder().encode(copy))
            #expect(decoded.phase == "commentary")
            #expect(decoded.turnBoundary == true)
            #expect(decoded.steerTargetRunID == "active")
            #expect(decoded.content.first?.textSignature == message.content.first?.textSignature)
        }
    }

    @Test @MainActor func `keyed commentary segments stay distinct and cannot complete failed work`() throws {
        let first = try Self.decode(#"""
        {"role":"assistant","timestamp":3000,
         "__openclaw":{"id":"shared-commentary","idempotencyKey":"same-parent","runId":"active"},
         "openclawStreamFallback":{"source":"segment","itemId":"first","runId":"active"},
         "content":[{"type":"text","text":"Checking the first file"}]}
        """#)
        let second = try Self.decode(#"""
        {"role":"assistant","timestamp":4000,
         "__openclaw":{"id":"shared-commentary","idempotencyKey":"same-parent","runId":"active"},
         "openclawStreamFallback":{"itemId":"second"},
         "content":[{"type":"text","text":"Checking the next file"}]}
        """#)
        let failed = Self.message("toolResult", #"{"status":"failed"}"#, at: 2000)
        let source = [Self.toolCall(at: 1000), failed, first, second]
        let decoded = OpenClawChatViewModel.dedupeMessages(source)
        #expect(decoded.count == 4)
        #expect(Self.work(in: Self.collapse(decoded)).isEmpty)
        let user = Self.message("user", "Check the files", at: 0)
        #expect(OpenClawChatViewModel.hasUnansweredLatestUser(in: [user] + decoded))

        let copies = [first, OpenClawChatViewModel.adoptingCanonicalMessage(first, over: first)] +
            OpenClawChatSQLiteTranscriptCache.cacheableMessages([first])
        for copy in copies {
            let encoded = try JSONDecoder().decode(AnyCodable.self, from: JSONEncoder().encode(copy))
            let marker = encoded.dictionaryValue?["openclawStreamFallback"]?.dictionaryValue
            #expect(marker?["itemId"]?.stringValue == "first")
            #expect(marker?["runId"]?.stringValue == "active")
            let roundTrip = try GatewayPayloadDecoding.decode(encoded, as: OpenClawChatMessage.self)
            #expect(Self.work(in: Self.collapse([failed, roundTrip])).isEmpty)
        }
        let final = Self.message("assistant", "The first read failed; the next file is ready.", at: 5000)
        #expect(Self.visibleIDs(Self.collapse(decoded + [final])) == [first.id, second.id, final.id])

        let unkeyed = try Self.decode(#"""
        {"role":"assistant","timestamp":5000,"openclawStreamFallback":{"source":"current","itemId":"  "},
         "content":[{"type":"text","text":"A complete unkeyed reply"}]}
        """#)
        #expect(Self.visibleIDs(Self.collapse([failed, unkeyed])) == [unkeyed.id])
    }

    private static func decode(_ json: String) throws -> OpenClawChatMessage {
        try JSONDecoder().decode(OpenClawChatMessage.self, from: Data(json.utf8))
    }

    private static func message(
        _ role: String,
        _ text: String,
        at timestamp: Double,
        run: String? = nil,
        boundary: Bool? = nil,
        steer: String? = nil,
        phase: String? = nil,
        provenance: OpenClawChatInputProvenance? = nil) -> OpenClawChatMessage
    {
        OpenClawChatMessage(
            role: role,
            content: [.init(type: "text", text: text, mimeType: nil, fileName: nil, content: nil)],
            timestamp: timestamp,
            transcriptRunID: run,
            provenance: provenance,
            phase: phase,
            turnBoundary: boundary,
            steerTargetRunID: steer)
    }

    private static func toolCall(at timestamp: Double) -> OpenClawChatMessage {
        OpenClawChatMessage(
            role: "assistant",
            content: [.init(
                type: "toolCall", text: nil, mimeType: nil, fileName: nil, content: nil, id: "call", name: "read")],
            timestamp: timestamp)
    }

    private static func collapse(_ messages: [OpenClawChatMessage], working: Bool = false) -> [ChatTranscriptRow] {
        ChatTranscriptRow.collapseCompletedWork(ChatTranscriptRow.build(from: messages), runWorking: working)
    }

    private static func work(in rows: [ChatTranscriptRow]) -> [ChatTranscriptRow.CompletedWork] {
        rows.compactMap {
            if case let .completedWork(work) = $0 {
                work
            } else {
                nil
            }
        }
    }

    private static func visibleIDs(_ rows: [ChatTranscriptRow]) -> [UUID] {
        rows.compactMap {
            if case let .message(message) = $0 {
                message.id
            } else {
                nil
            }
        }
    }
}

@Suite("Live tool segments")
struct ChatLiveToolSegmentTests {
    private func tool(_ name: String, at time: Double) -> OpenClawChatMessage {
        OpenClawChatMessage(
            role: "assistant",
            content: [.init(type: "tool_use", id: name, name: name)],
            timestamp: time,
            transcriptRunID: "live")
    }

    @Test func `live single calls fold and visible answers freeze the previous segment`() {
        let first = self.tool("read", at: 1)
        let answer = OpenClawChatMessage(
            role: "assistant",
            content: [.init(type: "text", text: "Visible answer")],
            timestamp: 2,
            transcriptRunID: "live")
        let second = self.tool("exec", at: 3)
        let rows = ChatTranscriptRow.collapseCompletedWork(
            [.message(first), .message(answer), .message(second)], runWorking: true)
        #expect(rows.count == 3)
        guard case let .completedWork(frozen) = rows[0],
              case let .message(visible) = rows[1],
              case let .completedWork(current) = rows[2]
        else {
            Issue.record("Expected segment, visible answer, segment")
            return
        }
        #expect(!frozen.isLive)
        #expect(current.isLive)
        #expect(visible.id == answer.id)
        #expect(current.messages.first?.id == second.id)
    }

    @Test func `finish keeps native separate disclosures between visible answers`() {
        let first = self.tool("read", at: 1)
        let answer = OpenClawChatMessage(
            role: "assistant",
            content: [.init(type: "text", text: "First answer")],
            timestamp: 2,
            transcriptRunID: "live")
        let second = self.tool("exec", at: 3)
        let final = OpenClawChatMessage(
            role: "assistant",
            content: [.init(type: "text", text: "Final answer")],
            timestamp: 4,
            transcriptRunID: "live",
            phase: "final_answer")
        let rows = ChatTranscriptRow.collapseCompletedWork(
            [.message(first), .message(answer), .message(second), .message(final)], runWorking: false)
        #expect(rows.count == 4)
        guard case let .completedWork(owner) = rows[0], case let .completedWork(segment) = rows[2] else {
            Issue.record("Expected two chronological work slots")
            return
        }
        #expect(owner.messages.map(\.id) == [first.id])
        #expect(segment.messages.map(\.id) == [second.id])
        #expect(ChatCompletedWorkSummary.label(work: owner, expanded: false).hasPrefix("Worked"))
        #expect(rows[1].id == answer.id)
        #expect(rows[3].id == final.id)
    }

    @Test func `live label follows latest call and segment identity survives append`() {
        let first = self.tool("read", at: 1)
        let second = self.tool("exec", at: 2)
        let before = ChatTranscriptRow.collapseCompletedWork([.message(first)], runWorking: true)
        let after = ChatTranscriptRow.collapseCompletedWork([.message(first), .message(second)], runWorking: true)
        guard case let .completedWork(old) = before.first,
              case let .completedWork(updated) = after.first
        else {
            Issue.record("Expected folded live segments")
            return
        }
        #expect(old.id == updated.id)
        #expect(ChatCompletedWorkSummary.liveLabel(work: old) == "Read")
        #expect(ChatCompletedWorkSummary.liveLabel(work: old) != ChatCompletedWorkSummary.liveLabel(work: updated))
        #expect(updated.messages.count == 2)
    }

    @Test func `provider shapes keep all text visible live and finished`() throws {
        for tagged in [true, false] {
            let opening = OpenClawChatMessage(
                role: "assistant",
                content: [.init(
                    type: "text",
                    text: "Checking the files first.",
                    textSignature: tagged ?
                        #"{"v":1,"id":"msg_proof","phase":"commentary"}"# :
                        nil)],
                timestamp: 0,
                transcriptRunID: "live")
            let middle = OpenClawChatMessage(
                role: "assistant",
                content: [.init(type: "text", text: "The files are ready.")],
                timestamp: 2,
                transcriptRunID: "live")
            let closing = OpenClawChatMessage(
                role: "assistant",
                content: [.init(
                    type: "text",
                    text: "The checks are complete.",
                    textSignature: tagged ?
                        #"{"v":1,"id":"msg_final","phase":"final_answer"}"# :
                        nil)],
                timestamp: 4,
                transcriptRunID: "live")
            let wire = try JSONEncoder().encode([
                opening,
                self.tool("read", at: 1),
                middle,
                self.tool("exec", at: 3),
                closing,
            ])
            let messages = try JSONDecoder().decode([OpenClawChatMessage].self, from: wire)
            for live in [true, false] {
                let rows = ChatTranscriptRow.collapseCompletedWork(
                    ChatTranscriptRow.build(from: messages), runWorking: live)
                let visible = rows.compactMap { row -> String? in
                    if case let .message(m) = row { return m.rawText }
                    return nil
                }
                #expect(visible == [opening.rawText, middle.rawText, closing.rawText])
                let folded = rows.flatMap { row -> [OpenClawChatMessage] in
                    if case let .completedWork(w) = row { return w.messages }
                    return []
                }
                #expect(!folded.contains { $0.rawText == opening.rawText })
                #expect(!folded.contains { $0.rawText == middle.rawText || $0.rawText == closing.rawText })
            }
        }
    }

    @Test func `equal timestamp live work follows event sequence not call id`() throws {
        var commentary = OpenClawChatMessage(
            role: "assistant",
            content: [.init(type: "text", text: "Checking")],
            timestamp: 1,
            phase: "commentary")
        commentary.transcriptRunID = "live"
        commentary.liveEventSequence = 2
        func pending(_ id: String, _ sequence: Int) -> OpenClawChatPendingToolCall {
            OpenClawChatPendingToolCall(
                toolCallId: id,
                name: "read",
                args: nil,
                startedAt: 1,
                isError: nil,
                diffStat: nil,
                runID: "live",
                startSequence: sequence)
        }
        let first = pending("z-first", 1)
        let last = pending("a-last", 3)
        let before = ChatTranscriptRow.collapseCompletedWork(
            ChatTranscriptRow.build(from: ChatTranscriptRow.projectingLiveTools(in: [], tools: [first])),
            runWorking: true)
        let projected = ChatTranscriptRow.projectingLiveTools(in: [commentary], tools: [last, first])
        #expect(projected.map { $0.content.first?.id ?? $0.rawText } == ["z-first", "Checking", "a-last"])
        let after = ChatTranscriptRow.collapseCompletedWork(ChatTranscriptRow.build(from: projected), runWorking: true)
        let old = try #require(before.compactMap { if case let .completedWork(work) = $0 { return work }
            return nil
        }.first)
        let updated = try #require(after.compactMap { if case let .completedWork(work) = $0 { return work }
            return nil
        }.first)
        #expect(old.anchorID == updated.anchorID)
    }

    @Test func `equal timestamps keep deterministic call order`() {
        let answer = OpenClawChatMessage(
            role: "assistant",
            content: [.init(type: "text", text: "Done")],
            timestamp: 2,
            transcriptRunID: "live")
        func pending(_ id: String) -> OpenClawChatPendingToolCall {
            OpenClawChatPendingToolCall(
                toolCallId: id,
                name: "read",
                args: nil,
                startedAt: 1,
                isError: nil,
                diffStat: nil,
                runID: "live")
        }
        // Active-first order flips when a call completes; projection must not.
        let activeFirst = ChatTranscriptRow.projectingLiveTools(
            in: [answer], tools: [pending("b"), pending("a")])
        let completedFirst = ChatTranscriptRow.projectingLiveTools(
            in: [answer], tools: [pending("a"), pending("b")])
        #expect(activeFirst.map(\.id) == completedFirst.map(\.id))
        #expect(activeFirst.count == 3)
    }

    @Test func `live disclosure identity survives history prepending commentary`() throws {
        let user = OpenClawChatMessage(
            role: "user",
            content: [.init(type: "text", text: "Inspect")],
            timestamp: 0,
            transcriptRunID: "live")
        let pending = OpenClawChatPendingToolCall(
            toolCallId: "call-1",
            name: "read",
            args: nil,
            startedAt: 1,
            isError: nil,
            diffStat: nil,
            runID: "live")
        let before = ChatTranscriptRow.collapseCompletedWork(
            ChatTranscriptRow.build(from: ChatTranscriptRow.projectingLiveTools(in: [user], tools: [pending])),
            runWorking: true)
        let commentary = OpenClawChatMessage(
            role: "assistant",
            content: [.init(type: "text", text: "Checking")],
            timestamp: 0.5,
            transcriptRunID: "live",
            phase: "commentary")
        let recorded = OpenClawChatMessage(
            role: "assistant",
            content: [.init(type: "tool_use", id: "call-1", name: "read")],
            timestamp: 1,
            transcriptRunID: "live")
        let after = ChatTranscriptRow.collapseCompletedWork(
            ChatTranscriptRow.build(from: [user, commentary, recorded]), runWorking: true)
        func work(_ rows: [ChatTranscriptRow]) -> ChatTranscriptRow.CompletedWork? {
            rows.compactMap { if case let .completedWork(work) = $0 { return work }
                return nil
            }.first
        }
        let old = try #require(work(before))
        let updated = try #require(work(after))
        #expect(old.anchorID == updated.anchorID)
        #expect(old.id == updated.id)
        #expect(updated.messages.flatMap(\.content).filter { $0.id == "call-1" }.count == 1)
        #expect(after.filter { if case let .message(m) = $0 { return m.rawText == "Checking" }
            return false
        }.count == 1)
    }

    @Test func `live segment identity survives recorded rows replacing pending calls`() {
        let pending = OpenClawChatPendingToolCall(
            toolCallId: "call-1",
            name: "read",
            args: nil,
            startedAt: 1,
            isError: nil,
            diffStat: nil,
            runID: "live")
        let projected = ChatTranscriptRow.projectingLiveTools(in: [], tools: [pending])
        let before = ChatTranscriptRow.collapseCompletedWork(
            ChatTranscriptRow.build(from: projected), runWorking: true)
        // The recorded row carries a different stored ID but the same call key.
        let recorded = OpenClawChatMessage(
            role: "assistant",
            content: [.init(type: "tool_use", id: "call-1", name: "read")],
            timestamp: 1,
            transcriptRunID: "live")
        let after = ChatTranscriptRow.collapseCompletedWork(
            ChatTranscriptRow.build(from: [recorded]), runWorking: true)
        guard case let .completedWork(old) = before.first,
              case let .completedWork(updated) = after.first
        else {
            Issue.record("Expected folded live segments")
            return
        }
        #expect(old.id == updated.id)
        #expect(old.anchorID == updated.anchorID)
    }
}
