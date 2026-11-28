import Foundation
import Observation

/// A device presentation preference, not a mutation of the chat or its PR subscription.
@MainActor @Observable final class ChatPRVisibility {
    static let shared = ChatPRVisibility(defaults: .standard)
    private let defaults: UserDefaults
    private let key = "openclaw.chat.hiddenPullRequests"
    private var chats: [String: [String]]

    init(defaults: UserDefaults) {
        self.defaults = defaults
        self.chats = defaults.dictionary(forKey: self.key) as? [String: [String]] ?? [:]
    }

    static func scope(gateway: String, target: OpenClawChatSessionTarget) -> String {
        // Encode the parts independently, including the explicit agent that owns a bare session key.
        [gateway, target.agentID ?? "", target.sessionKey].map { Data($0.utf8).base64EncodedString() }
            .joined(separator: ":")
    }

    func hidden(in scope: String) -> Set<String> {
        Set(self.chats[scope] ?? [])
    }

    func setHidden(_ hide: Bool, ids: [String], in scope: String) {
        var values = self.hidden(in: scope)
        let changed = ids.map { $0.lowercased() }
        if hide { values.formUnion(changed) } else { values.subtract(changed) }
        self.chats[scope] = values.isEmpty ? nil : values.sorted()
        self.defaults.set(self.chats, forKey: self.key)
    }
}

extension OpenClawChatViewModel {
    var prVisibilityScope: String {
        let gatewayID = self.composerDraftStore?
            .gatewayID ?? (self.transcriptCache as? OpenClawChatSQLiteTranscriptCache)?.gatewayID ?? "local"
        return ChatPRVisibility.scope(gateway: gatewayID, target: self.currentSessionTarget)
    }

    var linkedPullRequests: [ChatActivityPullRequest] {
        guard let feed = self.sessionPullRequests, feed.key == self.sessionKey else { return [] }
        return ChatActivityPullRequest.list(feed.snapshot)
    }
}
