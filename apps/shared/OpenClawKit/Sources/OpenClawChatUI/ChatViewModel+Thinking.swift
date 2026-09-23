import Foundation

extension OpenClawChatViewModel {
    func performSelectThinkingLevel(_ level: String) {
        let clearsOverride = level == Self.inheritedThinkingSelectionID
        let next = clearsOverride
            ? (Self.normalizedThinkingLevel(self.resolvedThinkingLevelOptions(
                for: self.currentSessionEntry(), modelChoice: self.selectedModelChoice(for: self.currentSessionEntry()))
                .defaultLevel)
                ?? Self.normalizedThinkingLevel(self.thinkingLevel)
                ?? "off")
            : (Self.normalizedThinkingLevel(level) ?? "off")
        if clearsOverride {
            guard !self.thinkingOverrideIsInherited else { return }
        } else {
            guard next != preferredThinkingLevel || self.thinkingOverrideIsInherited else { return }
        }

        self.errorText = nil
        let sessionKey = self.sessionKey
        let acceptedBaseline = Self.normalizedThinkingLevel(currentSessionEntry()?.thinkingLevel)
            ?? Self.normalizedThinkingLevel(thinkingLevel)
            ?? "off"
        let target = currentModelPatchTarget()
        if acceptedThinkingLevelsByTarget[target] == nil {
            // Preserve the gateway-confirmed value across the whole queued lane.
            // Later optimistic selections must not become rollback truth.
            acceptedThinkingLevelsByTarget[target] = acceptedBaseline
            acceptedPreferredThinkingLevelsByTarget[target] = preferredThinkingLevel
            let session = currentSessionEntry()
            acceptedSettingsPatchResultsByTarget[target] = OpenClawChatModelPatchResult(
                key: session?.key ?? target.canonicalSessionKey,
                modelProvider: session?.modelProvider,
                model: session?.model,
                thinkingLevel: acceptedBaseline,
                thinkingLevels: session?.thinkingLevels)
        }
        if acceptedExplicitThinkingPreferencesByTarget[target] == nil {
            acceptedExplicitThinkingPreferencesByTarget[target] = prefersExplicitThinkingLevel
            acceptedThinkingOverrideClearedByTarget[target] = currentSessionEntry()?.thinkingLevel == nil
        }
        prefersExplicitThinkingLevel = !clearsOverride
        preferredThinkingLevel = next
        thinkingLevel = next
        self.syncThinkingLevelOptions()
        self.updateCurrentSessionThinkingLevel(clearsOverride ? nil : next, sessionKey: sessionKey)
        let settingsRequestID = reserveSessionSettingsRequest(for: target)
        nextThinkingSelectionRequestID &+= 1
        let requestID = nextThinkingSelectionRequestID
        latestThinkingSelectionRequestIDsByTarget[target] = requestID
        thinkingPreferenceRequests[requestID] = .pending(ThinkingPreferenceState(
            level: next,
            isExplicit: !clearsOverride))
        self.reconcileThinkingPreferenceRequests()
        enqueueSessionSettingsPatch(requestID: settingsRequestID, target: target) { [weak self] routeLease in
            guard let self else { return }
            do {
                guard let routeLease else { throw OpenClawChatTransportSendError.notDispatched }
                let patchResult = try await routeLease.patchSessionSettings(
                    sessionKey: target.canonicalSessionKey,
                    agentID: target.agentID,
                    patch: OpenClawChatSessionSettingsPatch(
                        thinkingLevel: .some(clearsOverride ? nil : next)))
                let acceptedLevel = Self.normalizedThinkingLevel(patchResult?.thinkingLevel) ?? next
                let acceptedResult = self.mergedThinkingPatchSuccess(
                    patchResult,
                    acceptedLevel: acceptedLevel,
                    target: target)
                // Older queued successes remain rollback truth, but never replace
                // a newer optimistic selection in the session row or picker.
                self.lastSuccessfulSettingsPatchResultsByTarget[target] = acceptedResult
                self.acceptedSettingsPatchResultsByTarget[target] = acceptedResult
                self.acceptedThinkingLevelsByTarget[target] = acceptedLevel
                self.acceptedPreferredThinkingLevelsByTarget[target] = acceptedLevel
                self.acceptedExplicitThinkingPreferencesByTarget[target] = !clearsOverride
                self.acceptedThinkingOverrideClearedByTarget[target] = clearsOverride
                self.lastSuccessfulSettingsPatchRequestIDsByTarget[target] = settingsRequestID
                self.lastSuccessfulThinkingOverrideClearedByTarget[target] = clearsOverride
                self.thinkingPreferenceRequests[requestID] = .succeeded(ThinkingPreferenceState(
                    level: acceptedLevel,
                    isExplicit: !clearsOverride))
                self.reconcileThinkingPreferenceRequests()
                guard requestID == self.latestThinkingSelectionRequestIDsByTarget[target] else { return }
                let targetIsCurrent = target == self.currentModelPatchTarget()
                let stateKey: String
                let exactMatchOnly: Bool
                if targetIsCurrent {
                    stateKey = sessionKey
                    exactMatchOnly = false
                } else {
                    guard let inactiveStateKey = self.inactiveSettingsStateKey(for: target) else { return }
                    stateKey = inactiveStateKey
                    exactMatchOnly = true
                }
                self.updateCurrentSessionThinkingLevel(
                    clearsOverride ? nil : acceptedLevel,
                    sessionKey: stateKey,
                    exactMatchOnly: exactMatchOnly)
                if let thinkingLevels = acceptedResult.thinkingLevels {
                    self.updateCurrentSessionThinkingLevels(
                        thinkingLevels,
                        sessionKey: stateKey,
                        exactMatchOnly: exactMatchOnly)
                }
                guard targetIsCurrent else { return }
                self.preferredThinkingLevel = acceptedLevel
                self.thinkingLevel = acceptedLevel
                self.prefersExplicitThinkingLevel = !clearsOverride
                self.syncThinkingLevelOptions()
            } catch {
                self.thinkingPreferenceRequests[requestID] = .failed
                self.reconcileThinkingPreferenceRequests()
                guard requestID == self.latestThinkingSelectionRequestIDsByTarget[target] else { return }
                let rollbackResult = self.acceptedSettingsPatchResultsByTarget[target]
                let rollbackLevel = self.acceptedThinkingLevelsByTarget[target]
                    ?? Self.normalizedThinkingLevel(rollbackResult?.thinkingLevel)
                    ?? acceptedBaseline
                let rollbackPreferredLevel = self.acceptedPreferredThinkingLevelsByTarget[target]
                    ?? rollbackLevel
                let rollbackIsExplicit = self.acceptedExplicitThinkingPreferencesByTarget[target] ?? false
                let targetIsCurrent = target == self.currentModelPatchTarget()
                let stateKey: String
                let exactMatchOnly: Bool
                if targetIsCurrent {
                    stateKey = sessionKey
                    exactMatchOnly = false
                } else {
                    guard let inactiveStateKey = self.inactiveSettingsStateKey(for: target) else { return }
                    stateKey = inactiveStateKey
                    exactMatchOnly = true
                }
                self.updateCurrentSessionThinkingLevel(
                    self.acceptedThinkingOverrideClearedByTarget[target] == true ? nil : rollbackLevel,
                    sessionKey: stateKey,
                    exactMatchOnly: exactMatchOnly)
                if let thinkingLevels = rollbackResult?.thinkingLevels {
                    self.updateCurrentSessionThinkingLevels(
                        thinkingLevels,
                        sessionKey: stateKey,
                        exactMatchOnly: exactMatchOnly)
                }
                guard targetIsCurrent else { return }
                self.prefersExplicitThinkingLevel = rollbackIsExplicit
                self.preferredThinkingLevel = rollbackPreferredLevel
                self.thinkingLevel = rollbackLevel
                self.syncThinkingLevelOptions()
                // Option resolution may project the preferred value when it is
                // supported. A rejection must still leave the applied state at
                // the gateway-confirmed rollback value.
                self.thinkingLevel = rollbackLevel
                self.updateCurrentSessionThinkingLevel(
                    self.acceptedThinkingOverrideClearedByTarget[target] == true ? nil : rollbackLevel,
                    sessionKey: sessionKey)
                self.errorText = error.localizedDescription
            }
        }
    }

