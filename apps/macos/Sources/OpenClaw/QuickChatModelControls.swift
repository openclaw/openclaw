import Foundation
import OpenClawChatUI
import OpenClawProtocol

struct QuickChatModelControlSnapshot: Sendable {
    let models: [OpenClawChatModelChoice]
    let currentModelSelectionID: String?
    let currentThinkingLevel: String?
    let thinkingOptions: [OpenClawChatThinkingLevelOption]
    let defaultProvider: String?
    var catalogMessage: String?
    var catalogRefreshFailed = false
}

enum QuickChatModelPatchDecision: Equatable {
    case none
    case patch(String?)
}

enum QuickChatModelControlLogic {
    static func snapshot(
        target: QuickChatRoutingTarget,
        models: [OpenClawChatModelChoice],
        sessions: OpenClawChatSessionsListResponse,
        agents: AgentsListResult?) -> QuickChatModelControlSnapshot
    {
        let entry = self.sessionEntry(target: target, sessions: sessions.sessions)
        let agent = self.agent(target: target, agents: agents)
        let entryProvider = self.normalized(entry?.modelProvider)
        let entryModel = self.normalized(entry?.model)
        let agentModel = self.normalized(agent?.model?["primary"]?.value as? String)
        let defaultProvider = self.normalized(sessions.defaults?.modelProvider)
        let defaultModel = self.normalized(sessions.defaults?.model)
        let selectionID = entryModel.map {
            self.selectionID(model: $0, provider: entryProvider ?? defaultProvider)
        } ?? agentModel ?? defaultModel.map {
            self.selectionID(model: $0, provider: defaultProvider)
        }
        let profile = OpenClawChatThinkingProfile.resolve(
            session: entry,
            defaults: selectionID == defaultModel.map { self.selectionID(model: $0, provider: defaultProvider) }
                ? sessions.defaults : nil,
            model: models.first { $0.selectionID == selectionID })
        let thinkingLevel = self.normalized(entry?.thinkingLevel) ?? profile?.defaultLevel
        return QuickChatModelControlSnapshot(
            models: models,
            currentModelSelectionID: selectionID,
            currentThinkingLevel: thinkingLevel,
            thinkingOptions: profile?.levels ?? [],
            defaultProvider: self.provider(selectionID: selectionID))
    }

    static func modelPatchDecision(
        selectionID: String?,
        appliedSelectionID: String?,
        currentSessionSelectionID: String? = nil) -> QuickChatModelPatchDecision
    {
        guard let selectionID else { return .none }
        if selectionID == OpenClawChatViewModel.defaultModelSelectionID {
            guard selectionID != appliedSelectionID else { return .none }
            return .patch(nil)
        }
        if selectionID == currentSessionSelectionID { return .none }
        if currentSessionSelectionID != nil { return .patch(selectionID) }
        guard selectionID != appliedSelectionID else { return .none }
        return .patch(selectionID)
    }

    static func displayName(
        selectionID: String?,
        models: [OpenClawChatModelChoice],
        automaticLabel: String) -> String
    {
        guard let selectionID,
              selectionID != OpenClawChatViewModel.defaultModelSelectionID
        else { return automaticLabel }
        if let choice = models.first(where: { $0.selectionID == selectionID }) {
            return choice.name
        }
        return selectionID.split(separator: "/", maxSplits: 1).last.map(String.init) ?? selectionID
    }

    static func validatedThinkingSelection(
        _ selection: String?,
        options: [OpenClawChatThinkingLevelOption]) -> String?
    {
        guard let selection else { return nil }
        let normalized = selection.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return options.contains(where: {
            $0.id.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == normalized
        }) ? normalized : nil
    }

    private static func sessionEntry(
        target: QuickChatRoutingTarget,
        sessions: [OpenClawChatSessionEntry]) -> OpenClawChatSessionEntry?
    {
        let key = target.sessionKey.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if let exact = sessions.first(where: { $0.key.lowercased() == key }) {
            return exact
        }
        guard key == "global",
              let agentID = self.normalized(target.agentID)?.lowercased()
        else { return nil }
        return sessions.first(where: { $0.key.lowercased() == "agent:\(agentID):global" })
    }

    private static func agent(target: QuickChatRoutingTarget, agents: AgentsListResult?) -> AgentSummary? {
        guard let agents else { return nil }
        let targetAgentID = self.normalized(target.agentID) ??
            OpenClawChatSessionKey.agentID(from: target.sessionKey) ??
            self.normalized(agents.defaultid)
        guard let targetAgentID else { return nil }
        return agents.agents.first(where: { $0.id.caseInsensitiveCompare(targetAgentID) == .orderedSame })
    }

    static func selectionID(model: String, provider: String?) -> String {
        guard let provider else { return model }
        let prefix = "\(provider)/"
        return model.hasPrefix(prefix) ? model : "\(prefix)\(model)"
    }

    private static func provider(selectionID: String?) -> String? {
        guard let selectionID,
              let separator = selectionID.firstIndex(of: "/"),
              separator != selectionID.startIndex
        else { return nil }
        return String(selectionID[..<separator])
    }

    private static func normalized(_ value: String?) -> String? {
        let value = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        return value?.isEmpty == false ? value : nil
    }
}
