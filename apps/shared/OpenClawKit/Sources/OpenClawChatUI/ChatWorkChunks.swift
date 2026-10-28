import Foundation

enum ChatWorkPartKind {
    case visible
    case work
}

struct ChatWorkChunk<Part> {
    let isWork: Bool
    let parts: [Part]
}

/// Preserve ordered visible parts individually; fold only contiguous work.
/// Callers classify typed content, retaining source action identity and block IDs.
/// No chunk inherits a run's duration.
enum ChatWorkChunks {
    static func project<Part>(
        _ parts: [Part],
        kind: (Part) -> ChatWorkPartKind) -> [ChatWorkChunk<Part>]
    {
        var result: [ChatWorkChunk<Part>] = []
        var work: [Part] = []
        func flush() {
            if !work.isEmpty {
                result.append(ChatWorkChunk(isWork: true, parts: work))
                work = []
            }
        }
        for part in parts {
            if kind(part) == .work {
                work.append(part)
            } else {
                flush()
                result.append(ChatWorkChunk(isWork: false, parts: [part]))
            }
        }
        flush()
        return result
    }
}

extension OpenClawChatMessage {
    /// Presentation identity only. Message ID remains the stored action target.
    var presentationID: UUID {
        guard let index = self.presentationBlockIndex else { return self.id }
        var bytes = self.id.uuid
        // A disjoint deterministic block-index namespace, independent of Swift Hasher.
        bytes.0 ^= 0x40
        let value = UInt64(index + 1)
        withUnsafeMutableBytes(of: &bytes) { buffer in
            for offset in 0..<8 {
                buffer[8 + offset] ^= UInt8(truncatingIfNeeded: value >> (offset * 8))
            }
        }
        return UUID(uuid: bytes)
    }

    /// Split at content boundaries, without mutating history or action identity.
    var workPresentationParts: [Self] {
        guard self.role.lowercased() == "assistant",
              !self.isForwardedTurnBoundary, !self.isRealtimeVoiceTranscript,
              self.content.count > 1,
              self.content.contains(where: \.isWorkContent),
              self.content.contains(where: { $0.isVisibleWorkBoundary(role: self.role) })
        else { return [self] }
        // Inline reasoning can span text blocks. Keep its envelope intact so the
        // bubble parser retains context and the reasoning display control still works.
        let text = self.content.compactMap { content -> String? in
            ChatMessageVisibleText.isVisibleContentType(content.type, role: self.role) ? content.text : nil
        }.joined(separator: "\n")
        guard !AssistantTextParser.segments(from: text).contains(where: { $0.kind == .thinking })
        else { return [self] }
        let parts = Array(self.content.enumerated()).filter { entry in
            entry.element.isWorkContent || entry.element.isVisibleWorkBoundary(role: self.role)
        }
        // Empty text between prose blocks can carry paragraph boundaries. It
        // may be ignored between tools, but cannot change the envelope's text.
        let filteredText = parts.compactMap { entry -> String? in
            ChatMessageVisibleText.isVisibleContentType(entry.element.type, role: self.role)
                ? entry.element.text : nil
        }.joined(separator: "\n")
        guard filteredText.trimmingCharacters(in: .whitespacesAndNewlines) ==
            text.trimmingCharacters(in: .whitespacesAndNewlines)
        else { return [self] }
        let lastVisible = parts.last { $0.element.isVisibleWorkBoundary(role: self.role) }?.offset
        let projected = ChatWorkChunks.project(parts) { entry in
            entry.element.isWorkContent ? .work : .visible
        }
        var chunks: [ChatWorkChunk<(offset: Int, element: OpenClawChatMessageContent)>] = []
        for chunk in projected {
            if !chunk.isWork,
               chunk.parts.allSatisfy({
                   ChatMessageVisibleText.isVisibleContentType($0.element.type, role: self.role)
               }),
               let last = chunks.last, !last.isWork,
               last.parts.allSatisfy({
                   ChatMessageVisibleText.isVisibleContentType($0.element.type, role: self.role)
               })
            {
                chunks[chunks.count - 1] = ChatWorkChunk(isWork: false, parts: last.parts + chunk.parts)
            } else {
                chunks.append(chunk)
            }
        }
        // Keep Markdown parser context across folded work. Plain narration can
        // still bound independent work; syntax-sensitive envelopes stay whole.
        if chunks.filter({ !$0.isWork }).count > 1,
           text.range(
               of: #"[`*_~\[\]<>\\$|#:]|(?:^|\n)(?: {4}|\t|\s*(?:[-+=]|\d+[.)]\s))"#,
               options: .regularExpression) != nil
        { return [self] }
        return chunks.map { chunk in
            var part = self
            part.content = chunk.parts.map(\.element)
            part.presentationBlockIndex = chunk.parts[0].offset
            part.presentationCompletedReply = self.isCompletedReply
            part.presentationRecordedToolResults = self.content.filter(\.isToolResult)
            part.presentationOwnsFooter = chunk.parts.contains { $0.offset == lastVisible }
            // An envelope's execution activity belongs only to its tool part.
            let calls = Set(part.content.compactMap(\.id))
            part.activity = chunk.isWork ? self.activity?.filter { calls.contains($0.toolCallId ?? "") } : nil
            return part
        }
    }
}

extension OpenClawChatMessageContent {
    var isWorkContent: Bool {
        self.isToolCall || self.isToolResult || ["thinking", "redacted_thinking"]
            .contains(self.type?.lowercased() ?? "")
    }

    fileprivate func isVisibleWorkBoundary(role: String) -> Bool {
        if self.isInlineAttachment || self.preview?.inlineWidgetPath != nil { return true }
        guard !self.isWorkContent,
              ChatMessageVisibleText.isVisibleContentType(self.type, role: role) else { return false }
        let message = OpenClawChatMessage(role: role, content: [self], timestamp: nil)
        return ChatMessageVisibleText.hasVisibleText(in: message)
    }
}
