import Foundation
import OpenClawKit

extension OpenClawChatMessage {
    /// Normalize embedded assistant results and expand user result carriers from CLI history.
    /// Expand those rows before they reach turn ownership or presentation.
    var ingestedMessages: [OpenClawChatMessage] {
        if self.role.lowercased() == "assistant", self.content.contains(where: \.isToolResult) {
            var message = self
            message.content = self.content.map { block in
                guard block.isToolResult, block.text == nil else { return block }
                var result = block
                // Match web extraction without decoding unrelated block metadata.
                if let text = block.content?.stringValue {
                    result.text = text
                } else {
                    let parts = block.content?.arrayValue?.compactMap {
                        $0.dictionaryValue?["text"]?.stringValue
                    } ?? []
                    result.text = parts.isEmpty ? nil : parts.joined(separator: "\n")
                }
                return result
            }
            return [message]
        }
        guard self.role.lowercased() == "user", self.content.contains(where: \.isToolResult) else {
            return [self]
        }
        let userContent = self.content.filter { !$0.isToolResult }
        var messages: [OpenClawChatMessage] = []
        for block in self.content where block.isToolResult {
            let content = block.toolResultContent
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

extension OpenClawChatMessageContent {
    fileprivate var toolResultContent: [OpenClawChatMessageContent] {
        if let text = self.text { return [.init(type: "text", text: text)] }
        return self.content.flatMap { payload -> [OpenClawChatMessageContent]? in
            if let text = payload.stringValue { return [.init(type: "text", text: text)] }
            return try? GatewayPayloadDecoding.decode(payload, as: [OpenClawChatMessageContent].self)
        } ?? []
    }
}
