import Foundation

extension OpenClawChatViewModel {
    public static let verboseLevelOptions = ["off", "on", "full"]

    public var thinkingSelectionID: String {
        self.thinkingOverrideIsInherited ? Self.inheritedThinkingSelectionID : self.thinkingLevel
    }

    public var thinkingOverrideIsInherited: Bool {
        if self.hasAppliedLiveSessions {
            return self.currentSessionEntry()?.thinkingLevel == nil
        }
        return !self.prefersExplicitThinkingLevel
    }

    public var verboseLevel: String {
        if self.hasAppliedLiveSessions {
            return Self.normalizedVerboseLevel(self.currentSessionEntry()?.verboseLevel) ?? "off"
        }
        return self.preferredVerboseLevel
    }

    public var fastModeEnabled: Bool {
        let session = self.currentSessionEntry()
        return (session?.effectiveFastMode ?? session?.fastMode)?.isEnabled == true
    }

    /// `models.list` currently has no fast-support capability field. Keep the
    /// control available and let the gateway validate the session patch.
    public var selectedModelSupportsFastMode: Bool {
        true
    }

    public var isUpdatingSessionSettings: Bool {
        self.inFlightSettingsPatchCountsByTarget[self.currentModelPatchTarget()] != nil
    }

    static func normalizedVerboseLevel(_ level: String?) -> String? {
        let normalized = level?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return Self.verboseLevelOptions.contains(normalized ?? "") ? normalized : nil
    }

    func performSelectVerboseLevel(_ level: String) {
        guard let next = Self.normalizedVerboseLevel(level) else { return }
        let target = self.currentModelPatchTarget()
        let sessionKey = self.sessionKey
        let baselineSessionLevel = self.currentSessionEntry()?.verboseLevel
        guard next != self.verboseLevel || baselineSessionLevel == nil else { return }

        if self.acceptedVerboseLevelsByTarget[target] == nil {
            self.acceptedVerboseLevelsByTarget[target] = baselineSessionLevel.map(VerboseLevelState.value)
                ?? VerboseLevelState.none
        }

        self.updateCurrentSessionVerboseLevel(next, sessionKey: sessionKey)
        self.nextVerboseSelectionRequestID &+= 1
        let verboseRequestID = self.nextVerboseSelectionRequestID
        self.verbosePreferenceRequests[verboseRequestID] = .pending(next)
        self.reconcileVerbosePreferenceRequests()
        let requestID = self.reserveSessionSettingsRequest(for: target)
        self.enqueueSessionSettingsPatch(requestID: requestID, target: target) { [weak self] routeLease in
            guard let self else { return }
            do {
                guard let routeLease else { throw OpenClawChatTransportSendError.notDispatched }
                let result = try await routeLease.patchSessionSettings(
                    sessionKey: target.canonicalSessionKey,
                    agentID: target.agentID,
                    patch: OpenClawChatSessionSettingsPatch(verboseLevel: .some(next)))
                let accepted = Self.normalizedVerboseLevel(result?.verboseLevel) ?? next
                self.acceptedVerboseLevelsByTarget[target] = .value(accepted)
                self.recordModelControlPatchSuccess(
                    result: result,
                    requestID: requestID,
                    target: target,
                    verboseLevel: accepted)
                self.verbosePreferenceRequests[verboseRequestID] = .succeeded(accepted)
                self.reconcileVerbosePreferenceRequests()
                if let state = self.modelControlState(for: target, originalSessionKey: sessionKey) {
                    self.updateCurrentSessionVerboseLevel(
                        accepted,
                        sessionKey: state.key,
                        exactMatchOnly: state.exactMatchOnly)
                }
            } catch {
                self.verbosePreferenceRequests[verboseRequestID] = .failed
                self.reconcileVerbosePreferenceRequests()
                if let state = self.modelControlState(for: target, originalSessionKey: sessionKey) {
                    self.updateCurrentSessionVerboseLevel(
                        self.acceptedVerboseLevelsByTarget[target]?.level,
                        sessionKey: state.key,
                        exactMatchOnly: state.exactMatchOnly)
                }
            }
        }
    }

    private func reconcileVerbosePreferenceRequests() {
        let resolved = self.verbosePreferenceRequests.keys.sorted(by: >).compactMap { requestID -> String? in
            switch self.verbosePreferenceRequests[requestID] {
            case let .pending(level), let .succeeded(level): level
            case .failed, .none: nil
            }
        }.first ?? self.confirmedVerboseLevel
        if resolved != self.preferredVerboseLevel {
            self.preferredVerboseLevel = resolved
            self.onVerboseLevelChanged?(resolved)
        }
        guard !self.verbosePreferenceRequests.values.contains(where: {
            if case .pending = $0 { return true }
            return false
        }) else { return }
        self.confirmedVerboseLevel = resolved
        self.verbosePreferenceRequests.removeAll()
    }

