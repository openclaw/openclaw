import Foundation

// Thinking-level normalization and option resolution. Session entries,
// session defaults, and free-form user aliases all feed the picker; this
// extension owns collapsing them into the canonical option list.

extension OpenClawChatViewModel {
    /// `agent-command.ts` throws for explicit unsupported levels, so hidden controls must send `off`.
    var effectiveThinkingLevelForSend: String {
        self.effectiveThinkingLevelForSend(self.thinkingLevel)
    }

    func effectiveThinkingLevelForSend(_ storedLevel: String, sessionKey: String? = nil) -> String {
        let showsPicker: Bool
        if let sessionKey, sessionKey != self.sessionKey {
            // Sessions absent from the loaded list resolve to no metadata and fail
            // open, preserving the queued level — matches shipped flush behavior;
            // downgrading unknown sessions to "off" would silently strip levels
            // users explicitly queued for reasoning-capable models.
            let session = self.sessions.first(where: { $0.key == sessionKey })
            showsPicker = self.thinkingPickerIsAvailable(
                for: session,
                modelChoice: self.sessionModelChoice(for: session))
        } else {
            showsPicker = self.showsThinkingPicker
        }
        return showsPicker ? storedLevel : "off"
    }

    func syncThinkingLevelOptions() {
        let currentSession = self.sessions.first(where: { $0.key == self.sessionKey })
        self.showsThinkingPicker = self.thinkingPickerIsAvailable(
            for: currentSession,
            modelChoice: self.selectedModelChoice(for: currentSession))

        var options = self.resolvedThinkingLevelOptions(for: currentSession).options
        if let current = Self.normalizedThinkingLevel(thinkingLevel) {
            options = Self.withCurrentThinkingOption(options, current: current)
        }
        self.thinkingLevelOptions = options
    }

    private func thinkingPickerIsAvailable(
        for session: OpenClawChatSessionEntry?,
        modelChoice: OpenClawChatModelChoice?) -> Bool
    {
        let resolved = self.resolvedThinkingLevelOptions(for: session)
        let gatewayAllowsOnlyOff = resolved.isGatewayMetadata &&
            resolved.options.allSatisfy { $0.id == "off" }
        return !gatewayAllowsOnlyOff && modelChoice?.reasoning != false
    }

    private struct ThinkingLevelOptionsResolution {
        let options: [OpenClawChatThinkingLevelOption]
        let isGatewayMetadata: Bool
    }

    private func resolvedThinkingLevelOptions(
        for currentSession: OpenClawChatSessionEntry?) -> ThinkingLevelOptionsResolution
    {
        if let levels = Self.normalizedThinkingLevelOptions(currentSession?.thinkingLevels), !levels.isEmpty {
            return ThinkingLevelOptionsResolution(options: levels, isGatewayMetadata: true)
        }

        let defaultsMatch = currentSession.map {
            Self.sessionModelMatchesDefaults($0, defaults: self.sessionDefaults)
        } ?? true

        if defaultsMatch,
           let levels = Self.normalizedThinkingLevelOptions(sessionDefaults?.thinkingLevels),
           !levels.isEmpty
        {
            return ThinkingLevelOptionsResolution(options: levels, isGatewayMetadata: true)
        }

        if let options = Self.thinkingOptions(from: currentSession?.thinkingOptions), !options.isEmpty {
            return ThinkingLevelOptionsResolution(options: options, isGatewayMetadata: true)
        }

        if defaultsMatch,
           let options = Self.thinkingOptions(from: sessionDefaults?.thinkingOptions),
           !options.isEmpty
        {
            return ThinkingLevelOptionsResolution(options: options, isGatewayMetadata: true)
        }

        return ThinkingLevelOptionsResolution(options: Self.baseThinkingLevelOptions, isGatewayMetadata: false)
    }

    private func selectedModelChoice(
        for currentSession: OpenClawChatSessionEntry?) -> OpenClawChatModelChoice?
    {
        if self.modelSelectionID != Self.defaultModelSelectionID {
            return self.modelChoices.first(where: { $0.selectionID == self.modelSelectionID })
        }

        return self.sessionModelChoice(for: currentSession)
    }

