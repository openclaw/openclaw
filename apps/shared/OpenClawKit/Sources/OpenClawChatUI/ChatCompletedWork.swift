import Foundation

extension ChatTranscriptRow {
    struct CompletedWork: Hashable {
        let anchorID: UUID
        let messages: [OpenClawChatMessage]
        let durationMilliseconds: Double?

        var id: UUID {
            // Separate the disclosure from its still-visible answer without tying
            // its identity to the first work row, which changes on history prepend.
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
            guard !liveTurns.contains(index), let terminal = terminalReplies[index] else { return turn }
            let finalIndex = finalIndexes[index]
            var start = finalIndex ?? turn.count - 1
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
            var work: [OpenClawChatMessage] = []
            var answers: [Self] = []
            for cursor in start...end {
                let row = turn[cursor]
                if cursor != finalIndex,
                   let message = row.workMessage,
                   message.isCollapsibleWork,
                   (finalIndex.map { cursor < $0 } ?? true) || !message.hasUnresolvedWork
                {
                    work.append(message)
                } else {
                    answers.append(row)
                }
            }
            guard let first = work.first else { return turn }
            let boundaryTimestamp = turn.first?.startsTurn == true ? turn.first?.workTimestamp : nil
            let began = boundaryTimestamp ?? first.timestamp
            let finished = (work.compactMap(\.timestamp) + [terminal.timestamp].compactMap(\.self)).max()
            let duration = began.flatMap { start in
                finished.flatMap { end in end.isFinite && start.isFinite && end > start ? end - start : nil }
            }
            let anchor = finalIndex == nil ? continuations[index].map { turns[$0][0].id } : nil
            return Array(turn[..<start]) + [.completedWork(CompletedWork(
                anchorID: anchor ?? terminal.id,
                messages: work,
                durationMilliseconds: duration))] + answers + Array(turn[(end + 1)...])
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

    private var workTimestamp: Double? {
        switch self {
        case let .message(message): message.timestamp
        case let .systemNotice(notice): notice.timestamp
        case let .historyDivider(divider): divider.timestamp
        case .completedWork: nil
        }
    }

    private var isWorkOutput: Bool {
        guard let message = self.workMessage else { return false }
        return !message.isForwardedTurnBoundary &&
            ["assistant", "tool", "toolresult", "tool_result"].contains(message.role.lowercased())
    }
}

extension OpenClawChatMessage {
    var isForwardedTurnBoundary: Bool {
        self.provenance?.kind == "inter_session" && self.provenance?.sourceTool == "sessions_send"
    }

    fileprivate var workRunID: String? {
        if let transcriptRunID, !transcriptRunID.isEmpty { return transcriptRunID }
        if let key = self.idempotencyKey, key.hasSuffix(":user") { return String(key.dropLast(5)) }
        let fallbackRunID = self.streamFallback?.runId?.trimmingCharacters(in: .whitespacesAndNewlines)
        return fallbackRunID?.isEmpty == false ? fallbackRunID : nil
    }

    private var hasWorkMedia: Bool {
        self.content.contains { $0.isInlineAttachment || $0.preview?.inlineWidgetPath != nil }
    }

    fileprivate var hasWorkReplyContent: Bool {
        self.hasWorkMedia || (self.role.lowercased() == "assistant" && ChatMessageVisibleText.hasVisibleText(in: self))
    }

    private var workPhase: String? {
        if self.streamSegmentID != nil { return "commentary" }
        struct Signature: Decodable {
            let v: Int?
            let phase: String?
        }
        let blocks = self.content.filter { ChatMessageVisibleText.isVisibleContentType($0.type, role: "assistant") }
        let phases = blocks.map { block -> String? in
            guard let data = block.textSignature?.data(using: .utf8),
                  let signature = try? JSONDecoder().decode(Signature.self, from: data),
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

    var isCompletedReply: Bool {
        self.role.lowercased() == "assistant" && !self.isForwardedTurnBoundary &&
            self.hasWorkReplyContent && self.workPhase != "commentary" && !self.hasUnresolvedWork
    }

    fileprivate var isCollapsibleWork: Bool {
        !self.hasWorkMedia && !self.isForwardedTurnBoundary &&
            (["tool", "toolresult", "tool_result"].contains(self.role.lowercased()) ||
                (self.role.lowercased() == "assistant" && self.workPhase != "final_answer"))
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
