import Foundation

public struct TalkResponseEnvelopeParseResult: Equatable, Sendable {
    public let response: String?
    public let isEnvelope: Bool

    public init(response: String?, isEnvelope: Bool) {
        self.response = response
        self.isEnvelope = isEnvelope
    }
}

public enum TalkResponseEnvelopeParser {
    public static func parse(_ text: String) -> TalkResponseEnvelopeParseResult {
        for candidate in self.jsonObjectCandidates(from: text) {
            guard let object = self.parseObject(candidate), object.keys.contains("response") else {
                continue
            }
            let response = (object["response"] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return TalkResponseEnvelopeParseResult(
                response: response?.isEmpty == false ? response : nil,
                isEnvelope: true)
        }
        return TalkResponseEnvelopeParseResult(response: nil, isEnvelope: false)
    }

    public static func isEnvelopeKey(_ key: String) -> Bool {
        let normalized = key.replacingOccurrences(of: "_", with: "").lowercased()
        return [
            "response",
            "spoken",
            "display",
            "summary",
            "status",
            "actions",
            "handoff",
            "notification",
            "notifications",
            "metadata",
        ].contains(normalized)
    }

    private static func jsonObjectCandidates(from text: String) -> [String] {
        let normalized = text.replacingOccurrences(of: "\r\n", with: "\n")
        let trimmed = normalized.trimmingCharacters(in: .whitespacesAndNewlines)
        var candidates: [String] = []
        if let unfenced = self.unfencedJson(trimmed) {
            candidates.append(unfenced)
        }
        if trimmed.hasPrefix("{"), trimmed.hasSuffix("}") {
            candidates.append(trimmed)
        }
        if let firstLine = normalized
            .split(separator: "\n", omittingEmptySubsequences: false)
            .first(where: { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            firstLine.hasPrefix("{"),
            firstLine.hasSuffix("}")
        {
            candidates.append(firstLine)
        }
        return Array(NSOrderedSet(array: candidates)) as? [String] ?? candidates
    }

    private static func unfencedJson(_ text: String) -> String? {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        guard lines.count >= 3 else { return nil }
        let first = lines.first?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let last = lines.last?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard first == "```json" || first == "```",
              last == "```"
        else {
            return nil
        }
        return lines.dropFirst().dropLast().joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func parseObject(_ candidate: String) -> [String: Any]? {
        guard let data = candidate.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return nil
        }
        return object
    }
}
