import Foundation

extension OpenClawChatViewModel {
    public var sessionChoices: [OpenClawChatSessionEntry] {
        let now = Date().timeIntervalSince1970 * 1000
        let cutoff = now - (24 * 60 * 60 * 1000)
        let sorted = self.sessions.sorted { ($0.updatedAt ?? 0) > ($1.updatedAt ?? 0) }
        let mainSessionKey = self.resolvedMainSessionKey

        var result: [OpenClawChatSessionEntry] = []
        var included = Set<String>()

        // Always show the resolved main session first, even if it hasn't been updated recently.
        if let main = sorted.first(where: { $0.key == mainSessionKey }) {
            result.append(main)
            included.insert(main.key)
        } else {
            result.append(self.placeholderSession(key: mainSessionKey))
            included.insert(mainSessionKey)
        }

        for entry in sorted {
            guard !included.contains(entry.key) else { continue }
            guard entry.key == self.sessionKey || !Self.isHiddenInternalSession(entry.key) else { continue }
            guard (entry.updatedAt ?? 0) >= cutoff else { continue }
            result.append(entry)
            included.insert(entry.key)
        }

        if !included.contains(self.sessionKey) {
            if let current = sorted.first(where: { $0.key == self.sessionKey }) {
                result.append(current)
            } else {
                result.append(self.placeholderSession(key: self.sessionKey))
            }
        }

        return result
    }

    private static func isHiddenInternalSession(_ key: String) -> Bool {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        return trimmed == "onboarding" || trimmed.hasSuffix(":onboarding")
    }

    func matchesCurrentSessionKey(incoming: String, current: String) -> Bool {
        Self.matchesCurrentSessionKey(
            incoming: incoming,
            current: current,
            mainSessionKey: resolvedMainSessionKey,
            activeAgentId: activeAgentId)
    }

    func matchesCurrentSessionKey(incoming: String, agentId: String?, current: String) -> Bool {
        Self.matchesCurrentSessionKey(
            incoming: incoming,
            agentId: agentId,
            current: current,
            mainSessionKey: resolvedMainSessionKey,
            activeAgentId: activeAgentId)
    }

    static func matchesCurrentSessionKey(
        incoming: String,
        agentId: String? = nil,
        current: String,
        mainSessionKey: String,
        activeAgentId: String? = nil)
        -> Bool
    {
        let incomingNormalized = incoming.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let currentNormalized = current.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if incomingNormalized == currentNormalized {
            if incomingNormalized == "global" {
                return Self.matchesGlobalAgent(agentId: agentId, activeAgentId: activeAgentId)
            }
            return true
        }

        let mainNormalized = mainSessionKey.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if Self.matchesMainAlias(
            incoming: incomingNormalized,
            current: currentNormalized,
            mainSessionKey: mainNormalized)
        {
            if incomingNormalized == "global" || currentNormalized == "global" || mainNormalized == "global" {
                return Self.matchesGlobalAgent(agentId: agentId, activeAgentId: activeAgentId)
            }
            return true
        }
        if Self.matchesSelectedAgentGlobal(
            incoming: incomingNormalized,
            agentId: agentId,
            current: currentNormalized)
        {
            return true
        }
        return false
    }

    private static func normalizedAgentId(_ agentId: String?) -> String? {
        let normalized = agentId?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return normalized?.isEmpty == false ? normalized : nil
    }

    private static func matchesGlobalAgent(agentId: String?, activeAgentId: String?) -> Bool {
        guard let activeAgentId = normalizedAgentId(activeAgentId) else { return false }
        guard let incomingAgentId = normalizedAgentId(agentId) else { return true }
        return incomingAgentId == activeAgentId
    }

    private static func matchesMainAlias(incoming: String, current: String, mainSessionKey: String) -> Bool {
        if current == "main", incoming == mainSessionKey, mainSessionKey != "main" {
            return true
        }
        if incoming == "main", current == mainSessionKey, mainSessionKey != "main" {
            return true
        }
        return (current == "main" && incoming == "agent:main:main") ||
            (incoming == "main" && current == "agent:main:main")
    }

    private static func matchesSelectedAgentGlobal(incoming: String, agentId: String?, current: String) -> Bool {
        guard incoming == "global",
              let selectedAgentId = agentId?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !selectedAgentId.isEmpty
        else {
            return false
        }
        return current == "agent:\(selectedAgentId):global"
    }
}
