import Foundation
import OpenClawKit

extension OpenClawChatMessage {
    /// Claude CLI history uses user rows to carry one or more tool results.
    /// Expand those rows before they reach turn ownership or presentation.
    var ingestedMessages: [OpenClawChatMessage] {
        guard self.role.lowercased() == "user", self.content.contains(where: \.isToolResult) else {
            return [self]
        }
        let userContent = self.content.filter { !$0.isToolResult }
        var messages: [OpenClawChatMessage] = []
        for block in self.content where block.isToolResult {
            let nested = block.content.flatMap { payload -> [OpenClawChatMessageContent]? in
                if let text = payload.stringValue { return [.init(type: "text", text: text)] }
                return try? GatewayPayloadDecoding.decode(payload, as: [OpenClawChatMessageContent].self)
            } ?? []
            let content = block.text.map { [OpenClawChatMessageContent(type: "text", text: $0)] } ?? nested
            var result = OpenClawChatMessage(
                role: "toolResult",
                content: content,
                timestamp: self.timestamp,
                transcriptMessageID: self.transcriptMessageID,
                transcriptRunID: block.runId ?? self.workRunID,
                isTruncated: self.isTruncated,
                toolCallId: block.id,
                toolName: block.name ?? self.toolName,
                usage: self.usage,
                model: self.model,
                stopReason: self.stopReason,
                errorMessage: self.errorMessage,
                details: block.details ?? self.details,
                isError: block.isError ?? self.isError,
                provenance: self.provenance,
                historyMarker: self.historyMarker,
                phase: self.phase,
                turnBoundary: userContent.isEmpty && messages.isEmpty ? self.turnBoundary : nil,
                steerTargetRunID: self.steerTargetRunID,
                streamFallback: self.streamFallback,
                activity: self.activity?.filter { $0.toolCallId == block.id })
            result.sourceMetadata = self.sourceMetadata
            result.senderLabel = self.senderLabel
            result.senderSession = self.senderSession
            messages.append(result)
        }
        if !userContent.isEmpty {
            var user = self
            user.content = userContent
            messages.append(user)
        }
        return messages
    }
}
