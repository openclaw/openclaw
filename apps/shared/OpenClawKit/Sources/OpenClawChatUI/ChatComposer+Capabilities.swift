import SwiftUI

extension OpenClawChatComposer {
    @ViewBuilder
    var cleanComposerCapabilityItems: some View {
        if self.viewModel.supportsComposerCapabilities,
           self.viewModel.composerCapabilityControlsAvailable
        {
            Divider()
            self.composerSkillsMenu
            self.composerConnectorsMenu
            if self.viewModel.composerToolOverrides.overrideCount > 0 {
                Divider()
                Button {
                    self.viewModel.clearComposerToolOverrides()
                } label: {
                    chatActionLabel(Text("Clear tool overrides"), systemImage: "xmark.circle")
                }
                .disabled(self.viewModel.composerClearToolOverridesDisabled)
                .accessibilityHint(
                    self.viewModel.composerToolOverrideMutationDisabledReason ?? "")
            }
            if !self.viewModel.composerCapabilitiesLoading,
               let reason = self.viewModel.composerPermissionMutationDisabledReason,
               !self.viewModel.composerCapabilityCatalog.permissionMutationAvailable
            {
                Text(reason)
                    .font(OpenClawChatTypography.caption)
            }
            if !self.viewModel.composerCapabilitiesLoading,
               let reason = self.viewModel.composerToolOverrideMutationDisabledReason,
               !self.viewModel.composerCapabilityCatalog.toolOverrideMutationAvailable
            {
                Text(reason)
                    .font(OpenClawChatTypography.caption)
            }
            if let errorMessage = self.viewModel.composerCapabilityErrorMessage {
                Text(errorMessage)
                    .font(OpenClawChatTypography.caption)
                Button {
                    Task { await self.viewModel.loadComposerCapabilities(force: true) }
                } label: {
                    chatActionLabel(Text("Retry capability loading"), systemImage: "arrow.clockwise")
                }
            }
        }
    }