    func performSetFastModeEnabled(_ enabled: Bool) {
        guard enabled != self.fastModeEnabled else { return }
        let target = self.currentModelPatchTarget()
        let sessionKey = self.sessionKey
        let baselineFastMode = self.currentSessionEntry()?.fastMode
        let baselineEffectiveFastMode = self.currentSessionEntry()?.effectiveFastMode
        let next: OpenClawChatFastMode = enabled ? .on : .off

        self.updateCurrentSessionFastMode(next, effective: next, sessionKey: sessionKey)
        let requestID = self.reserveSessionSettingsRequest(for: target)
        self.enqueueSessionSettingsPatch(requestID: requestID, target: target) { [weak self] routeLease in
            guard let self else { return }
            do {
                guard let routeLease else { throw OpenClawChatTransportSendError.notDispatched }
                let result = try await routeLease.patchSessionSettings(
                    sessionKey: target.canonicalSessionKey,
                    agentID: target.agentID,
                    patch: OpenClawChatSessionSettingsPatch(fastMode: .some(next)))
                let accepted = result?.fastMode ?? next
                self.recordModelControlPatchSuccess(
                    result: result,
                    requestID: requestID,
                    target: target,
                    fastMode: accepted)
                if let state = self.modelControlState(for: target, originalSessionKey: sessionKey) {
                    self.updateCurrentSessionFastMode(
                        accepted,
                        effective: accepted,
                        sessionKey: state.key,
                        exactMatchOnly: state.exactMatchOnly)
                }
            } catch {
                if let state = self.modelControlState(for: target, originalSessionKey: sessionKey) {
                    self.updateCurrentSessionFastMode(
                        baselineFastMode,
                        effective: baselineEffectiveFastMode,
                        sessionKey: state.key,
                        exactMatchOnly: state.exactMatchOnly)
                }
            }
        }
    }

    func applyModelControlPatchResult(_ result: OpenClawChatModelPatchResult, sessionKey: String) {
        if let fastMode = result.fastMode {
            self.updateCurrentSessionFastMode(fastMode, effective: fastMode, sessionKey: sessionKey)
        }
        if let verboseLevel = Self.normalizedVerboseLevel(result.verboseLevel) {
            self.updateCurrentSessionVerboseLevel(verboseLevel, sessionKey: sessionKey)
        }
    }

    private func recordModelControlPatchSuccess(
        result: OpenClawChatModelPatchResult?,
        requestID: UInt64,
        target: ModelPatchTarget,
        fastMode: OpenClawChatFastMode? = nil,
        verboseLevel: String? = nil)
    {
        let previous = self.lastSuccessfulSettingsPatchResultsByTarget[target]
        self.lastSuccessfulSettingsPatchRequestIDsByTarget[target] = requestID
        self.lastSuccessfulSettingsPatchResultsByTarget[target] = OpenClawChatModelPatchResult(
            key: result?.key ?? previous?.key ?? target.canonicalSessionKey,
            modelProvider: result?.modelProvider ?? previous?.modelProvider,
            model: result?.model ?? previous?.model,
            thinkingLevel: result?.thinkingLevel ?? previous?.thinkingLevel,
            thinkingLevels: result?.thinkingLevels ?? previous?.thinkingLevels,
            fastMode: result?.fastMode ?? fastMode ?? previous?.fastMode,
            verboseLevel: result?.verboseLevel ?? verboseLevel ?? previous?.verboseLevel)
    }

    private func modelControlState(for target: ModelPatchTarget, originalSessionKey: String)
        -> (key: String, exactMatchOnly: Bool)?
    {
        if target == self.currentModelPatchTarget() {
            return (originalSessionKey, false)
        }
        guard let key = self.inactiveSettingsStateKey(for: target) else { return nil }
        return (key, true)
    }

    private func updateCurrentSessionVerboseLevel(
        _ level: String?,
        sessionKey: String,
        exactMatchOnly: Bool = false)
    {
        let index = exactMatchOnly
            ? self.sessions.firstIndex(where: { $0.key == sessionKey })
            : self.sessionIndexForModelState(sessionKey: sessionKey)
        guard let index else { return }
        self.sessions[index].verboseLevel = level
    }

    private func updateCurrentSessionFastMode(
        _ mode: OpenClawChatFastMode?,
        effective: OpenClawChatFastMode?,
        sessionKey: String,
        exactMatchOnly: Bool = false)
    {
        let index = exactMatchOnly
            ? self.sessions.firstIndex(where: { $0.key == sessionKey })
            : self.sessionIndexForModelState(sessionKey: sessionKey)
        guard let index else { return }
        self.sessions[index].fastMode = mode
        self.sessions[index].effectiveFastMode = effective
    }
}
