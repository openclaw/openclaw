import Foundation
import Observation
import OpenClawProtocol

@MainActor
@Observable
final class AgentEventStore {
    struct AssistantOutputEvidence: Equatable {
        let sessionKey: String
        let eventDate: Date
        let text: String
        let hasMedia: Bool
    }

    static let shared = AgentEventStore()

    private(set) var events: [ControlAgentEvent] = []
    private let maxEvents = 400

    func append(_ event: ControlAgentEvent) {
        self.events.append(event)
        if self.events.count > self.maxEvents {
            self.events.removeFirst(self.events.count - self.maxEvents)
        }
    }

    func clear() {
        self.events.removeAll()
    }

    func latestAssistantOutput(sessionKey: String, since: Date? = nil) -> AssistantOutputEvidence? {
        let normalizedSessionKey = Self.normalizeSessionKey(sessionKey)
        guard !normalizedSessionKey.isEmpty else { return nil }

        for event in self.events.reversed() {
            guard let evidence = Self.assistantEvidence(from: event),
                  Self.normalizeSessionKey(evidence.sessionKey) == normalizedSessionKey
            else {
                continue
            }
            if let since, evidence.eventDate < since {
                continue
            }
            return evidence
        }
        return nil
    }

    private static func assistantEvidence(from event: ControlAgentEvent) -> AssistantOutputEvidence? {
        guard event.stream.caseInsensitiveCompare("assistant") == .orderedSame else {
            return nil
        }

        let text = (event.data["text"]?.value as? String) ?? ""
        let hasMedia = Self.containsMedia(event.data["mediaUrls"])
        let cleanedText = Self.condenseWhitespace(text)
        guard !cleanedText.isEmpty || hasMedia else {
            return nil
        }

        return AssistantOutputEvidence(
            sessionKey: event.resolvedSessionKey,
            eventDate: Date(timeIntervalSince1970: event.ts / 1000),
            text: cleanedText,
            hasMedia: hasMedia)
    }

    private static func containsMedia(_ value: OpenClawProtocol.AnyCodable?) -> Bool {
        guard let raw = value?.value else { return false }
        switch raw {
        case let urls as [OpenClawProtocol.AnyCodable]:
            return !urls.isEmpty
        case let urls as [Any]:
            return !urls.isEmpty
        case let url as String:
            return !url.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        default:
            return false
        }
    }

    private static func normalizeSessionKey(_ raw: String) -> String {
        raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private static func condenseWhitespace(_ text: String) -> String {
        text
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