    private func mergedThinkingPatchSuccess(
        _ patchResult: OpenClawChatModelPatchResult?,
        acceptedLevel: String,
        target: ModelPatchTarget) -> OpenClawChatModelPatchResult
    {
        // Rollback truth can contain newer refreshed model metadata,
        // while the common success snapshot carries fast/verbosity patches.
        let accepted = self.acceptedSettingsPatchResultsByTarget[target]
        let successful = self.lastSuccessfulSettingsPatchResultsByTarget[target]
        return OpenClawChatModelPatchResult(
            key: patchResult?.key ?? accepted?.key ?? successful?.key ?? target.canonicalSessionKey,
            modelProvider: patchResult?.modelProvider ?? accepted?.modelProvider ?? successful?.modelProvider,
            model: patchResult?.model ?? accepted?.model ?? successful?.model,
            thinkingLevel: acceptedLevel,
            thinkingLevels: patchResult?.thinkingLevels ?? accepted?.thinkingLevels ?? successful?.thinkingLevels,
            fastMode: patchResult?.fastMode ?? successful?.fastMode ?? accepted?.fastMode,
            effectiveFastMode: patchResult?.effectiveFastMode ?? successful?.effectiveFastMode
                ?? accepted?.effectiveFastMode,
            verboseLevel: patchResult?.verboseLevel ?? successful?.verboseLevel ?? accepted?.verboseLevel)
    }

