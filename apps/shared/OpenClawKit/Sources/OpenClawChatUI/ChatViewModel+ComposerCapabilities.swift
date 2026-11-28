import Foundation
import OpenClawKit

extension OpenClawChatViewModel {
    var hasActiveRunForComposerSettings: Bool {
        self.pendingRunCount > 0 || self.hasAdvertisedLiveRun ||
            self.hasActiveSessionRunWithoutChatSnapshot
    }

    public func selectThinkingLevel(_ level: String) {
        guard self.composerEffortMutationAvailable else { return }
        self.performSelectThinkingLevel(level)
    }

    public func selectVerboseLevel(_ level: String) {
        guard self.composerVerboseMutationAvailable else { return }
        self.performSelectVerboseLevel(level)
    }

    public func selectFastMode(_ selectionID: String) {
        guard self.composerEffortMutationAvailable else { return }
        self.performSelectFastMode(selectionID)
    }

    var supportsComposerCapabilities: Bool {
        self.transport.supportsComposerCapabilities
    }

    var composerCapabilityOwnerID: String {
        let target = self.currentModelPatchTarget()
        return [
            target.canonicalSessionKey,
            target.agentID ?? "",
            target.sessionRoutingContract ?? "",
            self.composerCapabilitySessionID ?? "",
        ].joined(separator: "\u{1f}")
    }

    private var composerCapabilitySessionID: String? {
        self.sessionId?.trimmedNonEmpty ?? self.currentSessionEntry()?.sessionId?.trimmedNonEmpty
    }

    private var composerCapabilityOwnerMatches: Bool {
        self.composerCapabilityState.ownerID == self.composerCapabilityOwnerID
    }

    var composerCapabilityCatalog: OpenClawChatComposerCapabilityCatalog {
        self.composerCapabilityOwnerMatches
            ? self.composerCapabilityState.catalog
            : OpenClawChatComposerCapabilityCatalog()
    }

    var composerCapabilityControlsAvailable: Bool {
        self.composerCapabilityCatalog.sessionSettingsAvailable
    }

    var composerModelMutationAvailable: Bool {
        guard !self.isSubmittingDraft || self.newChatDraft?.key != self.sessionKey else { return false }
        return !self.supportsComposerCapabilities || self.composerCapabilityCatalog.modelMutationAvailable
    }

    var composerEffortMutationAvailable: Bool {
        guard !self.isSubmittingDraft || self.newChatDraft?.key != self.sessionKey else { return false }
        return !self.supportsComposerCapabilities || self.composerCapabilityCatalog.effortMutationAvailable
    }

    /// Why the phone's effort controls are locked: shown under them in the bar and read as the chip's hint.
    /// Nil while they can change, including the moment a change saves, so the bar does not grow and shrink
    /// on every pick. A running reply does not lock them: a change applies from the next message.
    var composerPhoneEffortLockReason: String? {
        if !self.composerEffortMutationAvailable {
            return String(localized: "You don’t have permission to change this.")
        }
        return nil
    }

    /// Whether the effort control has anything to offer: levels to choose, or speed options.
    var composerOffersEffortChoices: Bool {
        self.showsThinkingPicker || self.selectedModelSupportsFastMode
    }

    public var composerVerboseMutationAvailable: Bool {
        guard !self.isSubmittingDraft || self.newChatDraft?.key != self.sessionKey else { return false }
        return !self.supportsComposerCapabilities || self.composerCapabilityCatalog.verboseMutationAvailable
    }

    var composerCapabilitiesLoading: Bool {
        self.composerCapabilityOwnerMatches && self.composerCapabilityState.phase == .loading
    }

    /// A patch or reload is in flight. The catalog is empty while it reloads, so a view that stays
    /// open across a change keeps its last state until this clears.
    var composerCapabilitiesBusy: Bool {
        self.composerCapabilityOwnerMatches &&
            (self.composerCapabilityState.phase == .loading || self.composerCapabilityState.isMutating)
    }

