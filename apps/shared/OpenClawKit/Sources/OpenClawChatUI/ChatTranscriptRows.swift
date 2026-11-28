import Foundation

enum ChatTranscriptRow: Hashable, Identifiable {
    enum SystemNoticeKind: Hashable {
        case restartRecovery
        case gatewayRestarted
        case disclosure(label: String)
        case generic
    }

    struct SystemNotice: Hashable {
        let id: UUID
        let kind: SystemNoticeKind
        let body: String
        let timestamp: Double?

        var label: String {
            switch self.kind {
            case .restartRecovery:
                String(localized: "System · restart recovery")
            case .gatewayRestarted:
                String(localized: "System · gateway restarted")
            case let .disclosure(label):
                label
            case .generic:
                String(localized: "System")
            }
        }

        var systemImage: String {
            "cpu"
        }

        var collapsesBody: Bool {
            if case .disclosure = self.kind { return true }
            return false
        }
    }

    enum HistoryDividerKind: Hashable {
        case compaction
        case reset
    }

    struct HistoryDivider: Hashable {
        let id: UUID
        let kind: HistoryDividerKind
        let savedTokens: Double?
        let timestamp: Double?

        var label: String {
            switch self.kind {
            case .compaction:
                String(localized: "Compacted history")
            case .reset:
                String(localized: "Session reset")
            }
        }

        var metric: String? {
            guard self.kind == .compaction, let savedTokens else { return nil }
            return String(
                format: String(localized: "saved %@ tokens"),
                ChatCompactTokenCountFormatter.string(savedTokens))
        }

        var description: String? {
            switch self.kind {
            case .compaction:
                nil
            case .reset:
                String(localized: "The earlier conversation was cleared.")
            }
        }

        var systemImage: String {
            switch self.kind {
            case .compaction:
                "rectangle.compress.vertical"
            case .reset:
                "arrow.counterclockwise"
            }
        }
    }

    case message(OpenClawChatMessage)
    case systemNotice(SystemNotice)
    case historyDivider(HistoryDivider)
    case completedWork(CompletedWork)

    var id: UUID {
        switch self {
        case let .message(message): message.presentationID
        case let .systemNotice(notice): notice.id
        case let .historyDivider(divider): divider.id
        case let .completedWork(work): work.id
        }
    }

    var timestamp: Double? {
        switch self {
        case let .message(message): message.timestamp
        case let .systemNotice(notice): notice.timestamp
        case let .historyDivider(divider): divider.timestamp
        case .completedWork: nil
        }
    }

    var startsTurn: Bool {
        switch self {
        case let .message(message):
            // A continuation keeps the turn it resumes, even where it also carries `turnBoundary`
            // (web chat-turn-boundary.ts:88-102).
            message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "user" ||
                (message.turnBoundary == true && !message.resumesProjectedTurn) || message.isForwardedTurnBoundary
        case .systemNotice:
            true
        case .historyDivider, .completedWork:
            false
        }
    }

    init?(_ message: OpenClawChatMessage) {
        let role = message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if role == "system", let marker = message.historyMarker {
            switch marker.kind {
            case "compaction":
                let savedTokens = Self.savedTokens(for: marker)
                self = .historyDivider(HistoryDivider(
                    id: message.id,
                    kind: .compaction,
                    savedTokens: savedTokens,
                    timestamp: message.timestamp))
            case "reset":
                self = .historyDivider(HistoryDivider(
                    id: message.id,
                    kind: .reset,
                    savedTokens: nil,
                    timestamp: message.timestamp))
            default:
                return nil
            }
            return
        }

        if role == "user", message.provenance?.kind == "internal_system" {
            let kind: SystemNoticeKind
            let body: String
            switch message.provenance?.sourceTool {
            case "main_session_restart_recovery":
                kind = .restartRecovery
                body =
                    String(
                        localized: """
                        Turn interrupted by a gateway restart — asked the agent to resume and finish the response.
                        """)
            case "restart-sentinel":
                kind = .gatewayRestarted
                body = Self.strippingSystemPrefix(from: ChatMessageVisibleText.visibleText(in: message))
            case "cli_harness_context":
                #if os(iOS)
                return nil
                #else
                kind = .disclosure(label: String(localized: "System · injected context"))
                body = Self.strippingSystemPrefix(from: ChatMessageVisibleText.visibleText(in: message))
                #endif
            case "claude_cli_task_notification":
                kind = .disclosure(label: String(localized: "System · background task"))
                body = Self.strippingSystemPrefix(from: ChatMessageVisibleText.visibleText(in: message))
            default:
                kind = .generic
                body = Self.strippingSystemPrefix(from: ChatMessageVisibleText.visibleText(in: message))
            }
            guard !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            self = .systemNotice(SystemNotice(
                id: message.id,
                kind: kind,
                body: body,
                timestamp: message.timestamp))
            return
        }

        self = .message(message)
    }

