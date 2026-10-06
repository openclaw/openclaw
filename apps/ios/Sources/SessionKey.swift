import Foundation

enum SessionKey {
    static func normalizeMainKey(_ raw: String?) -> String {
        let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "main" : trimmed
    }

    static func makeAgentSessionKey(agentId: String, baseKey: String) -> String {
        let trimmedAgent = agentId.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedBase = self.normalizeMainKey(baseKey)
        if trimmedAgent.isEmpty { return normalizedBase }
        return "agent:\(trimmedAgent):\(normalizedBase)"
    }
}