    private func reconcileThinkingPreferenceRequests() {
        let requestIDs = self.thinkingPreferenceRequests.keys.sorted(by: >)
        let resolved = requestIDs.compactMap { requestID -> ThinkingPreferenceState? in
            switch self.thinkingPreferenceRequests[requestID] {
            case let .pending(state), let .succeeded(state): state
            case .failed, .none: nil
            }
        }.first ?? self.confirmedThinkingPreference
        if resolved != self.emittedThinkingPreference {
            self.emittedThinkingPreference = resolved
            self.onThinkingLevelChanged?(resolved.level)
            self.onThinkingPreferenceChanged?(resolved.isExplicit ? resolved.level : nil)
        }
        guard !self.thinkingPreferenceRequests.values.contains(where: {
            if case .pending = $0 { return true }
            return false
        }) else { return }
        self.confirmedThinkingPreference = resolved
        self.thinkingPreferenceRequests.removeAll()
    }

    func recordAuthoritativeInheritedThinkingPreference(_ level: String) {
        self.confirmedThinkingPreference = ThinkingPreferenceState(level: level, isExplicit: false)
    }

    func updateCurrentSessionThinkingLevels(
        _ thinkingLevels: [OpenClawChatThinkingLevelOption],
        sessionKey: String,
        exactMatchOnly: Bool = false)
    {
        let index = exactMatchOnly
            ? sessions.firstIndex(where: { $0.key == sessionKey })
            : sessionIndexForModelState(sessionKey: sessionKey)
        guard let index else { return }
        sessions[index].thinkingLevels = thinkingLevels
        sessions[index].thinkingOptions = thinkingLevels.map(\.label)
    }

    /// Agent-qualified keys keep an immutable owner even when their main-session
    /// contract changes. Bare aliases cannot safely identify an inactive row.
    func inactiveSettingsStateKey(for target: ModelPatchTarget) -> String? {
        if target.agentID != nil || target.sessionRoutingContract != nil {
            guard OpenClawChatSessionKey.agentID(from: target.canonicalSessionKey) != nil else { return nil }
        }
        return target.canonicalSessionKey
    }

    func updateCurrentSessionThinkingLevel(
        _ thinkingLevel: String?,
        sessionKey: String,
        exactMatchOnly: Bool = false)
    {
        let index = exactMatchOnly
            ? sessions.firstIndex(where: { $0.key == sessionKey })
            : sessionIndexForModelState(sessionKey: sessionKey)
        guard let index else { return }
        sessions[index].thinkingLevel = thinkingLevel
    }

