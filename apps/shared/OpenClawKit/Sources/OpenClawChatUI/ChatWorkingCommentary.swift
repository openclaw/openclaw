import Foundation
import OpenClawKit

/// A presentation of the active run, never a replacement for canonical messages.
struct ChatWorkingCommentary: Equatable, Sendable {
    let runID: String
    let itemID: String?
    let messageID: UUID?
    let text: String
    let timestamp: Double

    func matchesStreamingText(_ text: String) -> Bool {
        Self.statusText(text) == self.text
    }

    private struct TextSignature: Decodable {
        let v: Int
        let phase: String?
    }

    static func completedItem(_ event: OpenClawAgentEventPayload) -> Self? {
        guard event.stream == "item", event.data["kind"]?.value as? String == "preamble",
              let itemID = (event.data["itemId"]?.value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !itemID.isEmpty,
              let text = event.data["progressText"]?.value as? String,
              let text = self.statusText(text),
              !["start", "update"].contains(event.data["phase"]?.value as? String ?? "")
        else { return nil }
        return Self(
            runID: event.runId,
            itemID: itemID,
            messageID: nil,
            text: text,
            timestamp: Double(event.ts ?? 0))
    }

    static func latest(runID: String, messages: [OpenClawChatMessage], live: Self?) -> Self? {
        var latest = live?.runID == runID ? live : nil
        for message in messages where message.role.lowercased() == "assistant" {
            guard (message.transcriptRunID ?? message.streamFallback?.runId) == runID,
                  let text = self.statusText(self.commentaryBlocks(
                      in: message,
                      matchingItemID: live?.runID == runID ? live?.itemID : nil,
                      matchingText: live?.runID == runID ? live?.text : nil)
                      .compactMap(\.text).joined(separator: "\n"))
            else { continue }
            let timestamp = message.timestamp ?? 0
            if latest == nil || timestamp >= latest!.timestamp {
                // A segment ID from history is not proof of a completed item.
                // Retain the suppression key only if the live preamble owned it.
                let completedItemID = live?.runID == runID && live?.itemID == message.streamSegmentID
                    ? live?.itemID : nil
                latest = Self(
                    runID: runID,
                    itemID: completedItemID,
                    messageID: message.id,
                    text: text,
                    timestamp: timestamp)
            }
        }
        return latest
    }

    /// Drop only the currently promoted commentary; older history and mixed final blocks survive.
    func transcriptMessage(_ message: OpenClawChatMessage) -> OpenClawChatMessage? {
        guard (message.transcriptRunID ?? message.streamFallback?.runId) == self.runID,
              message.id == self.messageID || (self.itemID != nil && message.streamSegmentID == self.itemID)
        else { return message }
        let commentary = Self.commentaryBlocks(
            in: message,
            matchingItemID: self.itemID,
            matchingText: self.text)
        guard !commentary.isEmpty else { return message }
        let remaining = message.content.filter { !commentary.contains($0) }
        guard !remaining.isEmpty else { return nil }
        return OpenClawChatMessage(
            id: message.id,
            role: message.role,
            content: remaining,
            timestamp: message.timestamp,
            transcriptMessageID: message.transcriptMessageID,
            transcriptRunID: message.transcriptRunID,
            isTruncated: message.isTruncated,
            idempotencyKey: message.idempotencyKey,
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            usage: message.usage,
            stopReason: message.stopReason,
            errorMessage: message.errorMessage,
            details: message.details,
            isError: message.isError,
            provenance: message.provenance,
            historyMarker: message.historyMarker,
            turnBoundary: message.turnBoundary,
            steerTargetRunID: message.steerTargetRunID,
            streamFallback: message.streamFallback,
            activity: message.activity)
    }

    private static func commentaryBlocks(
        in message: OpenClawChatMessage,
        matchingItemID: String?,
        matchingText: String?)
        -> [OpenClawChatMessageContent]
    {
        // Segment markers alone do not prove commentary: an unphased final can
        // also be a segment. Only the completed, matching item can promote it.
        let isOwnedSegment = message.streamFallback?.source == "segment" &&
            matchingItemID != nil && message.streamSegmentID == matchingItemID
        let signedPhases = message.content.map { block -> String? in
            guard let signature = block.textSignature,
                  let data = signature.data(using: .utf8),
                  let value = try? JSONDecoder().decode(TextSignature.self, from: data),
                  value.v == 1 else { return nil }
            return value.phase
        }
        let hasExplicitPhase = signedPhases.contains { $0 != nil }
        return message.content.enumerated().compactMap { index, block in
            guard ChatMessageVisibleText.isVisibleContentType(block.type, role: "assistant"),
                  block.text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            else { return nil }
            let phase = signedPhases[index]
            // In a mixed envelope, an untagged block is not proven commentary.
            let inheritedPhase = hasExplicitPhase ? nil : message.phase
            let isCommentary = (phase ?? inheritedPhase) == "commentary" ||
                (phase == nil && !hasExplicitPhase && isOwnedSegment && message.phase != "final_answer" &&
                    matchingText != nil && self.statusText(block.text ?? "") == matchingText)
            return isCommentary ? block : nil
        }
    }

    private static func statusText(_ text: String) -> String? {
        // The status is brief, single-line text, not another Markdown bubble.
        let plain = (try? AttributedString(markdown: text)).map { String($0.characters) } ?? text
        let normalized = plain.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard !normalized.isEmpty else { return nil }
        return String(normalized.prefix(800))
    }
}
