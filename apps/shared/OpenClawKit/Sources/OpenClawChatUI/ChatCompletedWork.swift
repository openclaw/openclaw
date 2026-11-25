import Foundation

extension ChatTranscriptRow {
    struct CompletedWork: Hashable {
        let anchorID: UUID
        let messages: [OpenClawChatMessage]
        let durationMilliseconds: Double?
        /// Adjacent tool-only rows of a turn that did not fold, named by what they did
        /// (web activity runs) rather than by elapsed time.
        var isActivityRun = false

        var id: UUID {
            // Keep the disclosure distinct from its anchor row, including
            // when that message also owns a visible paragraph.
            var bytes = self.anchorID.uuid
            bytes.0 ^= 0x80
            return UUID(uuid: bytes)
        }

        /// The same disclosure showing only `messages`, for presentation filters.
        func replacingMessages(_ messages: [OpenClawChatMessage]) -> Self {
            Self(
                anchorID: self.anchorID,
                messages: messages,
                durationMilliseconds: self.durationMilliseconds,
                isActivityRun: self.isActivityRun)
        }
    }

    static func collapseCompletedWork(
        _ rows: [Self],
        runWorking: Bool,
        activeRunIDs: Set<String> = [],
        searchActive: Bool = false,
        runDurations: [String: Double]? = nil) -> [Self]
    {
        guard !searchActive else { return rows }
        let runDurations = runDurations ?? Self.runDurations(in: rows, activeRunIDs: activeRunIDs)
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
            let isFenced = ownership.fenced[index]
            // A handoff's closing line describes the whole request, not one run's work.
            guard !liveTurns.contains(index), terminalReplies[index] != nil,
                  !turn.contains(where: { $0.workMessage?.hasConfirmedHandoff == true })
            else { return isFenced ? turn : Self.coalescingActivityRuns(turn) }
            let continuationID = continuations[index].flatMap { turns[$0].first?.id }
            if isFenced {
                return Self.foldingNestedWork(
                    in: turn,
                    finalIndex: finalIndexes[index],
                    runID: ownership.runIDs[index],
                    continuationID: continuationID,
                    runDurations: runDurations)
            }
            return Self.coalescingActivityRuns(Self.foldingWork(
                in: turn,
                finalIndex: finalIndexes[index],
                continuationID: continuationID,
                runDurations: runDurations))
        }
    }

    /// Tool-only rows that nothing visible separates become one disclosure; a lone call stays
    /// its own row. Narration, answers, failures that ended a run and input boundaries bound a
    /// run (web coalesceActivityRuns and isActivityGroup, chat-turn-presentation.ts:494-582).
    private static func coalescingActivityRuns(_ rows: [Self]) -> [Self] {
        var result: [Self] = []
        var run: [OpenClawChatMessage] = []
        func flush() {
            defer { run = [] }
            // Hidden yield context rides along without counting as an operation.
            let operations = run.reduce(0) { $0 + ChatToolActivity.items(message: $1).count }
            guard operations > 1, let first = run.first else {
                result.append(contentsOf: run.map(Self.message))
                return
            }
            result.append(.completedWork(CompletedWork(
                anchorID: first.presentationID,
                messages: run,
                durationMilliseconds: nil,
                isActivityRun: true)))
        }
        for row in rows {
            // A row that starts a turn keeps its own place so turn ownership stays visible; a
            // launch stays its own row and bounds the logs around it.
            if case let .message(message) = row, message.isActivityRow, !row.startsTurn,
               !message.recordsSessionLaunch
            {
                run.append(message)
                continue
            }
            flush()
            result.append(row)
        }
        flush()
        return result
    }

    /// One "Worked" disclosure above the answers of a completed turn's output segment
    /// (web collapseCompletedTurnWork, chat-turn-presentation.ts:332-488). `finalIndex` is nil
    /// when a later steer turn continues this one and owns its answer.
    private static func foldingWork(
        in turn: [Self],
        finalIndex: Int?,
        continuationID: UUID?,
        runDurations: [String: Double]) -> [Self]
    {
        var start = finalIndex ?? turn.count - 1
        guard turn[start].isWorkOutput else { return turn }
        var end = start
        while start > 0, turn[start - 1].isWorkOutput {
            start -= 1
        }
        // Output after the answer belongs to it only when its run has a visible reply;
        // an independent reply-less run keeps its own activity (web :366-394).
        let replyRuns = Set(turn.compactMap { row -> String? in
            guard let message = row.workMessage, message.hasWorkReplyContent else { return nil }
            return message.workRunID
        })
        while end + 1 < turn.count, turn[end + 1].isWorkOutput {
            if let runID = turn[end + 1].workMessage?.workRunID, !replyRuns.contains(runID) { break }
            end += 1
        }
        // A later run's answer must not demote an earlier run's reply to work; a run that
        // ended in failure has no reply (web :395-414).
        let replyRunID = finalIndex.flatMap { turn[$0].workMessage?.workRunID }
        var earlierReplies = Set<Int>()
        if let finalIndex, let replyRunID {
            var answeredRuns: Set<String> = [replyRunID]
            for cursor in stride(from: finalIndex - 1, through: start, by: -1) {
                guard let message = turn[cursor].workMessage, let runID = message.workRunID,
                      !answeredRuns.contains(runID) else { continue }
                if message.endsRunInFailure {
                    answeredRuns.insert(runID)
                } else if message.isFinalReply {
                    answeredRuns.insert(runID)
                    earlierReplies.insert(cursor)
                }
            }
        }
        // Each visible answer bounds its own work. Keep later runs' tools below earlier answers.
        var projected = Array(turn[..<start])
        var lowerBound = start
        for reply in earlierReplies.sorted() {
            projected += Self.foldOutput(
                in: turn,
                range: lowerBound...reply,
                finalIndex: reply,
                continuationID: nil,
                runDurations: runDurations)
            lowerBound = reply + 1
        }
        projected += Self.foldOutput(
            in: turn,
            range: lowerBound...end,
            finalIndex: finalIndex,
            continuationID: continuationID,
            runDurations: runDurations)
        return projected + Array(turn[(end + 1)...])
    }

    private static func foldOutput(
        in turn: [Self],
        range: ClosedRange<Int>,
        finalIndex: Int?,
        continuationID: UUID?,
        runDurations: [String: Double]) -> [Self]
    {
        var work: [OpenClawChatMessage] = []
        var answers: [(row: Self, cursor: Int)] = []
        for cursor in range {
            guard let source = turn[cursor].workMessage else {
                answers.append((turn[cursor], cursor))
                continue
            }
            if source.role.lowercased() == "assistant", !source.hasWorkReplyContent,
               !source.content.contains(where: \.isWorkContent)
            {
                continue
            }
            // Only a later answer can put a failed result inside completed work (web :420-428).
            let canFold = (finalIndex.map { cursor < $0 } ?? true) ||
                (!source.hasUnresolvedWork && !source.endsRunInFailure)
            // Launches stay visible beside the answers: a reader must always see which agents started.
            if canFold, cursor != finalIndex, source.foldsAsWork,
               !source.recordsSessionLaunch
            {
                work.append(source)
                continue
            }
            // Answers keep their text; tools recorded inside an answer's envelope still fold.
            for part in source.workPresentationParts {
                if canFold, part.isCollapsibleWork, !part.recordsSessionLaunch {
                    work.append(part)
                } else {
                    answers.append((Self.message(part), cursor))
                }
            }
        }
        // Text alone is not work: a fold needs tool activity in its output segment (calls,
        // results or reasoning, folded or kept on an unresolved row), so a turn of plain
        // replies (a greeting, an opening message) never folds.
        guard let last = work.last,
              turn[range].contains(where: { $0.workMessage?.recordsWork == true })
        else { return Array(turn[range]) }
        // History prepends change the first work row, but not the visible boundary
        // that follows it (including a continuing steer turn).
        let anchor = answers.first?.row.id ?? continuationID ?? last.presentationID
        let owner: String? = finalIndex.flatMap { final in
            guard let runID = turn[final].workMessage?.workRunID,
                  answers.filter({ $0.cursor < final }).allSatisfy({ $0.row.workMessage?.workRunID == runID }),
                  work.allSatisfy({ $0.belongsToWorkRun(runID, allowUnknown: true) })
            else { return nil }
            return runID
        }
        return [.completedWork(CompletedWork(
            anchorID: anchor,
            messages: work,
            durationMilliseconds: owner.flatMap { runDurations[$0] }))] + answers.map(\.row)
    }

    /// Elapsed run time: the user input's timestamp to the latest `recordTimestampMs` among the
    /// run's other rows. Live runs have only a partial interval (web chat-turn-presentation.ts:198-249).
    static func runDurations(in rows: [Self], activeRunIDs: Set<String> = []) -> [String: Double] {
        var starts: [String: Double] = [:]
        var ends: [String: Double] = [:]
        for row in rows {
            let messages: [OpenClawChatMessage] = switch row {
            case let .message(message): [message]
            case let .completedWork(work): work.messages
            case .systemNotice, .historyDivider: []
            }
            for message in messages where !message.isForwardedTurnBoundary {
                guard let runID = message.workRunID else { continue }
                if message.role.lowercased() == "user" {
                    if starts[runID] == nil, let timestamp = message.timestamp, timestamp.isFinite, timestamp >= 0 {
                        starts[runID] = timestamp
                    }
                } else if let recordedAt = message.sourceMetadata?.recordTimestampMs, recordedAt.isFinite {
                    ends[runID] = max(ends[runID] ?? -.infinity, recordedAt)
                }
            }
        }
        var durations: [String: Double] = [:]
        for (runID, startedAt) in starts where !activeRunIDs.contains(runID) {
            if let endedAt = ends[runID], endedAt >= startedAt {
                durations[runID] = endedAt - startedAt
            }
        }
        return durations
    }

    /// Nested activity can share its owner's work without moving across visible foreign rows.
    private static func foldingNestedWork(
        in turn: [Self],
        finalIndex: Int?,
        runID: String?,
        continuationID: UUID?,
        runDurations: [String: Double]) -> [Self]
    {
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
        let end = Self.completedWorkEnd(
            in: turn, after: finalIndex ?? turn.count - 1, runID: runID, replyRuns: replyRuns)
        let parts = (start...end).flatMap { cursor -> [(row: Self, kind: ChatWorkPartKind)] in
            let row = turn[cursor]
            guard let source = row.workMessage else { return [(row, .visible)] }
            guard source.belongsToWorkRun(runID, allowUnknown: !source.isNestedToolActivity),
                  !source.recordsSessionLaunch else { return [(row, .visible)] }
            if source.role.lowercased() == "assistant", !source.hasWorkReplyContent,
               !source.content.contains(where: \.isWorkContent) { return [] }
            let canFold = (finalIndex.map { cursor < $0 } ?? true) || !source.hasUnresolvedWork
            return source.workPresentationParts.map { message in
                let kind: ChatWorkPartKind = canFold && message.isCollapsibleWork ? .work : .visible
                return (.message(message), kind)
            }
        }
        let chunks = ChatWorkChunks.project(parts, kind: { $0.kind })
        // One interval can describe a single fold, never several separate work chunks.
        let duration = chunks.lazy.filter(\.isWork).prefix(2).count == 1 && finalIndex != nil ?
            runID.flatMap { runDurations[$0] } : nil
        let projected = chunks.enumerated().flatMap { chunkIndex, chunk -> [Self] in
            guard chunk.isWork else { return chunk.parts.map(\.row) }
            let messages = chunk.parts.compactMap(\.row.workMessage)
            guard let last = messages.last else { return [] }
            // History prepends change the first work row, but not the visible
            // boundary that follows it (including a continuing steer turn).
            let anchor = chunks.dropFirst(chunkIndex + 1).first?.parts.first?.row.id ??
                continuationID ?? last.presentationID
            return [.completedWork(CompletedWork(
                anchorID: anchor,
                messages: messages,
                durationMilliseconds: duration))]
        }
        return Array(turn[..<start]) + projected + Array(turn[(end + 1)...])
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
        // Other turns (including every non-iOS turn) retain the ordinary projection.
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
                    turn.lastIndex(where: { $0.workMessage?.isFinalReply == true }) : nil)
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

    /// The run that produced this row, resolved like the Gateway projection
    /// (packages/gateway-client/src/session-projection-message-identity.ts:69-96): recorded run ID,
    /// then for assistants the stream's run, then the persisted send key without its `:user`
    /// suffix. CLI assistant keys carry the originating run after `cli-assistant:`.
    var workRunID: String? {
        if let runID = Self.projectionRunID(self.transcriptRunID) { return runID }
        let persisted = Self.projectionRunID(self.idempotencyKey)
        guard self.role.lowercased() == "assistant" else { return persisted }
        if let runID = Self.projectionRunID(self.streamFallback?.runId) { return runID }
        guard let persisted, persisted.hasPrefix("cli-assistant:") else { return persisted }
        return ChatPayloadDecoding.trimmedNonEmptyString(String(persisted.dropFirst("cli-assistant:".count)))
    }

    private static func projectionRunID(_ value: String?) -> String? {
        guard let value = ChatPayloadDecoding.trimmedNonEmptyString(value) else { return nil }
        return value.hasSuffix(":user") ? ChatPayloadDecoding.trimmedNonEmptyString(String(value.dropLast(5))) : value
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

    /// Tool output, reasoning, and narration that is not an explicit final answer; media and spoken
    /// renditions stay visible (web isCollapsibleWorkGroup, chat-turn-presentation.ts:131-147).
    /// Visible text is narration only when it is marked commentary, stopped for tool use, or rides
    /// with tool blocks; a plain earlier reply stays visible.
    fileprivate var foldsAsWork: Bool {
        guard !self.isForwardedTurnBoundary, !self.isRealtimeVoiceTranscript, !self.hasWorkMedia else { return false }
        let role = self.role.lowercased()
        if ["tool", "toolresult", "tool_result"].contains(role) { return true }
        guard role == "assistant", self.workPhase != "final_answer" else { return false }
        return !self.hasWorkReplyContent || self.workPhase == "commentary" || self.stoppedForToolUse ||
            self.content.contains { $0.isToolCall || $0.isToolResult }
    }

    /// A tool call or result, or a reasoning step: what makes a fold worth showing.
    fileprivate var recordsWork: Bool {
        ["tool", "toolresult", "tool_result"].contains(self.role.lowercased()) ||
            self.content.contains(where: \.isWorkContent)
    }

    /// A row that shows only tool operations: no narration, media, final answer, or the
    /// failure that ended its run (web isActivityGroup, chat-turn-presentation.ts:497-524).
    fileprivate var isActivityRow: Bool {
        guard !self.isForwardedTurnBoundary, !self.hasWorkMedia else { return false }
        let role = self.role.lowercased()
        if ["tool", "toolresult", "tool_result"].contains(role) { return true }
        return role == "assistant" && !self.hasWorkReplyContent && self.workPhase != "final_answer" &&
            !self.endsRunInFailure && self.content.contains { $0.isToolCall || $0.isToolResult }
    }

    /// Where a reply ends: visible assistant output that is not commentary. Without a phase, a stop
    /// for tool use is commentary. Failures do not disqualify it: a stopped or errored reply still
    /// closes its turn (web isFinalReplyGroup and assistantMessageKind, chat-assistant-reply.ts:93-125).
    fileprivate var isFinalReply: Bool {
        self.role.lowercased() == "assistant" && !self.isForwardedTurnBoundary && !self.isRealtimeVoiceTranscript &&
            self.hasWorkReplyContent && self.workPhase != "commentary" &&
            (self.workPhase != nil || !self.stoppedForToolUse)
    }

    /// The row that ended its run in failure: an error, or an interruption by its owner, a cancel,
    /// or a timeout (web groupEndsRunInFailure and assistantMessageIsInterrupted,
    /// chat-assistant-reply.ts:35-44,111-116).
    fileprivate var endsRunInFailure: Bool {
        self.isOwnerAborted ||
            ["error", "aborted", "cancelled", "canceled", "timeout", "timed_out"]
            .contains(self.stopReason?.lowercased() ?? "")
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
