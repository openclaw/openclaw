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

    @Test func `hidden first section leaves commentary with a rollup owner`() throws {
        let call = Self.toolCall(at: 1)
        let answer = Self.message("assistant", "Visible answer", at: 2)
        let commentary = Self.message("assistant", "Checking again", at: 3, phase: "commentary")
        let final = Self.message("assistant", "Finished", at: 4, phase: "final_answer")
        let rows = ChatTranscriptRow.collapseCompletedWork(
            [call, answer, commentary, final].map(ChatTranscriptRow.message),
            runWorking: false,
            isMessageVisible: { !$0.content.contains(where: \.isToolCall) })
        let owner = try #require(Self.work(in: rows).first)
        #expect(owner.rollupMessages?.map(\.id) == [commentary.id])
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

    @Test func `proof commentary folds but untagged answer stays outside work`() throws {
        let user = Self.message("user", "Inspect the files", at: 1000)
        let commentary = Self.message("assistant", "Checking the files first.", at: 2000, phase: "commentary")
        let result = Self.message("toolResult", "ready", at: 3000)
        let answer = Self.message("assistant", "README and Package look fine; checking the changelog next.", at: 4000)
        let final = Self.message("assistant", "The checks are complete.", at: 5000, phase: "final_answer")
        let rows = Self.collapse([user, commentary, result, answer, final])
        #expect(Self.visibleIDs(rows) == [user.id, answer.id, final.id])
        let work = try #require(Self.work(in: rows).first)
        #expect(work.messages.map(\.id) == [commentary.id, result.id])
    }

    @Test func `unpaired calls count as operations without unknown outcomes`() {
        let call = Self.toolCall(at: 1)
        let work = ChatTranscriptRow.CompletedWork(
            anchorID: call.id,
            messages: [call],
            durationMilliseconds: nil)
        #expect(ChatCompletedWorkSummary.label(work: work, expanded: false) == "1 read")
    }

    @Test func `display filtering drops hidden tools and empty work sections`() throws {
        let call = Self.toolCall(at: 1)
        let commentary = Self.message("assistant", "Checking", at: 2, phase: "commentary")
        let work = ChatTranscriptRow.CompletedWork(
            anchorID: call.id,
            messages: [call, commentary],
            durationMilliseconds: nil,
            rollupID: call.id,
            rollupMessages: [call, commentary])
        // Tool activity hidden: only the commentary text survives.
        let filtered = try #require(work.filteringMessages { !$0.content.contains(where: \.isToolCall) })
        #expect(filtered.messages.map(\.id) == [commentary.id])
        #expect(filtered.rollupMessages?.map(\.id) == [commentary.id])
        #expect(work.filteringMessages { _ in false } == nil)
    }

    @Test func `summary counts paired calls once and excludes orphan results`() {
        let calls = (0..<3).map { index in
            OpenClawChatMessage(
                role: "assistant",
                content: [.init(
                    type: "tool_use", id: "call-\(index)", name: index == 0 ? "exec" : "read")],
                timestamp: Double(index),
                transcriptRunID: "summary")
        }
        let results = (0..<3).map { index in
            OpenClawChatMessage(
                role: "toolResult",
                content: [.init(type: "text", text: "ready")],
                timestamp: Double(index + 3),
                transcriptRunID: "summary",
                toolCallId: "call-\(index)")
        }
        let orphan = OpenClawChatMessage(
            role: "toolResult",
            content: [.init(type: "text", text: "orphan")],
            timestamp: 7,
            transcriptRunID: "summary",
            toolCallId: "missing")
        let messages = calls + results + [orphan]
        let items = ChatCompletedWorkSummary.items(messages)
        #expect(items.count == 3)
        #expect(items.allSatisfy { $0.displayState == .finished })
        let work = ChatTranscriptRow.CompletedWork(
            anchorID: calls[0].id,
            messages: messages,
            durationMilliseconds: nil)
        let label = ChatCompletedWorkSummary.label(work: work, expanded: true)
        #expect(label == "1 command · 2 reads")
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

        #expect(work.messages.map(\.id) == [progress.id, tool.id])
        #expect(work.durationMilliseconds == nil)
        #expect(Self.visibleIDs(rows) == [
            user.id,
            answer.id,
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
        // PLAN commentary rule: only explicit progress folds; failed and unfinished tails stay exposed.
        #expect(Self.work(in: rows).map { $0.messages.map(\.id) } == [[progress.id]])
        #expect(Self.visibleIDs(rows) == [final.id, failed.id, unfinished.id, unfinished.id])
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
        // PLAN live items 1 and 5: each continuation retains its own folded segment.
        #expect(Self.work(in: Self.collapse(source, working: true)).map { $0.messages.map(\.id) } ==
            [[source[1].id], [source[3].id], [source[5].id], [source[8].id]])
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

    @Test func `live turns fold into segments while search remains expanded`() {
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
            .first.map { if case .completedWork = $0 { return true }
                return false
            } == true)
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

    @Test func `steer continuations keep live ancestors expanded and finish on their own side of input`() {
        let original = Self.message("user", "Start", at: 1000, run: "original")
        let work = Self.toolCall(at: 2000)
        let steer = Self.message("user", "Use blue", at: 3000, run: "steer", steer: "original")
        let continuedWork = Self.toolCall(at: 4000)
        let answer = Self.message("assistant", "Finished", at: 6000)
        let source = [original, work, steer, continuedWork, answer]
        // PLAN live items 1 and 5: both sides of a steer retain folded work segments.
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
        // PLAN commentary rule: keyed stream-fallback commentary folds with its tools.
        let projected = Self.collapse(refreshed)
        #expect(Self.work(in: projected).first?.messages.map(\.id) == Array(refreshed.prefix(3)).map(\.id))
        #expect(Self.visibleIDs(projected) == [refreshed[3].id])
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
        #expect(Self.visibleIDs(Self.collapse(decoded + [final])) == [final.id])

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
        #expect(frozen.rollupID == nil)
    }

    @Test func `finish assigns one summary owner without reparenting visible answers`() {
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
        #expect(owner.rollupMessages?.count == 2)
        #expect(segment.rollupMessages == nil)
        #expect(owner.rollupID == segment.rollupID)
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

    @Test func `provider shapes survive wire roundtrip and fold only tagged text`() throws {
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
                #expect(visible == (tagged ? [middle.rawText, closing.rawText] :
                        [opening.rawText, middle.rawText, closing.rawText]))
                let folded = rows.flatMap { row -> [OpenClawChatMessage] in
                    if case let .completedWork(w) = row { return w.messages }
                    return []
                }
                #expect(folded.contains { $0.rawText == opening.rawText } == tagged)
                #expect(!folded.contains { $0.rawText == middle.rawText || $0.rawText == closing.rawText })
            }
        }
    }

    @Test func `rollup identity survives prepended older work`() {
        let older = self.tool("grep", at: 0)
        let first = self.tool("read", at: 1)
        let second = self.tool("exec", at: 2)
        let final = OpenClawChatMessage(
            role: "assistant",
            content: [.init(type: "text", text: "Done")],
            timestamp: 3,
            transcriptRunID: "live",
            phase: "final_answer")
        let before = ChatTranscriptRow.collapseCompletedWork(
            [.message(first), .message(second), .message(final)], runWorking: false)
        let after = ChatTranscriptRow.collapseCompletedWork(
            [.message(older), .message(first), .message(second), .message(final)], runWorking: false)
        let beforeID = before.compactMap { row -> UUID? in
            if case let .completedWork(work) = row { return work.rollupID }
            return nil
        }.first
        let afterID = after.compactMap { row -> UUID? in
            if case let .completedWork(work) = row { return work.rollupID }
            return nil
        }.first
        #expect(beforeID != nil)
        #expect(beforeID == afterID)
    }

    @Test func `commentary-only frozen segment has no category summary`() {
        let commentary = OpenClawChatMessage(
            role: "assistant",
            content: [.init(type: "text", text: "Checking")],
            timestamp: 1,
            transcriptRunID: "live",
            phase: "commentary")
        let answer = OpenClawChatMessage(
            role: "assistant",
            content: [.init(type: "text", text: "Answer")],
            timestamp: 2,
            transcriptRunID: "live")
        let rows = ChatTranscriptRow.collapseCompletedWork(
            [.message(commentary), .message(answer)], runWorking: true)
        guard let firstRow = rows.first, case let .completedWork(frozen) = firstRow else {
            Issue.record("Expected frozen commentary segment")
            return
        }
        #expect(!frozen.isLive)
        #expect(ChatCompletedWorkSummary.label(work: frozen, expanded: false).isEmpty)
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
        #expect(updated.messages.filter { $0.rawText == "Checking" }.count == 1)
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
