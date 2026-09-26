import Foundation
import OpenClawKit
import Testing
@testable import OpenClawChatUI

@Suite("Completed transcript work")
struct ChatCompletedWorkTests {
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

        #expect(work.messages.map(\.id) == [progress.id, tool.id, trailing.id])
        #expect(work.durationMilliseconds == 6000)
        #expect(Self.visibleIDs(rows) == [user.id, answer.id, failed.id, unresolved.id, independent.id])
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
        #expect(Self.work(in: rows).first?.messages.map(\.id) == [progress.id])
        #expect(Self.visibleIDs(rows) == [firstAnswer.id, mixed.id, media.id])
        #expect(Self.visibleIDs(Self.collapse([progress, Self.toolCall(at: 3000), mixed])) == [mixed.id])
        let legacyFinal = Self.message("assistant", "Legacy final", at: 7000)
        #expect(Self.visibleIDs(Self.collapse([progress, Self.toolCall(at: 3000), legacyFinal])) == [legacyFinal.id])
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
        #expect(Self.work(in: rows).first?.messages.map(\.id) == [progress.id])
        #expect(Self.visibleIDs(rows) == [final.id, failed.id, unfinished.id])
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
        #expect(Self.work(in: Self.collapse(source, working: true)).isEmpty)
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

    @Test func `live turns and search remain expanded while completed earlier turns fold`() {
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
        #expect(Self.work(in: Self.collapse(first + second, working: true)).count == 1)
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

    @Test func `steer continuations keep live ancestors expanded and finish on their own side of input`() {
        let original = Self.message("user", "Start", at: 1000, run: "original")
        let work = Self.toolCall(at: 2000)
        let steer = Self.message("user", "Use blue", at: 3000, run: "steer", steer: "original")
        let continuedWork = Self.toolCall(at: 4000)
        let answer = Self.message("assistant", "Finished", at: 6000)
        let source = [original, work, steer, continuedWork, answer]
        #expect(Self.work(in: Self.collapse(source, working: true)).isEmpty)
        let rows = Self.collapse(source)
        #expect(Self.visibleIDs(rows) == [original.id, steer.id, answer.id])
        let groups = Self.work(in: rows)
        #expect(groups.map { $0.messages.map(\.id) } == [[work.id], [continuedWork.id]])
        #expect(groups.map(\.durationMilliseconds) == [5000, 3000])
        let prepended = Self.message("assistant", "Earlier work", at: 1500, phase: "commentary")
        let refreshed = Self.collapse([original, prepended, work, steer, continuedWork, answer])
        #expect(Self.work(in: refreshed).map(\.id) == groups.map(\.id))
    }

    @Test @MainActor func `gateway split projections keep work and stable display IDs`() throws {
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
        let decoded = OpenClawChatViewModel.decodeMessages(raw)
        #expect(decoded.count == 4)
        let refreshed = OpenClawChatViewModel.reconcileMessageIDs(
            previous: decoded, incoming: OpenClawChatViewModel.decodeMessages(raw))
        #expect(refreshed.map(\.id) == decoded.map(\.id))
        #expect(Set(refreshed.map(\.id)).count == 4)
        #expect(Self.work(in: Self.collapse(refreshed)).first?.messages.count == 3)
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
            let roundTrip = try ChatPayloadDecoding.decode(encoded, as: OpenClawChatMessage.self)
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
            } else { nil }
        }
    }

    private static func visibleIDs(_ rows: [ChatTranscriptRow]) -> [UUID] {
        rows.compactMap {
            if case let .message(message) = $0 {
                message.id
            } else { nil }
        }
    }
}
