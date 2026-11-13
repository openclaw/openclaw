import Foundation
import Testing
@testable import OpenClawChatUI

@MainActor
struct ChatTranscriptPresentationTests {
    @Test func unrelatedUpdatesReusePreparationAcrossIndependentReaders() {
        let model = OpenClawChatViewModel(sessionKey: "main", transport: TestChatTransport(historyResponses: []))
        defer { model.detachTransport() }
        let user = Self.message("user", "Inspect the sample.", at: 1)
        let answer = Self.message("assistant", "Sample inspected.", at: 2)
        model.messages = [user, answer]
        let reader = ChatTranscriptPresentation()
        let searchReader = ChatTranscriptPresentation()
        var regular: [ChatTranscriptPresentation.Prepared] = []
        var searched: [ChatTranscriptPresentation.Prepared] = []
        for index in 0..<100 {
            model.input = "Draft \(index)"
            model.contextUsageFraction = Double(index) / 100
            model.outboxStatesByMessageID[user.id] = index.isMultiple(of: 2) ? .queued : .sending
            model.markTimelineChanged()
            regular.append(Self.resolve(reader, model))
            searched.append(Self.resolve(searchReader, model, search: true))
        }
        // Each identity is an actual immutable production preparation, not an injected builder.
        // Hold all results so deallocation cannot recycle an ObjectIdentifier and hide extra work.
        #expect(Set(regular.map(ObjectIdentifier.init)).count == 1)
        #expect(Set(searched.map(ObjectIdentifier.init)).count == 1)
        #expect(regular[0] !== searched[0])
        #expect(regular[0].rows.map(\.id) == [user.id, answer.id])
        #expect(regular[0].visibleTurnStartIDs == [user.id])
        #expect(regular[0].groups.last?.runID == "run")
        #expect(searched[0].groups.allSatisfy { $0.runID == nil })
        #if os(iOS)
        #expect(regular[0].cells.map(\.id) == [.row(user.id), .row(answer.id)])
        #endif
        model.applyStreamingAssistantDisplay("Streaming")
        let streaming = Self.resolve(reader, model)
        #expect(streaming !== regular[0])
        #expect(streaming.groups.last?.includesLive == true)
        for index in 0..<100 {
            model.applyStreamingAssistantDisplay("Streaming word \(index)")
            #expect(Self.resolve(reader, model) === streaming)
        }
        model.applyStreamingAssistantDisplay(nil)
        let settled = Self.resolve(reader, model)
        #expect(settled !== streaming)
        #expect(settled.groups.contains(where: \.includesLive) == false)
    }