    var composerCapabilityMutationDisabled: Bool {
        !self.composerCapabilityOwnerMatches || !self.composerCapabilityControlsAvailable ||
            self.composerCapabilityState.phase != .loaded ||
            self.composerCapabilityState.isMutating || self.isUpdatingSessionSettings
    }

    var composerCapabilityNotice: String? {
        self.composerCapabilityOwnerMatches ? self.composerCapabilityState.notice : nil
    }

    var composerCapabilityErrorMessage: String? {
        self.composerCapabilityOwnerMatches ? self.composerCapabilityState.errorMessage : nil
    }

    func composerSessionSettingsExpectation() -> OpenClawChatSessionSettingsExpectation? {
        guard self.composerCapabilityOwnerMatches,
              self.composerCapabilityCatalog.sessionSettingsCASAvailable,
              let entry = self.currentSessionEntry()
        else { return nil }
        return OpenClawChatSessionSettingsExpectation(
            permissionMode: entry.permissionMode,
            toolOverrides: entry.toolOverrides)
    }

    func durableSessionSettingsExpectation() -> OpenClawChatSessionSettingsExpectation {
        let entry = self.currentSessionEntry()
        return OpenClawChatSessionSettingsExpectation(
            permissionMode: entry?.permissionMode,
            toolOverrides: entry?.toolOverrides)
    }

    func waitForCapabilitySettingsBarrier(
        in sessionKey: String,
        canonicalSessionKey: String? = nil,
        agentID: String? = nil,
        sessionRoutingContract: String? = nil,
        preferenceWaitLimit: Duration? = nil) async -> String?
    {
        let target = self.sessionSettingsPatchTarget(
            in: sessionKey,
            canonicalSessionKey: canonicalSessionKey,
            agentID: agentID,
            sessionRoutingContract: sessionRoutingContract)
        let hadPendingMutation = (self.inFlightSettingsPatchCountsByTarget[target] ?? 0) > 0
        let failureRevision = self.capabilityPatchFailureRevisionsByTarget[target, default: 0]
        await self.waitForPendingSessionSettings(for: target, atMost: preferenceWaitLimit)
        guard hadPendingMutation,
              self.capabilityPatchFailureRevisionsByTarget[target, default: 0] != failureRevision
        else { return nil }
        return self.capabilityPatchFailureMessagesByTarget[target]
    }

    var composerPermissionMutationDisabledReason: String? {
        if !self.composerCapabilityOwnerMatches || self.composerCapabilitiesLoading {
            return String(localized: "Loading chat settings…")
        }
        if !self.composerCapabilityControlsAvailable {
            return String(localized: "Update OpenClaw to change chat settings.")
        }
        if !self.composerCapabilityCatalog.sessionSettingsCASAvailable {
            return String(localized: "Update the Gateway to change permissions.")
        }
        if self.composerCapabilityState.isMutating || self.isUpdatingSessionSettings {
            return String(localized: "Saving chat settings…")
        }
        if !self.composerCapabilityCatalog.permissionMutationAvailable {
            return String(localized: "You need write access to change permissions.")
        }
        return nil
    }

    var composerToolOverrideMutationDisabledReason: String? {
        if !self.composerCapabilityOwnerMatches || self.composerCapabilitiesLoading {
            return String(localized: "Loading chat settings…")
        }
        if !self.composerCapabilityControlsAvailable {
            return String(localized: "Update OpenClaw to change chat settings.")
        }
        if self.composerCapabilityCatalog.toolOverrideMutationRequiresGatewayUpgrade {
            return String(localized: "Update OpenClaw to change tools.")
        }
        if self.composerCapabilityState.isMutating || self.isUpdatingSessionSettings {
            return String(localized: "Saving chat settings…")
        }
        if !self.composerCapabilityCatalog.toolOverrideMutationAvailable {
            return String(localized: "You need admin access to change tools.")
        }
        return nil
    }