    static func build(from messages: [OpenClawChatMessage]) -> [Self] {
        messages.compactMap(Self.init)
    }

    private static func savedTokens(for marker: OpenClawChatHistoryMarker) -> Double? {
        guard let before = marker.tokensBefore,
              before.isFinite,
              let after = marker.tokensAfter,
              after.isFinite,
              before > after
        else {
            return nil
        }
        return floor(before - after)
    }

    private static func strippingSystemPrefix(from text: String) -> String {
        let prefix = "[System] "
        return text.hasPrefix(prefix) ? String(text.dropFirst(prefix.count)) : text
    }
}

extension ChatTranscriptRow {
    static func mergeToolResults(in messages: [OpenClawChatMessage]) -> [OpenClawChatMessage] {
        var result: [OpenClawChatMessage] = []
        result.reserveCapacity(messages.count)
        var callIndexes: [String: Int] = [:]

        for message in messages {
            // Narration can separate calls from results, but an input or history
            // boundary ends their lookup scope even when a run ID is reused.
            if Self(message)?.startsTurn == true || message.historyMarker != nil {
                callIndexes.removeAll(keepingCapacity: true)
            }
            guard message.isToolResult,
                  let toolCallId = message.toolCallId,
                  let index = callIndexes[toolCallId],
                  (message.workRunID != nil && message.workRunID == result[index].workRunID) ||
                  (index == result.count - 1 &&
                      (message.workRunID == nil || result[index].workRunID == nil))
            else {
                if !message.isForwardedTurnBoundary {
                    for block in message.content where block.isToolCall {
                        if let id = block.id { callIndexes[id] = result.count }
                    }
                    if let id = message.toolCallId { callIndexes[id] = result.count }
                }
                result.append(message)
                continue
            }

            var merged = result[index]
            let toolText = ChatMessageVisibleText.displayText(in: message, includeThinking: false)
            // Preserve empty results too: receiving a result owns the outcome,
            // independently of whether it contains display text.
            merged.content.append(
                OpenClawChatMessageContent(
                    type: "tool_result",
                    text: toolText,
                    id: toolCallId,
                    name: message.toolName,
                    details: message.details,
                    isError: message.isError))

            if let terminal = message.activity {
                merged.activity = (merged.activity ?? []).filter { $0.toolCallId != toolCallId } + terminal
            }
            result[index] = merged
        }

        return result
    }
}

extension ChatTranscriptRow {
    /// Tool search records each call twice: the dispatcher's own call (with its result) and a nested
    /// row whose call names it as `parentToolCallId`. Both are one invocation with one outcome, so the
    /// nested row presents it and the envelope leaves the transcript (web chat-message.tools.test.tsx:532-534).
    /// Other containers (a code-mode `exec`) keep their row: their own outcome can differ from a child's.
    static func retiringDispatchEnvelopes(in messages: [OpenClawChatMessage]) -> [OpenClawChatMessage] {
        let parents = Set(messages.lazy.filter(\.isNestedToolActivity).flatMap(\.content)
            .compactMap(\.parentToolCallId))
        guard !parents.isEmpty else { return messages }
        return messages.compactMap { message in
            if message.isToolResult {
                let retired = message.toolCallId.map(parents.contains) == true &&
                    ChatToolActivity.isDispatcher(message.toolName)
                return retired ? nil : message
            }
            guard message.role.lowercased() == "assistant" else { return message }
            let retired = Set(message.content.compactMap { block -> String? in
                guard block.isToolCall, ChatToolActivity.isDispatcher(block.name),
                      let id = block.id, parents.contains(id) else { return nil }
                return id
            })
            guard !retired.isEmpty else { return message }
            var kept = message
            kept.content = message.content.filter { block in
                !(block.isToolCall || block.isToolResult) || block.id.map(retired.contains) != true
            }
            kept.activity = message.activity?.filter { $0.toolCallId.map(retired.contains) != true }
            // A message that carried only envelopes would otherwise split the activity around it.
            return kept.content.isEmpty ? nil : kept
        }
    }
}

extension OpenClawChatMessage {
    /// A row woken by its own exec, a restart, or a subagent: it resumes this session's work.
    var resumesProjectedTurn: Bool {
        ["exec", "restart", "subagent"].contains(self.sourceMetadata?.continuation?.source ?? "")
    }
}
