import Foundation

/// The last model list the phone loaded, per server and agent, kept on the device so the model sheet opens
/// with content at once, offline too. Only what the sheet shows is kept: names, providers and capabilities,
/// never credentials. A small per-server value in UserDefaults, like the sidebar's per-server choices.
enum ChatModelCatalogCache {
    static func key(scope: String, agentID: String?) -> String {
        "openclaw.chat.modelCatalog.\(scope).\(agentID ?? "default")"
    }

    static func load(_ key: String, defaults: UserDefaults = .standard) -> [OpenClawChatModelChoice]? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode([OpenClawChatModelChoice].self, from: data)
    }

    static func store(_ choices: [OpenClawChatModelChoice], key: String, defaults: UserDefaults = .standard) {
        guard let data = try? JSONEncoder().encode(choices) else { return }
        defaults.set(data, forKey: key)
    }
}

extension OpenClawChatViewModel {
    /// The cache slot for the current server and agent; nil when the app has no server identity.
    var modelCatalogCacheKey: String? {
        guard let scope = self.modelCatalogCacheScopeOverride
            ?? (self.transcriptCache as? OpenClawChatSQLiteTranscriptCache)?.gatewayID
        else { return nil }
        return ChatModelCatalogCache.key(scope: scope, agentID: self.currentSessionSnapshot().deliveryAgentID)
    }
}