    var composerWebSearchMutationDisabledReason: String? {
        if self.composerCapabilitiesLoading {
            return String(localized: "Loading chat settings…")
        }
        if !self.composerCapabilityCatalog.webSearchAvailable {
            return self
                .composerCapabilityErrorMessage ?? String(localized: "Web search is unavailable on this Gateway.")
        }
        if !self.composerCapabilityCatalog.webSearchBaseEnabled {
            return String(localized: "Web search is off in the Gateway configuration.")
        }
        return self.composerToolOverrideMutationDisabledReason
    }

    func composerSkillDisabledReason(_ skill: OpenClawChatComposerSkill) -> String? {
        if !skill.baseEnabled {
            return String(localized: "Disabled in the Gateway configuration.")
        }
        if skill.missingDependencies {
            return String(localized: "Missing dependencies.")
        }
        if skill.blocked {
            return String(localized: "Blocked by policy.")
        }
        return self.composerToolOverrideMutationDisabledReason
    }

    func composerSkillStatusMessage(_ skill: OpenClawChatComposerSkill) -> String? {
        if let disabledReason = self.composerSkillDisabledReason(skill) {
            return disabledReason
        }
        if skill.agentFiltered, self.composerToolOverrides.skills[skill.key] == nil {
            return String(localized: "Off for this agent. Turn it on for this chat.")
        }
        return nil
    }

    var composerClearToolOverridesDisabled: Bool {
        self.composerCapabilityMutationDisabled ||
            !self.composerCapabilityCatalog.toolOverrideMutationAvailable ||
            self.composerToolOverrides.isEmpty
    }

    func dismissComposerCapabilityNotice() {
        self.composerCapabilityState.notice = nil
    }

    var composerPermissionMode: OpenClawChatPermissionMode? {
        self.currentSessionEntry()?.permissionMode
    }

    var composerToolOverrides: OpenClawChatSessionToolOverrides {
        self.confirmedCapabilityToolOverridesByTarget[self.currentModelPatchTarget()]?.overrides ??
            self.currentSessionEntry()?.toolOverrides ?? OpenClawChatSessionToolOverrides()
    }

    var composerWebSearchEnabled: Bool {
        self.composerCapabilityCatalog.webSearchAvailable &&
            self.composerCapabilityCatalog.webSearchBaseEnabled && self.composerToolOverrides.webSearch != false
    }

    func composerSkillEnabled(_ skill: OpenClawChatComposerSkill) -> Bool {
        guard skill.baseEnabled, !skill.missingDependencies, !skill.blocked else { return false }
        return self.composerToolOverrides.skills[skill.key] ?? !skill.agentFiltered
    }

    func composerConnectorEnabled(_ connector: OpenClawChatComposerConnector) -> Bool {
        self.composerToolOverrides.mcpServers[connector.name] ?? connector.baseEnabled
    }

    func composerToolEnabled(server: String, tool: String) -> Bool {
        let catalogTool = self.composerCapabilityCatalog.connectors
            .first(where: { $0.name == server })?.tools
            .first(where: { $0.name == tool })
        guard let catalogTool, catalogTool.baseEnabled else { return false }
        if let confirmed = self.confirmedCapabilityToolOverridesByTarget[self.currentModelPatchTarget()] {
            return confirmed.overrides?.mcpToolsDeny[server]?.contains(tool) != true
        }
        return !catalogTool.sessionDenied
    }