    #if os(iOS)
    /// One glyph for the session's permission mode. It opens the sheet that also holds the built-in
    /// tools, so the composer never spells out a mode or a tool state.
    @ViewBuilder
    var cleanInlinePermissionButton: some View {
        if self.viewModel.composerCapabilityControlsAvailable {
            let mode = self.viewModel.composerPermissionMode
            Button {
                self.showsPermissionsSheet = true
            } label: {
                // Full access carries the accent, as in the Control UI. The trailing padding sits the
                // glyph 20 pt from the `+` instead of a full control width away.
                ChatPermissionModeGlyph(mode: mode, size: 15)
                    .foregroundStyle(mode == .full ? OpenClawChatTheme.accent : CleanChatComposerMetrics.footerInk)
                    .padding(.trailing, 12)
                    .frame(
                        width: CleanChatComposerMetrics.glyphControlWidth,
                        height: CleanChatComposerMetrics.controlTouchSize)
                    // A full touch target that takes the gap after it, so no neighbor's target overlaps it.
                    .frame(width: CleanChatComposerMetrics.controlTouchSize, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Session permissions")
            .accessibilityValue(mode?.displayName ?? String(localized: "Agent default"))
            .accessibilityIdentifier("chat-composer-inline-permissions")
        }
    }
    #endif

    private var composerSkillsMenu: some View {
        Menu {
            if self.viewModel.composerCapabilitiesLoading {
                Text("Loading skills…")
                    .font(OpenClawChatTypography.body)
            } else if !self.viewModel.composerCapabilityCatalog.skillsAvailable {
                Text("Skills unavailable")
                    .font(OpenClawChatTypography.body)
            } else if self.viewModel.composerCapabilityCatalog.skills.isEmpty {
                Text("No skills configured")
                    .font(OpenClawChatTypography.body)
            } else {
                ForEach(self.viewModel.composerCapabilityCatalog.skills) { skill in
                    let isEnabled = self.viewModel.composerSkillEnabled(skill)
                    let statusMessage = self.viewModel.composerSkillStatusMessage(skill)
                    Button {
                        self.viewModel.toggleComposerSkill(skill)
                    } label: {
                        chatActionLabel(
                            Text(statusMessage.map { "\(skill.name) — \($0)" } ?? skill.name),
                            systemImage: isEnabled ? "checkmark.circle.fill" : "circle")
                    }
                    .disabled(
                        !skill.baseEnabled || skill.missingDependencies || skill.blocked ||
                            !self.viewModel.composerCapabilityCatalog.toolOverrideMutationAvailable ||
                            self.viewModel.composerCapabilityMutationDisabled)
                    .accessibilityValue(isEnabled ? String(localized: "On") : String(localized: "Off"))
                    .accessibilityAddTraits(isEnabled ? .isSelected : [])
                    .accessibilityHint(
                        statusMessage ?? self.viewModel.composerToolOverrideMutationDisabledReason ?? "")
                }
            }
        } label: {
            chatActionLabel(Text("Skills"), systemImage: "book.closed")
        }
        .accessibilityIdentifier("chat-composer-skills")
    }

    private var composerConnectorsMenu: some View {
        Menu {
            if self.viewModel.composerCapabilitiesLoading {
                Text("Loading connectors…")
                    .font(OpenClawChatTypography.body)
            } else if !self.viewModel.composerCapabilityCatalog.connectorsAvailable {
                Text("Connectors unavailable")
                    .font(OpenClawChatTypography.body)
            } else if self.viewModel.composerCapabilityCatalog.connectors.isEmpty {
                Text("No connectors configured")
                    .font(OpenClawChatTypography.body)
            } else {
                ForEach(self.viewModel.composerCapabilityCatalog.connectors) { connector in
                    self.composerConnectorMenu(connector)
                }
            }
        } label: {
            chatActionLabel(Text("Connectors"), systemImage: "puzzlepiece.extension")
        }
        .accessibilityIdentifier("chat-composer-connectors")
    }

    private func composerConnectorMenu(_ connector: OpenClawChatComposerConnector) -> some View {
        let isEnabled = self.viewModel.composerConnectorEnabled(connector)
        return Menu {
            Button {
                self.viewModel.toggleComposerConnector(connector)
            } label: {
                chatActionLabel(
                    Text("Enabled for this session"),
                    systemImage: isEnabled ? "checkmark.circle.fill" : "circle")
            }
            .disabled(
                !self.viewModel.composerCapabilityCatalog.toolOverrideMutationAvailable ||
                    self.viewModel.composerCapabilityMutationDisabled)
            .accessibilityValue(isEnabled ? String(localized: "On") : String(localized: "Off"))
            .accessibilityAddTraits(isEnabled ? .isSelected : [])
            .accessibilityHint(self.viewModel.composerToolOverrideMutationDisabledReason ?? "")

            if let notice = connector.notice {
                Text(notice)
                    .font(OpenClawChatTypography.caption)
            }
            if !connector.tools.isEmpty {
                Divider()
                Menu {
                    ForEach(connector.tools) { tool in
                        let toolIsEnabled = self.viewModel.composerToolEnabled(
                            server: connector.name,
                            tool: tool.name)
                        Button {
                            self.viewModel.toggleComposerTool(server: connector.name, tool: tool.name)
                        } label: {
                            chatActionLabel(
                                Text(tool.label),
                                systemImage: toolIsEnabled ? "checkmark.circle.fill" : "circle")
                        }
                        .disabled(
                            !self.viewModel.composerCapabilityCatalog.toolAccessAvailable ||
                                !self.viewModel.composerCapabilityCatalog.toolOverrideMutationAvailable ||
                                self.viewModel.composerCapabilityMutationDisabled)
                        .accessibilityValue(toolIsEnabled ? String(localized: "On") : String(localized: "Off"))
                        .accessibilityAddTraits(toolIsEnabled ? .isSelected : [])
                        .accessibilityHint(self.viewModel.composerToolOverrideMutationDisabledReason ?? "")
                    }
                } label: {
                    chatActionLabel(Text("Tool Access"), systemImage: "wrench.and.screwdriver")
                }
            }
        } label: {
            chatActionLabel(Text(connector.name), systemImage: isEnabled ? "checkmark.circle.fill" : "circle")
        }
        .accessibilityValue(isEnabled ? String(localized: "On") : String(localized: "Off"))
        .accessibilityAddTraits(isEnabled ? .isSelected : [])
    }

    /// iOS shows these notices in the permissions sheet, not in the composer.
    @ViewBuilder
    var composerCapabilityNoticeRow: some View {
        #if !os(iOS)
        if let notice = self.viewModel.composerCapabilityNotice {
            HStack(alignment: .center, spacing: 8) {
                Image(systemName: "info.circle.fill")
                    .foregroundStyle(OpenClawChatTheme.accent)
                    .accessibilityHidden(true)
                Text(notice)
                    .font(OpenClawChatTypography.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 4)
                Button {
                    self.viewModel.dismissComposerCapabilityNotice()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .frame(
                    width: CleanChatComposerMetrics.controlTouchSize,
                    height: CleanChatComposerMetrics.controlTouchSize)
                .contentShape(Rectangle())
                .accessibilityLabel("Dismiss capability notice")
                .accessibilityIdentifier("chat-composer-dismiss-capability-notice")
            }
            .padding(.horizontal, 8)
            .padding(.top, 6)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("chat-composer-capability-notice")
        }
        #endif
    }
}
