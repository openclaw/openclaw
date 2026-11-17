import Foundation

extension ChatTranscriptRow {
    struct CompletedWork: Hashable {
        let anchorID: UUID
        let messages: [OpenClawChatMessage]
        let durationMilliseconds: Double?
        var isLive = false
        var rollupID: UUID?
        var rollupMessages: [OpenClawChatMessage]?

        var id: UUID {
            // Keep the disclosure distinct from its anchor row, including
            // when that message also owns a visible paragraph.
            var bytes = self.anchorID.uuid
            bytes.0 ^= 0x80
            return UUID(uuid: bytes)
        }

        /// Display-option filtering keeps only visible messages, matching the
        /// pre-fold transcript filter; a section with nothing visible drops out.
        func filteringMessages(_ isVisible: (OpenClawChatMessage) -> Bool) -> Self? {
            let visible = self.messages.filter(isVisible)
            guard !visible.isEmpty else { return nil }
            return CompletedWork(
                anchorID: self.anchorID,
                messages: visible,
                durationMilliseconds: self.durationMilliseconds,
                isLive: self.isLive,
                rollupID: self.rollupID,
                rollupMessages: self.rollupMessages?.filter(isVisible))
        }
    }

    static func collapseCompletedWork(
        _ rows: [Self],
        runWorking: Bool,
        activeRunIDs: Set<String> = [],
        searchActive: Bool = false,
        isMessageVisible: (OpenClawChatMessage) -> Bool = { _ in true }) -> [Self]
    {
        guard !searchActive else { return rows }
        var turns: [[Self]] = []
        for row in rows {
            if let message = row.workMessage, !isMessageVisible(message) { continue }
            if turns.isEmpty || row.startsTurn {
                turns.append([])
            }
            turns[turns.count - 1].append(row)
        }
        guard !turns.isEmpty else { return rows }

        let (continuations, predecessors) = Self.continuationIndexes(in: turns)
        let finalIndexes = turns.enumerated().map { index, turn in
            continuations[index] == nil ? turn.lastIndex(where: { $0.workMessage?.isCompletedReply == true }) : nil
        }
        var terminalReplies = turns.enumerated().map { index, turn in
            finalIndexes[index].flatMap { turn[$0].workMessage }
        }
        for index in turns.indices.reversed() {
            if terminalReplies[index] == nil, let next = continuations[index] {
                terminalReplies[index] = terminalReplies[next]
            }
        }
        var liveTurns = Set<Int>()
        for (index, turn) in turns.enumerated() {
            if (runWorking && index == turns.count - 1) || turn.contains(where: {
                $0.workMessage?.workRunID.map { activeRunIDs.contains($0) } == true
            }) {
                var cursor = index
                liveTurns.insert(cursor)
                while let previous = predecessors[cursor] {
                    liveTurns.insert(previous)
                    cursor = previous
                }
            }
        }

        return turns.enumerated().flatMap { index, turn -> [Self] in
            let isLive = liveTurns.contains(index)
            guard isLive || terminalReplies[index] != nil else { return turn }
            let finalIndex = finalIndexes[index]
            var start = isLive ? turn.count - 1 : (finalIndex ?? turn.count - 1)
            guard turn[start].isWorkOutput else { return turn }
            var end = start
            while start > 0, turn[start - 1].isWorkOutput {
                start -= 1
            }
            let answeredOutput = turn.prefix(finalIndex.map { $0 + 1 } ?? turn.count)
            let replyRuns = Set(answeredOutput.compactMap { row -> String? in
                guard let message = row.workMessage, message.hasWorkReplyContent else { return nil }
                return message.workRunID
            })
            while end + 1 < turn.count, turn[end + 1].isWorkOutput {
                if let runID = turn[end + 1].workMessage?.workRunID, !replyRuns.contains(runID) { break }
                end += 1
            }
            let parts = (start...end).flatMap { cursor -> [(row: Self, kind: ChatWorkPartKind)] in
                let row = turn[cursor]
                guard let source = row.workMessage else { return [(row, .visible)] }
                if source.role.lowercased() == "assistant", !source.hasWorkReplyContent,
                   !source.content.contains(where: \.isWorkContent) { return [] }
                let canFold = isLive || (finalIndex.map { cursor < $0 } ?? true) || !source.hasUnresolvedWork
                return source.workPresentationParts.map { message in
                    let kind: ChatWorkPartKind = canFold && message.isCollapsibleWork ? .work : .visible
                    return (.message(message), kind)
                }
            }
            let chunks = ChatWorkChunks.project(parts, kind: { $0.kind })
            let allWork = chunks.filter(\.isWork).flatMap { $0.parts.compactMap(\.row.workMessage) }
            // History prepends extend the frozen work; the last work row of the
            // turn is stable, while the first changes with older pages.
            let rollupID = isLive ? nil : allWork.last?.presentationID
            var ownsRollup = true
            let projected = chunks.enumerated().flatMap { chunkIndex, chunk -> [Self] in
                guard chunk.isWork else { return chunk.parts.map(\.row) }
                let messages = chunk.parts.compactMap(\.row.workMessage)
                guard let last = messages.last else { return [] }
                // History prepends change the first work row, but not the visible
                // boundary that follows it (including a continuing steer turn).
                let boundary = chunks.prefix(chunkIndex).last?.parts.last?.row.id ??
                    (start > 0 ? turn[start - 1].id : nil)
                let anchor = isLive ? (Self.liveAnchor(for: messages, boundary: boundary) ?? last.presentationID) :
                    (chunks.dropFirst(chunkIndex + 1).first?.parts.first?.row.id ??
                        continuations[index].flatMap { turns[$0].first?.id } ?? last.presentationID)
                let summary = ownsRollup && !isLive ? allWork : nil
                ownsRollup = false
                return [.completedWork(CompletedWork(
                    anchorID: anchor,
                    messages: messages,
                    durationMilliseconds: nil,
                    isLive: isLive && chunkIndex == chunks.count - 1,
                    rollupID: rollupID,
                    rollupMessages: summary))]
            }
            return Array(turn[..<start]) + projected + Array(turn[(end + 1)...])
        }
    }

