import OpenClawProtocol

/// Native subscribers receive snapshots so bounded local queues can skip intermediate updates.
struct GatewayLiveTextProjection {
    private struct Run: Hashable {
        let id: String
        let sessionKey: String?
        let agentID: String?
    }

    private struct Assistant {
        let itemID: String?
        let text: String
    }

    private var chatMessages: [Run: AnyCodable] = [:]
    private var assistants: [Run: Assistant] = [:]

    mutating func reset() {
        self.chatMessages.removeAll()
        self.assistants.removeAll()
    }

    /// nil requests a new socket baseline; a suffix must never masquerade as a complete answer.
    mutating func project(_ event: EventFrame) -> EventFrame? {
        guard var payload = event.payload?.dictionaryValue,
              let runID = payload["runId"]?.stringValue
        else { return event }
        let run = Run(
            id: runID,
            sessionKey: payload["sessionKey"]?.stringValue,
            agentID: payload["agentId"]?.stringValue)

        if event.event == "chat" {
            switch payload["state"]?.stringValue {
            case "final", "aborted", "error":
                self.chatMessages = self.chatMessages.filter { $0.key.id != runID }
                self.assistants = self.assistants.filter { $0.key.id != runID }
                return event
            case "delta":
                if let message = payload["message"],
                   message.dictionaryValue != nil || message.stringValue != nil
                {
                    self.chatMessages[run] = message
                    return event
                }
                guard let delta = payload["deltaText"]?.stringValue else { return event }
                let replace = payload["replace"]?.boolValue == true
                let previous = self.chatMessages[run]
                guard previous != nil || replace else { return nil }
                let message = Self.updateMessage(previous, text: delta, replace: replace)
                self.chatMessages[run] = message
                payload["message"] = message
            default:
                return event
            }
        } else if event.event == "agent", var data = payload["data"]?.dictionaryValue {
            let stream = payload["stream"]?.stringValue
            if stream == "lifecycle", let phase = data["phase"]?.stringValue,
               phase == "end" || phase == "error"
            {
                self.assistants = self.assistants.filter { $0.key.id != runID }
                return event
            }
            guard stream == "assistant" else { return event }
            let itemID = data["itemId"]?.stringValue
            if let text = data["text"]?.stringValue {
                self.assistants[run] = Assistant(itemID: itemID, text: text)
                return event
            }
            let replace = data["replace"]?.boolValue == true
            guard let delta = data["delta"]?.stringValue else { return event }
            let previous = self.assistants[run]
            guard replace || (previous != nil && previous?.itemID == itemID) else { return nil }
            let text = replace ? delta : (previous?.text ?? "") + delta
            self.assistants[run] = Assistant(itemID: itemID, text: text)
            data["text"] = AnyCodable(text)
            payload["data"] = AnyCodable(data)
        } else {
            return event
        }
        return EventFrame(
            type: event.type,
            event: event.event,
            payload: AnyCodable(payload),
            seq: event.seq,
            stateversion: event.stateversion,
            recipientprofileid: event.recipientprofileid)
    }

    private static func updateMessage(_ previous: AnyCodable?, text: String, replace: Bool) -> AnyCodable {
        if let string = previous?.stringValue {
            return AnyCodable(replace ? text : string + text)
        }
        var message = previous?.dictionaryValue ?? ["role": AnyCodable("assistant")]
        if let content = message["content"]?.stringValue {
            message["content"] = AnyCodable(replace ? text : content + text)
            return AnyCodable(message)
        }
        var content = message["content"]?.arrayValue ?? []
        let textIndices = content.indices.filter { index in
            if content[index].stringValue != nil { return true }
            guard let part = content[index].dictionaryValue else { return false }
            return part["text"]?.stringValue != nil &&
                [nil, "text", "input_text", "output_text"].contains(part["type"]?.stringValue)
        }
        if let index = replace ? textIndices.first : textIndices.last {
            if let string = content[index].stringValue {
                content[index] = AnyCodable(replace ? text : string + text)
            } else {
                var part = content[index].dictionaryValue ?? [:]
                part["text"] = AnyCodable(replace ? text : (part["text"]?.stringValue ?? "") + text)
                content[index] = AnyCodable(part)
            }
            if replace {
                for extraIndex in textIndices.dropFirst().reversed() {
                    content.remove(at: extraIndex)
                }
            }
        } else {
            content.insert(AnyCodable(["type": "text", "text": text]), at: 0)
        }
        message["content"] = AnyCodable(content)
        return AnyCodable(message)
    }
}
