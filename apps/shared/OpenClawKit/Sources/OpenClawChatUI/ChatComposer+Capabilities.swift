import SwiftUI

extension OpenClawChatComposer {
    @ViewBuilder
    var cleanComposerCapabilityItems: some View {
        if self.viewModel.supportsComposerCapabilities,
           self.viewModel.composerCapabilityControlsAvailable
        {
            Divider()
            #if !os(iOS)
            Text("Tool changes apply to the next run.")
                .font(OpenClawChatTypography.caption)
            #endif
            self.composerWebSearchButton
            self.composerSkillsMenu
            self.composerConnectorsMenu
            if self.viewModel.composerToolOverrides.overrideCount > 0 {
                Divider()
                Button {
                    self.viewModel.clearComposerToolOverrides()
                } label: {
                    chatActionLabel(Text("Clear tool overrides"), systemImage: "arrow.counterclockwise")
                }
                .disabled(self.viewModel.composerClearToolOverridesDisabled)
                .accessibilityHint(
                    self.viewModel.composerToolOverrideMutationDisabledReason ?? "")
            }
            #if !os(iOS)
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
            if !self.viewModel.composerCapabilitiesLoading,
               !self.viewModel.composerCapabilityCatalog.webSearchAvailable,
               self.viewModel.composerCapabilityErrorMessage == nil
            {
                Text("Web Search is unavailable on this Gateway.")
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
            #endif
        }
    }

    @ViewBuilder
    var cleanInlinePermissionMenu: some View {
        if self.viewModel.composerCapabilityControlsAvailable {
            Menu {
                Picker(selection: Binding(
                    get: { self.viewModel.composerPermissionMode },
                    set: { self.viewModel.selectComposerPermissionMode($0) }))
                {
                    Text(String(localized: "Default (inherited)"))
                        .font(OpenClawChatTypography.body)
                        .tag(OpenClawChatPermissionMode?.none)
                        .accessibilityHint(self.viewModel.composerPermissionDisabledReason(nil) ?? "")
                    ForEach(OpenClawChatPermissionMode.allCases, id: \.rawValue) { mode in
                        Text(mode.displayName)
                            .font(OpenClawChatTypography.body)
                            .tag(Optional(mode))
                            .disabled(mode == .full && !self.viewModel.composerCapabilityCatalog
                                .canSelectFullPermission)
                            .accessibilityHint(self.viewModel.composerPermissionDisabledReason(mode) ?? "")
                    }
                } label: {
                    Text("Session permissions").font(OpenClawChatTypography.body)
                }
                .pickerStyle(.inline)
                if !self.viewModel.composerCapabilityCatalog.canSelectFullPermission {
                    Text("Full permission requires operator.admin access.")
                        .font(OpenClawChatTypography.caption)
                }
            } label: {
                self.cleanInlinePermissionGlyph
                    #if os(iOS)
                    // Sit 20 pt from the `+` glyph instead of a full control width away.
                        .padding(.trailing, 12)
                        .frame(
                            width: CleanChatComposerMetrics.glyphControlWidth,
                            height: CleanChatComposerMetrics.controlTouchSize)
                    #else
                        .frame(
                            width: CleanChatComposerMetrics.controlTouchSize,
                            height: CleanChatComposerMetrics.controlTouchSize)
                    #endif
                    .contentShape(Rectangle())
            }
            .menuIndicator(.hidden)
            #if os(iOS)
            .tint(CleanChatComposerMetrics.footerInk)
            #else
            .tint(OpenClawChatTheme.muted)
            #endif
            .disabled(
                !self.viewModel.composerCapabilityCatalog.permissionMutationAvailable ||
                    self.viewModel.composerCapabilityMutationDisabled)
            .accessibilityLabel("Session permissions")
            .accessibilityValue(
                self.viewModel.composerPermissionMode?.displayName ?? String(localized: "Default (inherited)"))
            .accessibilityHint(self.viewModel.composerPermissionMutationDisabledReason ?? "")
            .accessibilityIdentifier("chat-composer-inline-permissions")
        }
    }

    private var cleanInlinePermissionGlyph: some View {
        ZStack {
            Image(systemName: "shield")
                #if os(iOS)
                    .font(OpenClawChatTypography.composerGlyph)
                #else
                    .font(.system(size: OpenClawChatTypography.scaled(18), weight: .semibold))
                #endif
            Image(systemName: self.cleanInlinePermissionOverlaySymbol)
                .font(.system(size: OpenClawChatTypography.scaled(7), weight: .bold))
                .offset(y: -1)
        }
        #if os(iOS)
        // Full access carries the accent, as in the Control UI.
        .foregroundStyle(
                self.viewModel.composerPermissionMode == .full
                    ? OpenClawChatTheme.accent
                    : CleanChatComposerMetrics.footerInk)
        #else
            .foregroundStyle(.secondary)
        #endif
    }

    private var cleanInlinePermissionOverlaySymbol: String {
        switch self.viewModel.composerPermissionMode {
        case .readOnly: "ellipsis"
        case .guarded: "lock.fill"
        case .workspace: "gearshape.fill"
        case .full: "exclamationmark"
        case nil: "checkmark"
        }
    }

    /// The Gateway owns the value. Do not replay a toggle if a refreshed menu already has the requested state.
    private func capabilityToggle(
        _ value: @autoclosure @escaping @MainActor @Sendable () -> Bool,
        toggle: @escaping @MainActor @Sendable () -> Void) -> Binding<Bool>
    {
        Binding(get: value, set: {
            if $0 != value() {
                toggle()
            }
        })
    }

    private var composerWebSearchButton: some View {
        Toggle(isOn: self.capabilityToggle(self.viewModel.composerWebSearchEnabled) {
            self.viewModel.toggleComposerWebSearch()
        }) {
            chatActionLabel(Text("Web Search"), systemImage: "globe")
        }
        .disabled(
            !self.viewModel.composerCapabilityCatalog.webSearchAvailable ||
                !self.viewModel.composerCapabilityCatalog.webSearchBaseEnabled ||
                !self.viewModel.composerCapabilityCatalog.toolOverrideMutationAvailable ||
                self.viewModel.composerCapabilityMutationDisabled)
        .accessibilityHint(self.viewModel.composerWebSearchMutationDisabledReason ?? "")
        .accessibilityIdentifier("chat-composer-web-search")
    }

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
                    let statusMessage = self.viewModel.composerSkillStatusMessage(skill)
                    Toggle(isOn: self.capabilityToggle(self.viewModel.composerSkillEnabled(skill)) {
                        self.viewModel.toggleComposerSkill(skill)
                    }) {
                        Text(statusMessage.map { "\(skill.name) — \($0)" } ?? skill.name)
                            .font(OpenClawChatTypography.body)
                    }
                    .disabled(
                        !skill.baseEnabled || skill.missingDependencies || skill.blocked ||
                            !self.viewModel.composerCapabilityCatalog.toolOverrideMutationAvailable ||
                            self.viewModel.composerCapabilityMutationDisabled)
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
            chatActionLabel(Text("Connectors"), systemImage: "powerplug")
        }
        .accessibilityIdentifier("chat-composer-connectors")
    }

    private func composerConnectorMenu(_ connector: OpenClawChatComposerConnector) -> some View {
        let isEnabled = self.viewModel.composerConnectorEnabled(connector)
        return Menu {
            Toggle(isOn: self.capabilityToggle(self.viewModel.composerConnectorEnabled(connector)) {
                self.viewModel.toggleComposerConnector(connector)
            }) {
                Text("Enabled for this session").font(OpenClawChatTypography.body)
            }
            .disabled(
                !self.viewModel.composerCapabilityCatalog.toolOverrideMutationAvailable ||
                    self.viewModel.composerCapabilityMutationDisabled)
            .accessibilityHint(self.viewModel.composerToolOverrideMutationDisabledReason ?? "")

            if let notice = connector.notice {
                Text(notice)
                    .font(OpenClawChatTypography.caption)
            }
            if !connector.tools.isEmpty {
                Divider()
                Menu {
                    ForEach(connector.tools) { tool in
                        Toggle(isOn: self.capabilityToggle(self.viewModel.composerToolEnabled(
                            server: connector.name,
                            tool: tool.name))
                        {
                            self.viewModel.toggleComposerTool(server: connector.name, tool: tool.name)
                        }) {
                            Text(tool.label).font(OpenClawChatTypography.body)
                        }
                        .disabled(
                            !self.viewModel.composerCapabilityCatalog.toolAccessAvailable ||
                                !self.viewModel.composerCapabilityCatalog.toolOverrideMutationAvailable ||
                                self.viewModel.composerCapabilityMutationDisabled)
                        .accessibilityHint(self.viewModel.composerToolOverrideMutationDisabledReason ?? "")
                    }
                } label: {
                    chatActionLabel(Text("Tool Access"), systemImage: "wrench.and.screwdriver")
                }
            }
        } label: {
            // This row opens a submenu rather than toggling; keep its state visible before opening it.
            chatActionLabel(Text(connector.name), systemImage: isEnabled ? "checkmark.circle" : "circle")
        }
        .accessibilityValue(isEnabled ? String(localized: "On") : String(localized: "Off"))
        .accessibilityAddTraits(isEnabled ? .isSelected : [])
    }

    @ViewBuilder
    var composerCapabilityNoticeRow: some View {
        let notice = self.viewModel.composerCapabilityNotice
        #if os(iOS)
        let showsNotice = notice != OpenClawChatViewModel.toolChangesNextRunNotice &&
            notice != OpenClawChatViewModel.toolOverridesClearedNextRunNotice
        #else
        let showsNotice = true
        #endif
        if showsNotice, let notice {
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
    }
}