    func loadComposerCapabilities(force: Bool = false) async {
        guard self.supportsComposerCapabilities else { return }
        let ownerID = self.composerCapabilityOwnerID
        if !force,
           self.composerCapabilityState.ownerID == ownerID,
           self.composerCapabilityState.phase == .loaded || self.composerCapabilityState.phase == .loading
        {
            return
        }
        self.composerCapabilityState.loadGeneration &+= 1
        let loadGeneration = self.composerCapabilityState.loadGeneration
        self.composerCapabilityState.ownerID = ownerID
        self.composerCapabilityState.phase = .loading
        self.composerCapabilityState.catalog = OpenClawChatComposerCapabilityCatalog()
        self.composerCapabilityState.notice = nil
        self.composerCapabilityState.errorMessage = nil
        let target = self.currentModelPatchTarget()
        let catalog = await self.transport.loadComposerCapabilityCatalog(
            sessionKey: target.canonicalSessionKey,
            agentID: target.agentID)
        guard self.composerCapabilityState.loadGeneration == loadGeneration,
              self.composerCapabilityOwnerID == ownerID,
              self.currentModelPatchTarget() == target
        else { return }
        self.composerCapabilityState.catalog = catalog
        self.composerCapabilityState.phase = catalog.permissionMutationAvailable ||
            catalog.skillsAvailable || catalog.connectorsAvailable || catalog.toolAccessAvailable
            ? .loaded
            : .failed
        if self.composerCapabilityState.phase == .failed {
            self.composerCapabilityState.errorMessage = String(localized: "Composer capabilities are unavailable.")
        } else {
            self.composerCapabilityState.errorMessage = catalog.loadFailureMessage
        }
    }

    /// Health recovery retries a snapshot that never loaded on a healthy route: one loaded before the
    /// operator connected has no scopes, and its owner ID need not change on connect. A loaded snapshot
    /// stays; replacement sockets invalidate it through the reconnect events.
    func reloadUnsettledComposerCapabilities() {
        guard self.supportsComposerCapabilities,
              !self.composerCapabilityOwnerMatches || self.composerCapabilityState.phase != .loaded
        else { return }
        Task { [weak self] in
            // The recovery pass reloads capabilities after its transcript settles.
            guard let self, self.pendingTransportRecoveryID == nil else { return }
            await self.loadComposerCapabilities(force: true)
        }
    }

    func invalidateComposerCapabilities() {
        self.capabilityPatchFailureRevisionsByTarget.removeAll()
        self.capabilityPatchFailureMessagesByTarget.removeAll()
        self.confirmedCapabilityToolOverridesByTarget.removeAll()
        self.composerCapabilityState.loadGeneration &+= 1
        self.composerCapabilityState.mutationGeneration &+= 1
        self.composerCapabilityState.ownerID = ""
        self.composerCapabilityState.phase = .idle
        self.composerCapabilityState.catalog = OpenClawChatComposerCapabilityCatalog()
        self.composerCapabilityState.isMutating = false
        self.composerCapabilityState.notice = nil
        self.composerCapabilityState.errorMessage = nil
    }

    func selectComposerPermissionMode(_ mode: OpenClawChatPermissionMode?) {
        guard self.composerCapabilityControlsAvailable,
              self.composerCapabilityCatalog.permissionMutationAvailable
        else { return }
        guard mode != .full || self.composerCapabilityCatalog.canSelectFullPermission else { return }
        guard mode != self.composerPermissionMode else { return }
        self.performComposerCapabilityPatch(
            OpenClawChatSessionSettingsPatch(permissionMode: .some(mode)),
            notice: Self.permissionsNextRunNotice)
    }

    func toggleComposerWebSearch() {
        guard self.composerCapabilityControlsAvailable,
              self.composerCapabilityCatalog.webSearchAvailable,
              self.composerCapabilityCatalog.webSearchBaseEnabled,
              self.composerCapabilityCatalog.toolOverrideMutationAvailable
        else { return }
        var next = self.composerToolOverrides
        let desired = !self.composerWebSearchEnabled
        next.webSearch = desired == self.composerCapabilityCatalog.webSearchBaseEnabled ? nil : desired
        self.patchComposerToolOverrides(next)
    }

