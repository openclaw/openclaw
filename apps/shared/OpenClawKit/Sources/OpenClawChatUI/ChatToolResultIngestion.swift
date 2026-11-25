import Foundation
import OpenClawKit

extension OpenClawChatMessage {
    /// Normalize embedded assistant results and expand user result carriers from CLI history.
    /// Expand those rows before they reach turn ownership or presentation. A confirmed
    /// `sessions_yield` receipt's public acknowledgment follows it as visible assistant text
    /// (web chat-sessions-yield.ts:200-230); the yield card itself never shows.
    var ingestedMessages: [OpenClawChatMessage] {
        self.expandedMessages.flatMap { message in
            message.yieldAcknowledgment.map { [message, $0] } ?? [message]
        }
    }

    private var yieldAcknowledgment: OpenClawChatMessage? {
        let receipts: [OpenClawChatMessageContent]
        if self.isToolResult {
            guard self.toolName?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "sessions_yield"
            else { return nil }
            receipts = [.init(
                type: "tool_result",
                text: ChatMessageVisibleText.displayText(in: self, includeThinking: false),
                details: self.details,
                isError: self.isError)]
        } else if self.role.lowercased() == "assistant" || self.isNestedToolActivity {
            let yieldCalls = Set(self.content.filter { $0.isToolCall && $0.name == "sessions_yield" }.compactMap(\.id))
            receipts = self.content.filter { block in
                block.isToolResult && (block.name == "sessions_yield" || block.id.map(yieldCalls.contains) == true)
            }
        } else {
            return nil
        }
        for receipt in receipts.reversed() where !ChatToolActivity.resultIsError(receipt.isError, text: receipt.text) {
            guard let facts = ChatToolActivity.handoffReceipt(details: receipt.details, text: receipt.text),
                  facts["status"]?.stringValue == "yielded",
                  let acknowledgment = ChatPayloadDecoding.trimmedNonEmptyString(facts["acknowledgment"]?.stringValue)
            else { continue }
            // Derived from the receipt row, so the pair keeps distinct, related identities and
            // history dedupe (by transcript ID) drops both together.
            var bytes = self.id.uuid
            bytes.1 ^= 0x80
            let receiptID = receipt.id ?? self.toolCallId ?? ""
            return OpenClawChatMessage(
                id: UUID(uuid: bytes),
                role: "assistant",
                content: [.init(type: "text", text: acknowledgment)],
                timestamp: self.timestamp,
                transcriptMessageID: self.transcriptMessageID.map { "\($0):yield-acknowledgment:\(receiptID)" },
                transcriptRunID: self.workRunID,
                // The run stopped at its yield call: this line closes the handoff, never the run's
                // recorded final reply, so a resumed final still settles in place.
                stopReason: "toolUse")
        }
        return nil
    }

    private var expandedMessages: [OpenClawChatMessage] {
        if self.role.lowercased() == "assistant" || self.isNestedToolActivity,
           self.content.contains(where: \.isToolResult)
        {
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