    private func sessionModelChoice(
        for currentSession: OpenClawChatSessionEntry?) -> OpenClawChatModelChoice?
    {
        if Self.normalizedModelID(currentSession?.model) != nil {
            return self.modelChoice(modelID: currentSession?.model, provider: currentSession?.modelProvider)
        }
        return self.modelChoice(modelID: self.sessionDefaults?.model, provider: self.sessionDefaults?.modelProvider)
    }

    private func modelChoice(modelID: String?, provider: String?) -> OpenClawChatModelChoice? {
        guard let modelID = Self.normalizedModelID(modelID) else { return nil }
        let provider = provider?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let provider, !provider.isEmpty {
            let prefix = "\(provider)/"
            let selectionID = modelID.hasPrefix(prefix) ? modelID : "\(prefix)\(modelID)"
            return self.modelChoices.first(where: {
                $0.selectionID == selectionID ||
                    ($0.modelID == modelID && $0.provider == provider)
            })
        }

        let matches = self.modelChoices.filter { $0.selectionID == modelID || $0.modelID == modelID }
        return matches.count == 1 ? matches[0] : nil
    }

    private static func normalizedModelID(_ modelID: String?) -> String? {
        let trimmed = modelID?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let trimmed, !trimmed.isEmpty else { return nil }
        return trimmed
    }

    private static func sessionModelMatchesDefaults(
        _ session: OpenClawChatSessionEntry,
        defaults: OpenClawChatSessionsDefaults?) -> Bool
    {
        let providerMatches = session.modelProvider == nil || session.modelProvider == defaults?.modelProvider
        let modelMatches = session.model == nil || session.model == defaults?.model
        return providerMatches && modelMatches
    }

    private static func normalizedThinkingLevelOptions(
        _ levels: [OpenClawChatThinkingLevelOption]?) -> [OpenClawChatThinkingLevelOption]?
    {
        guard let levels else { return nil }
        return Self.dedupedThinkingOptions(
            levels.compactMap { level in
                guard let id = Self.normalizedThinkingLevel(level.id) else { return nil }
                let label = level.label.trimmingCharacters(in: .whitespacesAndNewlines)
                return OpenClawChatThinkingLevelOption(id: id, label: label.isEmpty ? id : label)
            })
    }

    private static func thinkingOptions(from labels: [String]?) -> [OpenClawChatThinkingLevelOption]? {
        guard let labels else { return nil }
        return Self.dedupedThinkingOptions(
            labels.compactMap { label in
                guard let id = Self.normalizedThinkingLevel(label) else { return nil }
                let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
                return OpenClawChatThinkingLevelOption(id: id, label: trimmed.isEmpty ? id : trimmed)
            })
    }

    static func withCurrentThinkingOption(
        _ options: [OpenClawChatThinkingLevelOption],
        current: String) -> [OpenClawChatThinkingLevelOption]
    {
        guard !options.contains(where: { $0.id == current }) else { return options }
        return options + [OpenClawChatThinkingLevelOption(id: current, label: current)]
    }

    private static func dedupedThinkingOptions(
        _ options: [OpenClawChatThinkingLevelOption]) -> [OpenClawChatThinkingLevelOption]
    {
        var result: [OpenClawChatThinkingLevelOption] = []
        var seen = Set<String>()
        for option in options {
            guard !option.id.isEmpty, !seen.contains(option.id) else { continue }
            seen.insert(option.id)
            result.append(option)
        }
        return result
    }

    static func normalizedThinkingLevel(_ level: String?) -> String? {
        guard let level else { return nil }
        let trimmed = level.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !trimmed.isEmpty else { return nil }
        let collapsed = trimmed.replacingOccurrences(
            of: "[\\s_-]+",
            with: "",
            options: .regularExpression)

        switch collapsed {
        case "adaptive", "auto":
            return "adaptive"
        case "max":
            return "max"
        case "xhigh", "extrahigh":
            return "xhigh"
        case "off", "none":
            return "off"
        case "on", "enable", "enabled":
            return "low"
        case "min", "minimal", "think":
            return "minimal"
        case "low", "thinkhard":
            return "low"
        case "mid", "med", "medium", "thinkharder", "harder":
            return "medium"
        case "high", "ultra", "ultrathink", "thinkhardest", "highest":
            return "high"
        default:
            return trimmed
        }
    }
}
