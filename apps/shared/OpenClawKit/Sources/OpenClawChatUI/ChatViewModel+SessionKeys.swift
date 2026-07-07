import Foundation

extension OpenClawChatViewModel {
    nonisolated static func chatContextUsageFraction(for session: OpenClawChatSessionEntry?) -> Double? {
        guard session?.totalTokensFresh != false,
              let totalTokens = session?.totalTokens,
              totalTokens >= 0,
              let contextTokens = session?.contextTokens,
              contextTokens > 0
        else {
            return nil
        }
        return min(max(Double(totalTokens) / Double(contextTokens), 0), 1)
    }

    func syncContextUsageFraction() {
        let mainSessionKey = self.resolvedMainSessionKey
        let activeSessionKey = self.sessionKey == "main" && mainSessionKey != "main"
            ? mainSessionKey
            : self.sessionKey
        let currentSession = self.sessions.first(where: { $0.key == activeSessionKey }) ??
            self.sessions.first(where: {
                self.matchesCurrentSessionKey(incoming: $0.key, current: self.sessionKey)
            })
        self.contextUsageFraction = Self.chatContextUsageFraction(for: currentSession)
    }

    public var sessionChoices: [OpenClawChatSessionEntry] {
        let now = Date().timeIntervalSince1970 * 1000
        let cutoff = now - (24 * 60 * 60 * 1000)
        let sorted = OpenClawChatSessionListOrganizer.organize(sessions)
        let mainSessionKey = resolvedMainSessionKey

        var result: [OpenClawChatSessionEntry] = []
        var included = Set<String>()

        // Always show the resolved main session first, even if it hasn't been updated recently.
        if let main = sorted.first(where: { $0.key == mainSessionKey }) {
            result.append(main)
            included.insert(main.key)
        } else {
            result.append(placeholderSession(key: mainSessionKey))
            included.insert(mainSessionKey)
        }

        for entry in sorted {
            guard !included.contains(entry.key) else { continue }
            guard entry.key == sessionKey || !ChatSessionSidebarModel.isHiddenInternalSession(entry.key)
            else { continue }
            // Pinned sessions stay reachable regardless of recency.
            guard (entry.updatedAt ?? 0) >= cutoff || entry.isPinned else { continue }
            result.append(entry)
            included.insert(entry.key)
        }

        if !included.contains(sessionKey) {
            if let current = sorted.first(where: { $0.key == self.sessionKey }) {
                result.append(current)
            } else {
                result.append(placeholderSession(key: sessionKey))
            }
        }

        return result
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
            if Self.agentIDFromSessionKey(currentNormalized) == nil {
                // `global` is always agent-ambiguous. Ordinary exact keys can
                // arrive before bootstrap publishes the active agent; accept
                // them until there is ownership metadata to compare.
                if currentNormalized != "global",
                   self.normalizedAgentId(activeAgentId) == nil
                {
                    return true
                }
                return Self.matchesAliasAgent(
                    incomingKey: incomingNormalized,
                    agentId: agentId,
                    currentKey: currentNormalized,
                    activeAgentId: activeAgentId)
            }
            return true
        }

        let mainNormalized = mainSessionKey.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if Self.matchesMainAlias(
            incoming: incomingNormalized,
            current: currentNormalized,
            mainSessionKey: mainNormalized)
        {
            return Self.matchesAliasAgent(
                incomingKey: incomingNormalized,
                agentId: agentId,
                currentKey: currentNormalized,
                activeAgentId: activeAgentId,
                allowIncomingOwnerWhenCurrentUnknown: true)
        }
        if Self.matchesSelectedAgentWrapper(incoming: incomingNormalized, current: currentNormalized) {
            return Self.matchesAliasAgent(
                incomingKey: incomingNormalized,
                agentId: agentId,
                currentKey: currentNormalized,
                activeAgentId: activeAgentId)
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

    private static func matchesAliasAgent(
        incomingKey: String,
        agentId: String?,
        currentKey: String,
        activeAgentId: String?,
        allowIncomingOwnerWhenCurrentUnknown: Bool = false) -> Bool
    {
        let currentAgentID = self.agentIDFromSessionKey(currentKey) ?? self.normalizedAgentId(activeAgentId)
        let payloadAgentID = self.normalizedAgentId(agentId)
        let keyAgentID = self.agentIDFromSessionKey(incomingKey)
        if let payloadAgentID, let keyAgentID, payloadAgentID != keyAgentID {
            return false
        }
        let incomingAgentID = payloadAgentID ?? keyAgentID
        guard let currentAgentID else {
            return allowIncomingOwnerWhenCurrentUnknown && incomingAgentID != nil
        }
        guard let incomingAgentID else { return true }
        return incomingAgentID == currentAgentID
    }

    private static func agentIDFromSessionKey(_ sessionKey: String) -> String? {
        let parts = sessionKey.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false)
        guard parts.count >= 3, parts[0] == "agent" else { return nil }
        let agentID = String(parts[1]).trimmingCharacters(in: .whitespacesAndNewlines)
        return agentID.isEmpty ? nil : agentID
    }

    private static func matchesSelectedAgentWrapper(incoming: String, current: String) -> Bool {
        let incomingParts = incoming.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false)
        if incomingParts.count == 3,
           incomingParts[0] == "agent",
           String(incomingParts[2]) == current
        {
            return true
        }
        let currentParts = current.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false)
        return currentParts.count == 3 &&
            currentParts[0] == "agent" &&
            String(currentParts[2]) == incoming
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
