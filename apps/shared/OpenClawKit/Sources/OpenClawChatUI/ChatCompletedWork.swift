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
        let finalIndexes = turns.enumerated().map { index, turn in
            continuations[index] == nil ? turn.lastIndex(where: { $0.workMessage?.isFinalReply == true }) : nil
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

        let folded = turns.enumerated().flatMap { index, turn -> [Self] in
            guard !liveTurns.contains(index), terminalReplies[index] != nil else { return turn }
            // A turn that handed off keeps its work in place: its closing line reports the
            // whole request, not a rollup timed for one run (web chat-turn-presentation.ts:340-365).
            if turn.contains(where: { $0.workMessage?.hasConfirmedHandoff == true }) { return turn }
            return Self.foldingWork(
                in: turn,
                finalIndex: finalIndexes[index],
                continuationID: continuations[index].flatMap { turns[$0].first?.id },
                runDurations: runDurations)
        }
        return Self.coalescingActivityRuns(folded)
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
        var work: [(message: OpenClawChatMessage, cursor: Int)] = []
        var answers: [(row: Self, cursor: Int)] = []
        for cursor in start...end {
            guard let source = turn[cursor].workMessage else {
                answers.append((turn[cursor], cursor))
                continue
            }
            if source.role.lowercased() == "assistant", !source.hasWorkReplyContent,
               !source.content.contains(where: \.isWorkContent) { continue }
            // Only a later answer can put a failed result inside completed work (web :420-428).
            let canFold = (finalIndex.map { cursor < $0 } ?? true) ||
                (!source.hasUnresolvedWork && !source.endsRunInFailure)
            // Launches stay visible beside the answers: a reader must always see which agents started.
            if canFold, cursor != finalIndex, !earlierReplies.contains(cursor), source.foldsAsWork,
               !source.recordsSessionLaunch
            {
                work.append((source, cursor))
                continue
            }
            // Answers keep their text; tools recorded inside an answer's envelope still fold.
            for part in source.workPresentationParts {
                if canFold, part.isCollapsibleWork, !part.recordsSessionLaunch {
                    work.append((part, cursor))
                } else {
                    answers.append((Self.message(part), cursor))
                }
            }
        }
        guard let last = work.last else { return turn }
        // History prepends change the first work row, but not the visible boundary
        // that follows it (including a continuing steer turn).
        let anchor = answers.first?.row.id ?? continuationID ?? last.message.presentationID
        let owner = Self.workOwnerRunID(
            work: work,
            answers: answers,
            finalIndex: finalIndex,
            replyRunID: replyRunID,
            hasEarlierReplies: !earlierReplies.isEmpty,
            turn: turn,
            end: end)
        return Array(turn[..<start]) +
            [.completedWork(CompletedWork(
                anchorID: anchor,
                messages: work.map(\.message),
                durationMilliseconds: owner.flatMap { runDurations[$0] }))] +
            answers.map(\.row) + Array(turn[(end + 1)...])
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

    /// The reply run that owns folded work, or nil when it spans several runs' replies; mixed-run
    /// work has no single elapsed duration (web chat-turn-presentation.ts:447-474).
    private static func workOwnerRunID(
        work: [(message: OpenClawChatMessage, cursor: Int)],
        answers: [(row: Self, cursor: Int)],
        finalIndex: Int?,
        replyRunID: String?,
        hasEarlierReplies: Bool,
        turn: [Self],
        end: Int) -> String?
    {
        guard let finalIndex, let replyRunID else { return nil }
        guard hasEarlierReplies else {
            // The answer owns the work only when the answers above it belong to its run.
            let aboveAnswer = answers.filter { $0.cursor < finalIndex }
            return aboveAnswer.allSatisfy { $0.row.workMessage?.workRunID == replyRunID } ? replyRunID : nil
        }
        // Earlier runs kept their replies. The first of them owns the work only when all of
        // it is that run's; CLI rows without a run ID belong to the run that follows.
        guard let firstRunID = answers.first?.row.workMessage?.workRunID else { return nil }
        var workRunIDs = Set<String?>()
        for entry in work {
            workRunIDs.insert(entry.message.workRunID ?? turn[(entry.cursor + 1)..<(end + 1)]
                .lazy.compactMap { $0.workMessage?.workRunID }.first)
        }
        return workRunIDs == [firstRunID] ? firstRunID : nil
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
            (["tool", "toolresult", "tool_result"].contains(self.role.lowercased()) ||
                (self.role.lowercased() == "assistant" && self.content.contains(where: \.isWorkContent)))
    }

    /// Tool output, reasoning, and assistant text that is not an explicit final answer, including
    /// narration and interim replies; media and spoken renditions stay visible
    /// (web isCollapsibleWorkGroup, chat-turn-presentation.ts:131-147).
    fileprivate var foldsAsWork: Bool {
        guard !self.isForwardedTurnBoundary, !self.isRealtimeVoiceTranscript, !self.hasWorkMedia else { return false }
        let role = self.role.lowercased()
        if ["tool", "toolresult", "tool_result"].contains(role) { return true }
        return role == "assistant" && self.workPhase != "final_answer"
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