    func effectiveThinkingLevelForSend(
        _ storedLevel: String,
        sessionKey: String? = nil,
        canonicalSessionKey: String? = nil,
        agentID: String? = nil,
        sessionRoutingContract: String? = nil) -> String
    {
        let usesCurrentSession = sessionKey == nil ||
            (sessionKey == self.sessionKey && canonicalSessionKey == nil && agentID == nil)
        let session: OpenClawChatSessionEntry?
        let modelChoice: OpenClawChatModelChoice?
        let target: ModelPatchTarget
        if !usesCurrentSession, let sessionKey {
            target = modelPatchTarget(
                sessionKey: sessionKey,
                canonicalSessionKey: canonicalSessionKey,
                agentID: agentID,
                sessionRoutingContract: sessionRoutingContract)
            // Sessions absent from the loaded list resolve to no metadata and fail
            // open for existing levels. Ultra is new enough that an older or
            // truncated list must use its shipped High meaning until advertised.
            session = sessionEntryForThinking(
                sessionKey: sessionKey,
                canonicalSessionKey: canonicalSessionKey,
                agentID: agentID)
            guard session != nil else {
                let fallback = self.thinkingLevelWithoutGatewayMetadata(
                    storedLevel,
                    target: target,
                    session: nil)
                return fallback == "ultra" ? "high" : (fallback ?? storedLevel)
            }
            modelChoice = self.sessionModelChoice(for: session)
        } else {
            session = currentSessionEntry()
            modelChoice = self.selectedModelChoice(for: session)
            target = currentModelPatchTarget()
        }
        let resolved = self.resolvedThinkingLevelOptions(for: session, modelChoice: modelChoice)
        if modelChoice?.reasoning == false ||
            (!resolved.options.isEmpty && resolved.options.allSatisfy { $0.id == "off" })
        {
            return "off"
        }
        guard resolved.isGatewayMetadata else {
            return self.thinkingLevelWithoutGatewayMetadata(
                storedLevel,
                target: target,
                session: session) ?? storedLevel
        }
        return Self.normalizedThinkingLevel(
            storedLevel,
            options: resolved.options,
            fallback: session?.thinkingLevel) ?? storedLevel
    }

    func syncThinkingLevelOptions() {
        let currentSession = currentSessionEntry()
        showsThinkingPicker = self.thinkingPickerIsAvailable(
            for: currentSession,
            modelChoice: self.selectedModelChoice(for: currentSession))

        let resolved = self.resolvedThinkingLevelOptions(
            for: currentSession, modelChoice: self.selectedModelChoice(for: currentSession))
        let options = resolved.options
        let target = currentModelPatchTarget()
        let preferredLevel = self.prefersExplicitThinkingLevel
            ? self.preferredThinkingLevel
            : Self.normalizedThinkingLevel(currentSession?.thinkingLevel) ??
            Self.normalizedThinkingLevel(resolved.defaultLevel) ?? self.preferredThinkingLevel
        let preferred: String? = if resolved.isGatewayMetadata {
            Self.normalizedThinkingLevel(
                preferredLevel,
                options: options,
                fallback: currentSession?.thinkingLevel)
        } else {
            self.thinkingLevelWithoutGatewayMetadata(
                preferredLevel,
                target: target,
                session: currentSession)
        }
        let current = preferred ?? Self.normalizedThinkingLevel(currentSession?.thinkingLevel)
        if let current {
            self.thinkingLevel = current
        }
        thinkingLevelOptions = options
    }

    private func thinkingLevelWithoutGatewayMetadata(
        _ level: String,
        target: ModelPatchTarget,
        session: OpenClawChatSessionEntry?) -> String?
    {
        let preferred = Self.normalizedThinkingLevel(level)
        guard preferred == "ultra" else { return preferred }
        if let patched = Self.normalizedThinkingLevel(
            successfulModelPatchResult(for: target, session: session)?.thinkingLevel)
        {
            return patched
        }
        // Older gateways accept the legacy Ultra spelling as High but do not
        // return capability metadata. Never advertise/send more than they run.
        if completedModelPatchTargets.contains(target) {
            return "high"
        }
        return preferred
    }