    func toggleComposerSkill(_ skill: OpenClawChatComposerSkill) {
        guard self.composerCapabilityControlsAvailable,
              self.composerCapabilityCatalog.toolOverrideMutationAvailable,
              skill.baseEnabled, !skill.missingDependencies,
              !skill.blocked
        else { return }
        var next = self.composerToolOverrides
        let desired = !self.composerSkillEnabled(skill)
        let baseEnabled = !skill.agentFiltered
        next.skills[skill.key] = desired == baseEnabled ? nil : desired
        self.patchComposerToolOverrides(next)
    }

    func toggleComposerConnector(_ connector: OpenClawChatComposerConnector) {
        guard self.composerCapabilityControlsAvailable,
              self.composerCapabilityCatalog.toolOverrideMutationAvailable
        else { return }
        var next = self.composerToolOverrides
        let desired = !self.composerConnectorEnabled(connector)
        next.mcpServers[connector.name] = desired == connector.baseEnabled ? nil : desired
        self.patchComposerToolOverrides(next)
    }

    func toggleComposerTool(server: String, tool: String) {
        guard self.composerCapabilityControlsAvailable,
              self.composerCapabilityCatalog.toolOverrideMutationAvailable
        else { return }
        var next = self.composerToolOverrides
        let connector = self.composerCapabilityCatalog.connectors.first { $0.name == server }
        let effectiveDenied = if let confirmed = self
            .confirmedCapabilityToolOverridesByTarget[self.currentModelPatchTarget()]
        {
            confirmed.overrides?.mcpToolsDeny[server] ?? []
        } else {
            connector?.tools.filter(\.sessionDenied).map(\.name) ?? []
        }
        var denied = Set(next.mcpToolsDeny[server] ?? effectiveDenied)
        if denied.contains(tool) {
            denied.remove(tool)
        } else {
            denied.insert(tool)
        }
        next.mcpToolsDeny[server] = denied.isEmpty ? nil : denied.sorted()
        self.patchComposerToolOverrides(next)
    }

    func clearComposerToolOverrides() {
        guard !self.composerClearToolOverridesDisabled else { return }
        self.performComposerCapabilityPatch(
            OpenClawChatSessionSettingsPatch(toolOverrides: .some(nil)),
            notice: Self.toolOverridesClearedNextRunNotice)
    }

    static var toolOverridesClearedNextRunNotice: String {
        String(localized: "Tool overrides will be cleared for the next reply.")
    }

    static var permissionsNextRunNotice: String {
        String(localized: "New permissions apply to the next reply.")
    }

    static var toolChangesNextRunNotice: String {
        String(localized: "Tool changes apply to the next reply.")
    }

    func patchComposerToolOverrides(_ overrides: OpenClawChatSessionToolOverrides) {
        let normalized = overrides.isEmpty ? nil : overrides
        self.performComposerCapabilityPatch(
            OpenClawChatSessionSettingsPatch(toolOverrides: .some(normalized)),
            notice: Self.toolChangesNextRunNotice)
    }

