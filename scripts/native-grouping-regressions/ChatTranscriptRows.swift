import Foundation

enum ChatTranscriptRow: Hashable, Identifiable {
    enum SystemNoticeKind: Hashable {
        case restartRecovery
        case gatewayRestarted
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
            case .generic:
                String(localized: "System")
            }
        }

        var systemImage: String {
            "cpu"
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
        case let .message(message): message.id
        case let .systemNotice(notice): notice.id
        case let .historyDivider(divider): divider.id
        case let .completedWork(work): work.id
        }
    }

    var startsTurn: Bool {
        switch self {
        case let .message(message):
            message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "user" ||
                message.turnBoundary == true || message.isForwardedTurnBoundary
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

        for message in messages {
            guard ["toolresult", "tool_result"].contains(message.role.lowercased()) else {
                result.append(message)
                continue
            }

            guard let toolCallId = message.toolCallId,
                  let last = result.last,
                  message.turnBoundary != true,
                  !message.isForwardedTurnBoundary,
                  !last.isForwardedTurnBoundary,
                  message.transcriptRunID == nil || last.transcriptRunID == nil ||
                  message.transcriptRunID == last.transcriptRunID,
                  (last.content.contains { $0.isToolCall && $0.id == toolCallId } || last.toolCallId == toolCallId)
            else {
                result.append(message)
                continue
            }

            let toolText = ChatMessageVisibleText.displayText(in: message, includeThinking: false)
            var content = last.content
            // Preserve empty results too: receiving a result owns the outcome,
            // independently of whether it contains display text.
            content.append(
                OpenClawChatMessageContent(
                    type: "tool_result",
                    text: toolText,
                    thinking: nil,
                    thinkingSignature: nil,
                    mimeType: nil,
                    fileName: nil,
                    content: nil,
                    id: toolCallId,
                    name: message.toolName,
                    arguments: nil,
                    details: message.details,
                    isError: message.isError))

            let merged = OpenClawChatMessage(
                id: last.id,
                role: last.role,
                content: content,
                timestamp: last.timestamp,
                transcriptMessageID: last.transcriptMessageID,
                transcriptRunID: last.transcriptRunID,
                isTruncated: last.isTruncated,
                idempotencyKey: last.idempotencyKey,
                toolCallId: last.toolCallId,
                toolName: last.toolName,
                usage: last.usage,
                stopReason: last.stopReason,
                errorMessage: last.errorMessage,
                details: last.details,
                isError: last.isError,
                provenance: last.provenance,
                historyMarker: last.historyMarker,
                phase: last.phase,
                turnBoundary: last.turnBoundary,
                steerTargetRunID: last.steerTargetRunID,
                streamFallback: last.streamFallback,
                activity: message.activity.map { terminal in
                    (last.activity ?? []).filter { $0.toolCallId != toolCallId } + terminal
                } ?? last.activity)
            result[result.count - 1] = merged
        }

        return result
    }

}
