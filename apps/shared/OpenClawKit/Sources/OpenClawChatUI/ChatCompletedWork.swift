import Foundation

extension ChatTranscriptRow {
    struct CompletedWork: Hashable {
        let anchorID: UUID
        let messages: [OpenClawChatMessage]
        let durationMilliseconds: Double?

        var id: UUID {
            // Keep the disclosure distinct from its anchor row, including
            // when that message also owns a visible paragraph.
            var bytes = self.anchorID.uuid
            bytes.0 ^= 0x80
            return UUID(uuid: bytes)
        }
    }

    static func collapseCompletedWork(
        _ rows: [Self],
        runWorking: Bool,
        activeRunIDs: Set<String> = [],
        searchActive: Bool = false) -> [Self]
    {
        guard !searchActive else { return rows }
        var turns: [[Self]] = []
        for row in rows {
            if turns.isEmpty || row.startsTurn {
                turns.append([])
            }
            turns[turns.count - 1].append(row)
        }
        guard !turns.isEmpty else { return rows }

        let (continuations, predecessors) = Self.continuationIndexes(in: turns)
        let ownership = Self.completedWorkOwnership(
            in: turns, continuations: continuations, predecessors: predecessors)
        let finalIndexes = ownership.finalIndexes
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
            guard !liveTurns.contains(index), terminalReplies[index] != nil else { return turn }
            let finalIndex = finalIndexes[index]
            var start = finalIndex ?? turn.count - 1
            guard turn[start].isWorkOutput else { return turn }
            while start > 0, turn[start - 1].isWorkOutput {
                start -= 1
            }
            let answeredOutput = turn.prefix(finalIndex.map { $0 + 1 } ?? turn.count)
            let replyRuns = Set(answeredOutput.compactMap { row -> String? in
                guard let message = row.workMessage, !message.isNestedToolActivity,
                      message.hasWorkReplyContent else { return nil }
                return message.workRunID
            })
            // A continuing steer may borrow its successor's terminal reply, never its ownership.
            let turnRunID = ownership.runIDs[index]
            let end = Self.completedWorkEnd(
                in: turn, after: finalIndex ?? turn.count - 1, runID: turnRunID, replyRuns: replyRuns)
            let parts = (start...end).flatMap { cursor -> [(row: Self, kind: ChatWorkPartKind)] in
                let row = turn[cursor]
                guard let source = row.workMessage else { return [(row, .visible)] }
                let ownsWork = !ownership.fenced[index] ||
                    source.belongsToWorkRun(turnRunID, allowUnknown: !source.isNestedToolActivity)
                guard ownsWork else { return [(row, .visible)] }
                if source.role.lowercased() == "assistant", !source.hasWorkReplyContent,
                   !source.content.contains(where: \.isWorkContent) { return [] }
                let canFold = (finalIndex.map { cursor < $0 } ?? true) || !source.hasUnresolvedWork
                return source.workPresentationParts.map { message in
                    let kind: ChatWorkPartKind = canFold && message.isCollapsibleWork ? .work : .visible
                    return (.message(message), kind)
                }
            }
            let chunks = ChatWorkChunks.project(parts, kind: { $0.kind })
            let projected = chunks.enumerated().flatMap { chunkIndex, chunk -> [Self] in
                guard chunk.isWork else { return chunk.parts.map(\.row) }
                let messages = chunk.parts.compactMap(\.row.workMessage)
                guard let last = messages.last else { return [] }
                // History prepends change the first work row, but not the visible
                // boundary that follows it (including a continuing steer turn).
                let anchor = chunks.dropFirst(chunkIndex + 1).first?.parts.first?.row.id ??
                    continuations[index].flatMap { turns[$0].first?.id } ?? last.presentationID
                return [.completedWork(CompletedWork(
                    anchorID: anchor,
                    messages: messages,
                    durationMilliseconds: nil))]
            }
            return Array(turn[..<start]) + projected + Array(turn[(end + 1)...])
        }
    }

    private static func completedWorkOwnership(
        in turns: [[Self]],
        continuations: [Int: Int],
        predecessors: [Int: Int]) -> (fenced: [Bool], runIDs: [String?], finalIndexes: [Int?])
    {
        var fenced = turns.map { turn in
            turn.contains { row in
                if case let .completedWork(work) = row {
                    return work.messages.contains(where: \.isNestedToolActivity)
                }
                return row.workMessage?.isNestedToolActivity == true
            }
        }
        // Only nested activity and its explicit steer chain need the stricter owner.
        // Other turns (including every non-iOS turn) retain the legacy projection.
        for index in turns.indices.reversed() {
            if let next = continuations[index], fenced[next] { fenced[index] = true }
        }
        for index in turns.indices {
            if let previous = predecessors[index], fenced[previous] { fenced[index] = true }
        }
        var earlierRuns = Set<String>()
        var finalIndexes: [Int?] = []
        let runIDs = turns.enumerated().map { index, turn -> String? in
            let input = turn.first?.workMessage
            let ordinaryReplies = turn.compactMap(\.workMessage).filter {
                $0.role.lowercased() == "assistant" && !$0.isForwardedTurnBoundary && $0.hasWorkReplyContent
            }
            // Bounded history can omit the backing input. Local reply evidence resolves ownership, not a link.
            let steerTarget: String? = input?.steerTargetRunID.flatMap { target in
                guard input?.role.lowercased() == "user" else { return nil }
                return predecessors[index] != nil || ordinaryReplies.contains { $0.workRunID == target } ? target : nil
            }
            let inputRunID = turn.first.flatMap { row -> String? in
                guard row.startsTurn, let input = row.workMessage, !input.isNestedToolActivity else { return nil }
                // A steer request key identifies the input, not the run consuming it.
                if let explicitRunID = input.transcriptRunID, !explicitRunID.isEmpty { return explicitRunID }
                return input.workRunID.map { steerTarget ?? $0 }
            }
            // Explicit reuse or steering may continue an earlier run; an untagged input cannot claim its late reply.
            let acceptsReply = { (reply: OpenClawChatMessage) in
                guard let replyRunID = reply.workRunID else { return true }
                return replyRunID == inputRunID || replyRunID == steerTarget || !earlierRuns.contains(replyRunID)
            }
            let replies = ordinaryReplies.filter(acceptsReply)
            let replyRuns = Set(replies.compactMap(\.workRunID))
            defer {
                if input?.role.lowercased() == "user" {
                    let reliableInputRunID = inputRunID.flatMap { runID in
                        input?.steerTargetRunID == nil || input?.transcriptRunID == runID || steerTarget == runID ?
                            runID : nil
                    }
                    // Do not remember a last-final guess after conflicting replies, or an unsupported request key.
                    if let resolved = reliableInputRunID ?? (replyRuns.count == 1 ? replyRuns.first : nil) {
                        earlierRuns.insert(resolved)
                    }
                }
            }
            guard fenced[index] else {
                finalIndexes.append(continuations[index] == nil ?
                    turn.lastIndex(where: { $0.workMessage?.isCompletedReply == true }) : nil)
                return nil
            }
            let runID = inputRunID ?? replies.last(where: \.isCompletedReply)?.workRunID ??
                (replyRuns.count == 1 ? replyRuns.first : nil)
            finalIndexes.append(continuations[index] == nil ? turn.lastIndex(where: { row in
                guard let reply = row.workMessage, reply.isCompletedReply else { return false }
                return acceptsReply(reply) && reply.belongsToWorkRun(runID, allowUnknown: true)
            }) : nil)
            return runID
        }
        return (fenced, runIDs, finalIndexes)
    }

    private static func completedWorkEnd(
        in turn: [Self], after index: Int, runID: String?, replyRuns: Set<String>) -> Int
    {
        var end = index
        var cursor = index + 1
        while cursor < turn.count, turn[cursor].isWorkOutput {
            guard let next = turn[cursor].workMessage else { break }
            if next.isNestedToolActivity {
                guard next.belongsToWorkRun(runID, allowUnknown: false),
                      cursor == end + 1 || !next.hasUnresolvedWork else { break }
                end = cursor
            } else if cursor == end + 1, next.belongsToWorkRun(runID, allowUnknown: true),
                      next.workRunID.map({ replyRuns.contains($0) }) ?? true
            {
                end = cursor
            } else {
                // Commit this visible foreign-reply span only if it bridges to resolved local nested output.
                guard next.isCompletedReply, !next.belongsToWorkRun(runID, allowUnknown: true),
                      !next.content.contains(where: \.isWorkContent) else { break }
            }
            cursor += 1
        }
        return end
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
            (["assistant", "tool", "toolresult", "tool_result"].contains(message.role.lowercased()) ||
                message.isNestedToolActivity)
    }
}

extension OpenClawChatMessage {
    fileprivate func belongsToWorkRun(_ runID: String?, allowUnknown: Bool) -> Bool {
        // Legacy ordinary history may omit ownership; two known owners must always match.
        guard let sourceRunID = self.workRunID, let runID else { return allowUnknown }
        return sourceRunID == runID
    }

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

    fileprivate var isCollapsibleWork: Bool {
        !self.hasWorkReplyContent && !self.isForwardedTurnBoundary && !self.isRealtimeVoiceTranscript &&
            (["tool", "toolresult", "tool_result"].contains(self.role.lowercased()) || self.isNestedToolActivity ||
                (self.role.lowercased() == "assistant" && self.content.contains(where: \.isWorkContent)))
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
