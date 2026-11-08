import Foundation

enum ChatSessionNavigation {
    static func primaryKey(agentID: String, mainKey: String) -> String {
        "agent:\(agentID.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()):\(mainKey)"
    }

    static func comparisonKey(_ key: String, agentID: String?, scope: String?, mainKey: String?) -> String {
        guard let mainKey else { return key }
        let normalized = key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if normalized == "global", scope == "global", let agentID {
            return self.primaryKey(agentID: agentID, mainKey: mainKey)
        }
        let parts = normalized.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false)
        if parts.count == 3, parts[0] == "agent", parts[2] == "main" || parts[2] == mainKey {
            return self.primaryKey(agentID: String(parts[1]), mainKey: mainKey)
        }
        return key
    }
}