    @Test func runAndDisplayChangesPrepareFreshRowsWithoutTimelineNotifications() throws {
        let model = OpenClawChatViewModel(sessionKey: "main", transport: TestChatTransport(historyResponses: []))
        defer { model.detachTransport() }
        let user = Self.message("user", "Inspect the sample.", at: 1)
        let call = OpenClawChatMessage(
            role: "assistant", content: [.init(type: "toolCall", id: "read", name: "read")],
            timestamp: 2, transcriptRunID: "run")
        let result = OpenClawChatMessage(
            role: "toolResult", content: [.init(type: "text", text: "Sample contents")],
            timestamp: 3, transcriptRunID: "run", toolCallId: "read", toolName: "read")
        let answer = Self.message("assistant", "Sample inspected.", at: 4)
        model.messages = [user, call, result, answer]
        let owner = ChatTranscriptPresentation()
        let revision = model.timelineRevision
        var preparations: [ChatTranscriptPresentation.Prepared] = []
        func prepare(
            options: OpenClawChatDisplayOptions = [],
            search: Bool = false,
            collapse: Bool = true,
            onboarding: Bool = false) -> ChatTranscriptPresentation.Prepared
        {
            let prepared = Self.resolve(
                owner, model, options: options, search: search, collapse: collapse, onboarding: onboarding)
            preparations.append(prepared)
            #expect(Self.resolve(
                owner, model, options: options, search: search,
                collapse: collapse, onboarding: onboarding) === prepared)
            return prepared
        }

        let hidden = prepare()
        #expect(hidden.rows.map(\.id) == [user.id, answer.id])
        #expect(hidden.metadata[answer.id]?.timestamp == 4)
        let trace = prepare(options: .assistantTrace)
        #expect(trace.rows.count == 3)
        guard case let .completedWork(work) = trace.rows[1] else {
            Issue.record("Completed tool work should stay in its disclosure")
            return
        }
        #expect(work.messages.count == 1)
        #expect(work.messages[0].content.last?.text == "Sample contents")
        let search = prepare(options: .assistantTrace, search: true)
        #expect(search.rows.map(\.id) == [user.id, call.id, answer.id])
        #expect(search.groups.allSatisfy { $0.runID == nil })
        let expanded = prepare(options: .assistantTrace, collapse: false)
        #expect(expanded.rows.map(\.id) == [user.id, call.id, answer.id])
        #expect(expanded.groups.last?.runID == "run")
        let onboarding = prepare(options: .assistantTrace, onboarding: true)
        #expect(onboarding.visibleTurnStartIDs.isEmpty)

        model.activeSessionRunIDs = ["run"]
        let running = prepare(options: .assistantTrace)
        #expect(running.rows.map(\.id) == [user.id, call.id, answer.id])
        #expect(running.metadata[answer.id] == nil)
        #expect(running.groups.last?.includesLive == true)
        model.activeSessionRunIDs = ["other"]
        let otherRun = prepare(options: .assistantTrace)
        #expect(otherRun.groups.last?.id == .live)
        model.activeSessionRunIDs = []
        model.hasActiveSessionRunWithoutChatSnapshot = true
        let unknownRun = prepare(options: .assistantTrace)
        #expect(unknownRun.groups.last?.id == .live)
        model.hasActiveSessionRunWithoutChatSnapshot = false
        #expect(model.timelineRevision == revision)
        var tool = OpenClawChatPendingToolCall(
            toolCallId: "next", name: "read", args: nil, startedAt: 5, isError: nil)
        tool.runID = "run"
        model.turnToolCallsById[tool.id] = tool
        let withTool = prepare(options: .assistantTrace)
        #expect(withTool.groups.last?.parts.last?.id == "tool:next")
        tool.isComplete = true
        model.turnToolCallsById[tool.id] = tool
        let completedTool = prepare(options: .assistantTrace)
        guard case let .tool(completed) = try #require(completedTool.groups.last?.parts.last) else {
            Issue.record("The latest tool activity should remain in the run")
            return
        }
        #expect(completed.isComplete)
        #expect(Set(preparations.map(ObjectIdentifier.init)).count == 10)
    }

    @Test func narrationHistoryDeletionAndOutboxRowsInvalidateTheRetainedReader() throws {
        let model = OpenClawChatViewModel(sessionKey: "main", transport: TestChatTransport(historyResponses: []))
        defer { model.detachTransport() }
        let first = Self.message("user", "Older request.", at: 1)
        let next = Self.message("user", "Newer request.", at: 2)
        let answer = Self.message("assistant", "Newer answer.", at: 4)
        model.messages = [first, next, answer]
        let owner = ChatTranscriptPresentation()
        let snapshot = ChatReaderHistorySnapshot(messages: model.messages, deletionRevision: 0)
        var preparations: [ChatTranscriptPresentation.Prepared] = []
        func prepare(_ history: ChatReaderHistorySnapshot? = nil) -> ChatTranscriptPresentation.Prepared {
            let result = Self.resolve(owner, model, history: history)
            preparations.append(result)
            #expect(Self.resolve(owner, model, history: history) === result)
            return result
        }
        _ = prepare()
        model.messages = [next, answer]
        let trimmed = prepare(snapshot)
        #expect(trimmed.visibleTurnStartIDs == [first.id, next.id])
        let latest = prepare()
        #expect(latest.visibleTurnStartIDs == [next.id])
        _ = prepare(snapshot)
        model.readerHistoryDeletionRevision += 1
        let deleted = prepare(snapshot)
        #expect(deleted.visibleTurnStartIDs == [next.id])
        model.narration.receive(OpenClawAgentEventPayload(
            runId: "run", seq: 1, stream: "item", ts: 3,
            data: ["kind": .init("preamble"), "phase": .init("end"),
                   "itemId": .init("narration"), "progressText": .init("Checking the sample.")]),
            history: model.messages)
        let narrated = prepare(snapshot)
        #expect(narrated.rows.count == 3)
        guard case let .message(narration) = narrated.rows[1] else {
            Issue.record("Narration should remain inline before the answer")
            return
        }
        #expect(narration.rawText == "Checking the sample.")
        let queued = Self.message("user", "Queued follow-up.", at: 5)
        model.messages.append(queued)
        let outbox = prepare(snapshot)
        #expect(outbox.visibleTurnStartIDs == [next.id, queued.id])
        model.messages.removeLast()
        let removed = prepare(snapshot)
        #expect(removed.visibleTurnStartIDs == [next.id])
        model.messages[1].content = [.init(type: "text", text: "Corrected answer.")]
        let corrected = prepare(snapshot)
        guard case let .message(message) = try #require(corrected.rows.last) else {
            Issue.record("The edited answer should remain visible")
            return
        }
        #expect(message.rawText == "Corrected answer.")
        #expect(Set(preparations.map(ObjectIdentifier.init)).count == 9)
    }

    @Test func splitPartsReuseTheFullCurrentActionMessage() throws {
        let model = OpenClawChatViewModel(sessionKey: "main", transport: TestChatTransport(historyResponses: []))
        defer { model.detachTransport() }
        let envelope = OpenClawChatMessage(
            role: "assistant", content: [
                .init(type: "text", text: "First paragraph."),
                .init(type: "toolCall", id: "read", name: "read"),
                .init(type: "tool_result", text: "Sample contents", id: "read"),
                .init(type: "text", text: "Last paragraph."),
            ], timestamp: 1, transcriptRunID: "run")
        model.messages = [envelope]
        let owner = ChatTranscriptPresentation()
        let prepared = Self.resolve(owner, model, options: .assistantTrace)
        let visibleParts = prepared.rows.compactMap { row -> OpenClawChatMessage? in
            if case let .message(message) = row { return message }
            return nil
        }
        #expect(visibleParts.count == 2)
        let part = try #require(visibleParts.first)
        #expect(part.content.count == 1)
        for row in prepared.rows {
            let parts: [OpenClawChatMessage] = switch row {
            case let .message(message): [message]
            case let .completedWork(work): work.messages
            default: []
            }
            for part in parts { #expect(prepared.actionMessage(for: part) == envelope) }
        }
        #expect(Self.resolve(owner, model, options: .assistantTrace) === prepared)
        model.messages = []
        let removed = Self.resolve(owner, model, options: .assistantTrace)
        // A retained reader fragment absent from current history keeps the previous fallback.
        #expect(removed.actionMessage(for: part) == part)
    }

    private static func resolve(
        _ owner: ChatTranscriptPresentation,
        _ model: OpenClawChatViewModel,
        options: OpenClawChatDisplayOptions = [],
        search: Bool = false,
        collapse: Bool = true,
        onboarding: Bool = false,
        history: ChatReaderHistorySnapshot? = nil) -> ChatTranscriptPresentation.Prepared
    {
        owner.resolve(
            viewModel: model, onboarding: onboarding, displayOptions: options,
            collapsesCompletedWork: collapse, searchActive: search, readerHistory: history)
    }

    private static func message(_ role: String, _ text: String, at timestamp: Double) -> OpenClawChatMessage {
        OpenClawChatMessage(
            role: role, content: [.init(type: "text", text: text)],
            timestamp: timestamp, transcriptRunID: "run")
    }
}
