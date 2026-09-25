import Foundation

/// Live commentary is a display projection, never a second durable transcript.
/// Canonical history takes over each exact run/item without losing its row identity.
struct ChatNarration {
    private struct Segment {
        let runID: String
        let itemID: String?
        let eventID: String
        let sequence: Int?
        let message: OpenClawChatMessage
    }

    private var segments: [Segment] = []

    mutating func receive(_ event: OpenClawAgentEventPayload, history: [OpenClawChatMessage]) {
        let rawText = (event.data["progressText"]?.value as? String ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        // NO_REPLY is the wire's silent-output sentinel, including Markdown
        // wrappers. It must retract progress, never become visible narration.
        let silent = rawText.trimmingCharacters(in: .whitespacesAndNewlines.union(
            CharacterSet(charactersIn: "*_`~"))).caseInsensitiveCompare("NO_REPLY") == .orderedSame
        let text = silent ? "" : rawText
        let phase = event.data["phase"]?.value as? String
        // Match the Gateway's completed-preamble contract: growing previews are
        // not transcript rows, but an empty update can retract a sealed item.
        guard text.isEmpty || (phase != "start" && phase != "update") else { return }
        let rawItemID = event.data["itemId"]?.value as? String ?? event.data["id"]?.value as? String
        let itemID = rawItemID?.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = itemID?.isEmpty == false ? itemID : nil
        if let key, history.contains(where: {
            $0.streamSegmentID == key && ($0.transcriptRunID ?? $0.streamFallback?.runId) == event.runId
        }) { return }
        let index = self.segments.firstIndex {
            $0.runID == event.runId && (key != nil
                ? $0.itemID == key : $0.eventID == event.id)
        }
        let previous = index.map { self.segments[$0] }
        if let sequence = event.seq, let previousSequence = previous?.sequence,
           sequence <= previousSequence { return }
        let message = OpenClawChatMessage(
            id: previous?.message.id ?? UUID(),
            role: "assistant",
            content: [.init(type: "text", text: text, mimeType: nil, fileName: nil, content: nil)],
            timestamp: previous?.message.timestamp ?? event.ts.map(Double.init),
            transcriptRunID: event.runId,
            phase: "commentary",
            streamFallback: key.map { .init(source: "segment", itemId: $0, runId: event.runId) })
        let segment = Segment(
            runID: event.runId, itemID: key, eventID: event.id, sequence: event.seq, message: message)
        if let index {
            self.segments[index] = segment
        } else if key != nil || !text.isEmpty {
            // Retractions also own a sequence before the first local render;
            // an older reconnect snapshot must not resurrect the removed item.
            self.segments.append(segment)
        }
    }

    func projecting(_ messages: [OpenClawChatMessage]) -> [OpenClawChatMessage] {
        var result = messages
        for segment in self.segments {
            if let itemID = segment.itemID,
               result.contains(where: {
                   $0.streamSegmentID == itemID &&
                       ($0.transcriptRunID ?? $0.streamFallback?.runId) == segment.runID
               })
            {
                continue
            }
            guard ChatMessageVisibleText.hasVisibleText(in: segment.message) else { continue }
            let owner = result.firstIndex {
                $0.role.lowercased() == "user" &&
                    ($0.transcriptRunID == segment.runID || $0.idempotencyKey == "\(segment.runID):user")
            }
            let start = owner.map { result.index(after: $0) } ?? result.startIndex
            let index = segment.message.timestamp.flatMap { timestamp in
                result[start...].firstIndex { ($0.timestamp.map { $0 > timestamp }) == true }
            } ?? result.endIndex
            result.insert(segment.message, at: index)
        }
        return result
    }

    mutating func reconcile(_ messages: [OpenClawChatMessage]) -> [OpenClawChatMessage] {
        var messages = messages
        self.segments.removeAll { segment in
            guard let itemID = segment.itemID,
                  let index = messages.firstIndex(where: {
                      $0.streamSegmentID == itemID &&
                          ($0.transcriptRunID ?? $0.streamFallback?.runId) == segment.runID
                  })
            else { return false }
            // Retire the transient copy while preserving the canonical Markdown
            // and the live row's SwiftUI identity across the handoff.
            messages[index].id = segment.message.id
            return true
        }
        return messages
    }
}

extension OpenClawChatViewModel {
    var transcriptMessages: [OpenClawChatMessage] {
        self.narration.projecting(self.messages)
    }

    func handleAgentNarration(_ event: OpenClawAgentEventPayload) {
        guard event.stream == "item", event.data["kind"]?.value as? String == "preamble",
              self.ownsLiveTelemetryRun(event.runId)
        else { return }
        self.narration.receive(event, history: self.messages)
        self.markTimelineChanged()
    }
}