    private static func continuationIndexes(in turns: [[Self]]) -> (next: [Int: Int], previous: [Int: Int]) {
        var runTurns: [String: Int] = [:]
        var next: [Int: Int] = [:]
        var previous: [Int: Int] = [:]
        var tails: [Int: Int] = [:]
        for (index, turn) in turns.enumerated() {
            guard case let .message(user) = turn.first, user.role.lowercased() == "user" else { continue }
            if let runID = user.workRunID, runTurns[runID] == nil { runTurns[runID] = index }
            guard let target = user.steerTargetRunID,
                  var predecessor = runTurns[target], predecessor < index
            else { continue }
            // A steer targeting an ancestor extends the current end of its chain.
            // Cache the traversed tails so repeated steers remain linear to project.
            var ancestors: [Int] = []
            while let tail = tails[predecessor] {
                ancestors.append(predecessor)
                predecessor = tail
            }
            next[predecessor] = index
            previous[index] = predecessor
            tails[predecessor] = index
            for ancestor in ancestors {
                tails[ancestor] = index
            }
        }
        return (next, previous)
    }

    private var workMessage: OpenClawChatMessage? {
        if case let .message(message) = self { return message }
        return nil
    }

    private var isWorkOutput: Bool {
        guard let message = self.workMessage else { return false }
        return !message.isForwardedTurnBoundary &&
            ["assistant", "tool", "toolresult", "tool_result"].contains(message.role.lowercased())
    }
}

extension OpenClawChatMessage {
    /// The model stopped to call tools, so the run goes on: this row is a step, not where a reply ends.
    var stoppedForToolUse: Bool {
        ["tooluse", "tool_use", "tool_calls"].contains(self.stopReason?.lowercased() ?? "")
    }

    var isForwardedTurnBoundary: Bool {
        self.provenance?.kind == "inter_session" && self.provenance?.sourceTool == "sessions_send"
    }

    var workRunID: String? {
        if let transcriptRunID, !transcriptRunID.isEmpty { return transcriptRunID }
        if let key = self.idempotencyKey, key.hasSuffix(":user") { return String(key.dropLast(5)) }
        return ChatPayloadDecoding.trimmedNonEmptyString(self.streamFallback?.runId)
    }

    private var hasWorkMedia: Bool {
        self.content.contains { $0.isInlineAttachment || $0.preview?.inlineWidgetPath != nil }
    }

    var hasWorkReplyContent: Bool {
        self.hasWorkMedia || (self.role.lowercased() == "assistant" && ChatMessageVisibleText.hasVisibleText(in: self))
    }