    private func thinkingPickerIsAvailable(
        for session: OpenClawChatSessionEntry?,
        modelChoice: OpenClawChatModelChoice?) -> Bool
    {
        let resolved = self.resolvedThinkingLevelOptions(for: session, modelChoice: modelChoice)
        return resolved.options.contains { $0.id != "off" } && modelChoice?.reasoning != false
    }

    private struct ThinkingLevelOptionsResolution {
        let options: [OpenClawChatThinkingLevelOption]
        let isGatewayMetadata: Bool
        var defaultLevel: String?
    }

    private func resolvedThinkingLevelOptions(
        for currentSession: OpenClawChatSessionEntry?,
        modelChoice: OpenClawChatModelChoice?) -> ThinkingLevelOptionsResolution
    {
        let profile = OpenClawChatThinkingProfile.resolve(
            session: currentSession, defaults: self.sessionDefaults, model: modelChoice)
        return ThinkingLevelOptionsResolution(
            options: profile?.levels ?? [], isGatewayMetadata: profile != nil, defaultLevel: profile?.defaultLevel)
    }

    func selectedModelChoice(
        for currentSession: OpenClawChatSessionEntry?) -> OpenClawChatModelChoice?
    {
        if modelSelectionID != Self.defaultModelSelectionID {
            return modelChoices.first(where: { $0.selectionID == self.modelSelectionID })
        }

        return self.sessionModelChoice(for: currentSession)
    }

    private func sessionModelChoice(
        for currentSession: OpenClawChatSessionEntry?) -> OpenClawChatModelChoice?
    {
        if Self.normalizedModelID(currentSession?.model) != nil {
            return self.modelChoice(modelID: currentSession?.model, provider: currentSession?.modelProvider)
        }
        return self.modelChoice(modelID: sessionDefaults?.model, provider: sessionDefaults?.modelProvider)
    }

    private func modelChoice(modelID: String?, provider: String?) -> OpenClawChatModelChoice? {
        guard let modelID = Self.normalizedModelID(modelID) else { return nil }
        let provider = provider?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let provider, !provider.isEmpty {
            let prefix = "\(provider)/"
            let selectionID = modelID.hasPrefix(prefix) ? modelID : "\(prefix)\(modelID)"
            return modelChoices.first(where: {
                $0.selectionID == selectionID ||
                    ($0.modelID == modelID && $0.provider == provider)
            })
        }

        let matches = modelChoices.filter { $0.selectionID == modelID || $0.modelID == modelID }
        return matches.count == 1 ? matches[0] : nil
    }

    private static func normalizedModelID(_ modelID: String?) -> String? {
        let trimmed = modelID?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let trimmed, !trimmed.isEmpty else { return nil }
        return trimmed
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
        case "ultra":
            return "ultra"
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
        case "high", "ultrathink", "thinkhardest", "highest":
            return "high"
        default:
            return trimmed
        }
    }

    static func normalizedThinkingLevel(
        _ level: String?,
        options: [OpenClawChatThinkingLevelOption],
        fallback: String? = nil) -> String?
    {
        guard let normalized = normalizedThinkingLevel(level) else { return nil }
        guard normalized == "ultra" else { return normalized }
        let advertised = options.compactMap { self.normalizedThinkingLevel($0.id) }
        if advertised.contains("ultra") {
            return "ultra"
        }
        if let fallback = normalizedThinkingLevel(fallback), advertised.contains(fallback) {
            return fallback
        }
        return advertised
            .filter { $0 != "off" }
            .max { self.thinkingLevelRank($0) < self.thinkingLevelRank($1) }
    }

    private static func thinkingLevelRank(_ level: String) -> Int {
        switch level {
        case "off": 0
        case "minimal": 10
        case "low": 20
        case "medium", "adaptive": 30
        case "high": 40
        case "xhigh": 60
        case "max": 70
        case "ultra": 80
        default: -1
        }
    }
}
