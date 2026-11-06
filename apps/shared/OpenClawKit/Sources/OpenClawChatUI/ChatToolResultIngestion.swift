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
            var result = self
            result.id = .init()
            result.role = "toolResult"
            result.content = content
            result.transcriptRunID = block.runId ?? self.workRunID
            result.idempotencyKey = nil
            result.toolCallId = block.id
            result.toolName = block.name ?? self.toolName
            result.details = block.details ?? self.details
            result.isError = block.isError ?? self.isError
            result.turnBoundary = userContent.isEmpty && messages.isEmpty ? self.turnBoundary : nil
            result.activity = self.activity?.filter { $0.toolCallId == block.id }
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