    var workPhase: String? {
        if self.streamSegmentID != nil { return "commentary" }
        struct Signature: Decodable {
            let v: Int?
            let phase: String?
        }
        let blocks = self.content.filter { ChatMessageVisibleText.isVisibleContentType($0.type, role: "assistant") }
        let phases = blocks.map { block -> String? in
            guard let text = block.textSignature,
                  let signature = try? JSONDecoder().decode(Signature.self, from: Data(text.utf8)),
                  signature.v == 1,
                  let phase = signature.phase,
                  ["commentary", "final_answer"].contains(phase)
            else { return nil }
            return phase
        }
        if zip(blocks, phases).contains(where: { block, phase in
            phase == "final_answer" && !(block.text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
        }) { return "final_answer" }
        if let phase = self.phase, ["commentary", "final_answer"].contains(phase) { return phase }
        let explicit = Set(phases.compactMap(\.self))
        return explicit.count == 1 ? explicit.first : nil
    }

    public var isCompletedReply: Bool {
        self.presentationCompletedReply != false &&
            self.role.lowercased() == "assistant" && !self.isForwardedTurnBoundary &&
            self.hasWorkReplyContent && self.workPhase != "commentary" && !self.hasUnresolvedWork
    }

    var isCollapsibleWork: Bool {
        !self.hasWorkMedia && (!self.hasWorkReplyContent || self.workPhase == "commentary") && !self
            .isForwardedTurnBoundary && !self
            .isRealtimeVoiceTranscript &&
            (["tool", "toolresult", "tool_result"].contains(self.role.lowercased()) ||
                (self.role.lowercased() == "assistant" &&
                    (self.workPhase == "commentary" || self.content.contains(where: \.isWorkContent))))
    }

    fileprivate var hasUnresolvedWork: Bool {
        if self.isError == true || self.stopReason == "error" || self.stopReason == "aborted" { return true }
        if ["tool", "toolresult", "tool_result"].contains(self.role.lowercased()),
           ChatToolActivity.resultIsError(self.isError, text: ChatMessageVisibleText.visibleText(in: self))
        { return true }
        let results = self.content.filter(\.isToolResult)
        if results.contains(where: { ChatToolActivity.resultIsError($0.isError, text: $0.text) }) { return true }
        return self.content.contains { block in
            block.isToolCall &&
                !results.contains { $0.id != nil && $0.id == block.id }
        }
    }
}

extension OpenClawChatMessage {
    /// A spoken realtime-voice rendition: its own footer identity, never collapsible work.
    var isRealtimeVoiceTranscript: Bool {
        self.provenance?.kind == "realtime_voice" || self.model == "realtime-voice"
    }
}

/// Live tool calls share the completed-work projection with recorded calls.
extension ChatTranscriptRow {
    /// Deterministic identity for a pending call, kept when the recorded row replaces it.
    static func pendingCallID(runID: String?, callID: String) -> UUID {
        var bytes = UUID(uuidString: "00000000-0000-4000-8000-000000000000")!.uuid
        withUnsafeMutableBytes(of: &bytes) { buffer in
            for (index, byte) in "\(runID ?? ""):\(callID)".utf8.enumerated() {
                buffer[index % 16] ^= byte
            }
        }
        return UUID(uuid: bytes)
    }

    /// A live section must keep its disclosure identity when the first recorded
    /// row replaces the pending projection, so anchor on the call's stable key.
    private static func liveAnchor(for messages: [OpenClawChatMessage], boundary: UUID?) -> UUID? {
        guard let first = messages.first else { return nil }
        // Canonical history can prepend work or replace the first pending row.
        // The preceding user/reply boundary does not change during that handoff.
        if let boundary {
            return Self.pendingCallID(runID: first.workRunID, callID: "segment:\(boundary)")
        }
        if let block = first.content.first(where: { $0.isToolCall }), let callID = block.id {
            return Self.pendingCallID(runID: first.workRunID, callID: callID)
        }
        return first.presentationID
    }

    static func projectingLiveTools(
        in base: [OpenClawChatMessage],
        tools: [OpenClawChatPendingToolCall]) -> [OpenClawChatMessage]
    {
        var projectedBase = base
        let recorded = Set(base.flatMap { message in
            message.content.filter(\.isToolCall).compactMap { block in
                block.id.map { "\(message.workRunID ?? ""):\($0)" }
            }
        })
        for tool in tools.sorted(by: {
            if $0.startedAt == $1.startedAt {
                if $0.runID == $1.runID, let left = $0.startSequence, let right = $1.startSequence,
                   left != right { return left < right }
                return $0.id < $1.id
            }
            return ($0.startedAt ?? .infinity) < ($1.startedAt ?? .infinity)
        }) {
            guard !recorded.contains("\(tool.runID ?? ""):\(tool.id)") else { continue }
            var message = OpenClawChatMessage(
                id: Self.pendingCallID(runID: tool.runID, callID: tool.id),
                role: "assistant",
                content: [.init(type: "tool_use", id: tool.id, name: tool.name, arguments: tool.args)],
                timestamp: tool.startedAt,
                transcriptRunID: tool.runID,
                activity: tool.activity.map { [$0] })
            message.liveEventSequence = tool.startSequence
            let position = tool.startedAt.flatMap { start in
                projectedBase.firstIndex { row in
                    guard let timestamp = row.timestamp else { return false }
                    if timestamp != start { return timestamp > start }
                    guard row.workRunID == tool.runID,
                          let left = tool.startSequence, let right = row.liveEventSequence else { return false }
                    return left < right
                }
            } ?? projectedBase.endIndex
            projectedBase.insert(message, at: position)
        }
        return projectedBase
    }
}

extension ChatTranscriptRow {
    static func workRows(
        _ base: [OpenClawChatMessage],
        _ tools: [OpenClawChatPendingToolCall]) -> (Bool, OpenClawChatDisplayOptions) -> [ChatTranscriptRow]
    {
        { enabled, options in
            let projected = enabled && options.contains(.toolActivity)
                ? self.projectingLiveTools(in: base, tools: tools) : base
            return self.build(from: self.mergeToolResults(in: projected))
        }
    }
}

extension ChatTranscriptRow {
    static func fallbackTools(_ tools: [OpenClawChatPendingToolCall])
        -> (OpenClawChatDisplayOptions, Bool) -> [OpenClawChatPendingToolCall]
    {
        { options, folding in options.contains(.toolActivity) && !folding ? tools : [] }
    }
}