    private func performComposerCapabilityPatch(
        _ patch: OpenClawChatSessionSettingsPatch,
        notice: String?)
    {
        guard self.composerCapabilityOwnerMatches,
              self.composerCapabilityControlsAvailable,
              self.composerCapabilityState.phase == .loaded,
              !self.composerCapabilityState.isMutating
        else { return }
        if self.isNewChatDraft {
            guard !self.isSubmittingDraft else { return }
            _ = self.stageNewChatDraftSettings(patch)
            self.composerCapabilityState.notice = notice
            return
        }
        guard let expectedSessionID = self.composerCapabilitySessionID else {
            self.composerCapabilityState.errorMessage = String(
                localized: "Reload this chat before changing its tools.")
            return
        }
        let target = self.currentModelPatchTarget()
        let originalSessionKey = self.sessionKey
        let originalOutboxScope = self.outboxBranchScope(for: self.currentSessionSnapshot())
        let ownerID = self.composerCapabilityOwnerID
        let expectedToolOverrides: OpenClawChatSessionToolOverrides?? = patch.toolOverrides == nil
            ? nil
            : .some(self.currentSessionEntry()?.toolOverrides)
        let expectedPermissionMode: OpenClawChatPermissionMode?? = patch.permissionMode == nil
            ? nil
            : .some(self.currentSessionEntry()?.permissionMode)
        let scopedPatch = patch.withExpectedSessionID(
            expectedSessionID,
            expectedPermissionMode: expectedPermissionMode,
            expectedToolOverrides: expectedToolOverrides)
        self.composerCapabilityState.mutationGeneration &+= 1
        let mutationGeneration = self.composerCapabilityState.mutationGeneration
        self.composerCapabilityState.isMutating = true
        self.composerCapabilityState.errorMessage = nil
        self.composerCapabilityState.notice = nil
        let requestID = self.reserveSessionSettingsRequest(for: target)
        self.enqueueSessionSettingsPatch(requestID: requestID, target: target) { [weak self] routeLease in
            guard let self else { return }
            @MainActor
            func isCurrentMutation() -> Bool {
                self.composerCapabilityState.mutationGeneration == mutationGeneration &&
                    self.composerCapabilityOwnerID == ownerID &&
                    self.composerCapabilitySessionID == expectedSessionID &&
                    target == self.currentModelPatchTarget() &&
                    self.sessionKey == originalSessionKey
            }
            defer {
                if self.composerCapabilityState.mutationGeneration == mutationGeneration {
                    self.composerCapabilityState.isMutating = false
                }
            }
            do {
                guard let routeLease else {
                    throw OpenClawChatTransportSendError.notDispatched
                }
                guard isCurrentMutation() else { return }
                if let outbox = self.outbox, let originalOutboxScope {
                    let parked = await outbox.parkQueuedCommands(
                        in: originalOutboxScope,
                        lastError: OpenClawChatSQLiteTranscriptCache.outboxSettingsChangedError)
                    guard isCurrentMutation() else { return }
                    guard parked else {
                        throw NSError(
                            domain: "OpenClawChatOutbox",
                            code: 1,
                            userInfo: [
                                NSLocalizedDescriptionKey: String(
                                    localized: "Could not secure queued messages before changing session settings."),
                            ])
                    }
                }
                let result = try await routeLease.patchSessionSettings(
                    target.canonicalSessionKey,
                    target.agentID,
                    scopedPatch)
                guard isCurrentMutation() else { return }
                guard let index = self.sessionIndexForModelState(sessionKey: originalSessionKey) else { return }
                if let permissionMode = patch.permissionMode {
                    self.sessions[index].permissionMode = result?.permissionMode ?? permissionMode
                }
                if let toolOverrides = patch.toolOverrides {
                    let accepted = result?.toolOverrides ?? toolOverrides
                    self.sessions[index].toolOverrides = accepted
                    self.confirmedCapabilityToolOverridesByTarget[target] = accepted
                        .map(ToolOverridesState.value) ?? ToolOverridesState.none
                }
                if patch.toolOverrides != nil {
                    await self.loadComposerCapabilities(force: true)
                }
                guard isCurrentMutation() else { return }
                self.composerCapabilityState.notice = notice
            } catch {
                self.capabilityPatchFailureRevisionsByTarget[target, default: 0] &+= 1
                self.capabilityPatchFailureMessagesByTarget[target] = error.localizedDescription
                if let outbox = self.outbox, let scope = originalOutboxScope {
                    _ = await outbox.parkQueuedCommands(in: scope, lastError: error.localizedDescription)
                }
                guard isCurrentMutation() else { return }
                self.composerCapabilityState.errorMessage = error.localizedDescription
                self.postSettingChangeFailure(patch) {
                    self.reportFailure(
                        String(localized: "Couldn’t update this chat’s settings."),
                        error,
                        while: "update chat capabilities")
                }
            }
        }
    }
}
