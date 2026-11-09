import SwiftUI

/// Session-owned model controls shared by chat and focused authoring surfaces.
@MainActor
struct OpenClawChatModelPicker: View {
    @Bindable private var viewModel: OpenClawChatViewModel

    init(viewModel: OpenClawChatViewModel) {
        self.viewModel = viewModel
    }

    var body: some View {
        Menu {
            ChatDeferredContent {
                let sections = self.viewModel.modelPickerSections
                if self.viewModel.canSelectDefaultModel {
                    self.modelMenuOption(
                        self.viewModel.defaultModelLabel,
                        selectionID: OpenClawChatViewModel.defaultModelSelectionID)
                }
                if !sections.pinned.isEmpty {
                    Section {
                        self.modelOptions(sections.pinned)
                    } header: {
                        Text("Pinned")
                            .font(OpenClawChatTypography.captionSemiBold)
                    }
                }
                if !sections.recent.isEmpty {
                    Section {
                        self.modelOptions(sections.recent)
                    } header: {
                        Text("Recent")
                            .font(OpenClawChatTypography.captionSemiBold)
                    }
                }
                ForEach(sections.providers) { provider in
                    Section {
                        self.modelOptions(provider.models)
                    } header: {
                        HStack(spacing: 4) {
                            Text(provider.displayName)
                            if provider.isDefaultProvider {
                                Text(String(localized: "Default"))
                                    .font(OpenClawChatTypography.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        } label: {
            Text(self.viewModel.modelSelectionID == OpenClawChatViewModel.defaultModelSelectionID
                ? self.viewModel.defaultModelLabel : self.viewModel.canonicalModelSelectionID)
                .font(OpenClawChatTypography.captionSemiBold)
        }
        .menuIndicator(.hidden)
        .tint(OpenClawChatTheme.muted)
        .accessibilityLabel("Model")
        .controlSize(.small)
        .task(id: self.viewModel.composerCapabilityOwnerID) {
            await self.viewModel.loadComposerCapabilities()
        }
        .frame(maxWidth: 240, alignment: .leading)
        .help("Model")
        .disabled(self.viewModel.isUpdatingSessionSettings || !self.viewModel.composerModelMutationAvailable)
        .accessibilityHint(self.viewModel.composerModelMutationAvailable ? "" :
            String(localized: "Changing the model requires operator.write or operator.admin access."))
    }

    func modelOptions(_ models: [OpenClawChatModelChoice], showsDefaultBadge: Bool = true) -> some View {
        ForEach(models) { model in
            let unavailable = self.viewModel.modelUnavailableDescription(model)
            let defaultBadge = showsDefaultBadge && self.viewModel.isDefaultModel(model)
                ? String(localized: "Default") : nil
            self.modelMenuOption(
                [model.displayLabel, model.capabilityDescription, unavailable, defaultBadge].compactMap(\.self)
                    .filter { !$0.isEmpty }.joined(separator: " — "),
                selectionID: model.selectionID)
                .disabled(unavailable != nil)
                .accessibilityHint(unavailable ?? "")
        }
    }

    func modelMenuOption(_ title: String, selectionID: String) -> some View {
        let selected = self.viewModel.canonicalModelSelectionID == selectionID
        return Button {
            self.viewModel.selectModel(selectionID)
        } label: {
            if selected {
                Label {
                    Text(verbatim: title)
                } icon: {
                    Image(systemName: "checkmark")
                }
            } else {
                Text(verbatim: title)
            }
        }
        .font(OpenClawChatTypography.captionSemiBold)
        .accessibilityLabel(title)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

@MainActor
struct OpenClawChatThinkingPicker: View {
    @Bindable private var viewModel: OpenClawChatViewModel

    init(viewModel: OpenClawChatViewModel) {
        self.viewModel = viewModel
    }

    var body: some View {
        Picker(selection: Binding(
            get: { self.viewModel.thinkingSelectionID },
            set: { next in self.viewModel.selectThinkingLevel(next) }))
        {
            Text(String(localized: "Default (inherited)"))
                .font(OpenClawChatTypography.captionSemiBold)
                .tag(OpenClawChatViewModel.inheritedThinkingSelectionID)
            ForEach(self.viewModel.thinkingLevelOptions) { option in
                Text(String(
                    format: String(localized: "%@ (override)"),
                    option.label))
                    .font(OpenClawChatTypography.captionSemiBold)
                    .tag(option.id)
            }
        } label: {
            Text("Thinking")
                .font(OpenClawChatTypography.captionSemiBold)
        }
        .font(OpenClawChatTypography.captionSemiBold)
        .pickerStyle(.menu)
        .controlSize(.small)
        .task(id: self.viewModel.composerCapabilityOwnerID) {
            await self.viewModel.loadComposerCapabilities()
        }
        .frame(maxWidth: 140, alignment: .leading)
        .disabled(self.viewModel.isUpdatingSessionSettings || !self.viewModel.composerEffortMutationAvailable)
        .accessibilityHint(self.viewModel.composerEffortMutationAvailable ? "" :
            String(localized: "Thinking and Fast controls require operator.admin access."))
    }
}

#if os(iOS)
/// The same compact effort control used in the normal conversation footer.
@MainActor
struct OpenClawChatInlineEffortPicker: View {
    @Bindable private var viewModel: OpenClawChatViewModel

    init(viewModel: OpenClawChatViewModel) {
        self.viewModel = viewModel
    }

    var body: some View {
        Menu {
            if self.viewModel.showsThinkingPicker {
                OpenClawChatThinkingPicker(viewModel: self.viewModel)
            }
            if self.viewModel.showsFastModeControls {
                Picker("Fast", selection: Binding(
                    get: { self.viewModel.fastModeSelectionID },
                    set: { self.viewModel.selectFastMode($0) }))
                {
                    Text("Default (inherited)").tag(OpenClawChatViewModel.inheritedThinkingSelectionID)
                    Text("On").tag("on").disabled(!self.viewModel.selectedModelSupportsFastMode)
                    Text("Off").tag("off").disabled(!self.viewModel.selectedModelSupportsFastMode)
                }
            }
        } label: {
            ZStack(alignment: .topTrailing) {
                ZStack {
                    Circle().trim(from: 0.12, to: 0.88)
                        .stroke(.secondary, style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
                        .rotationEffect(.degrees(90))
                    Capsule().fill(.secondary).frame(width: 1.5, height: 7)
                        .offset(y: -3.5)
                        .rotationEffect(.degrees(self.viewModel.composerInlineEffortAngle))
                }.frame(width: 18, height: 18)
                if self.viewModel.fastModeIsEnabled {
                    Image(systemName: "bolt.fill").font(OpenClawChatTypography.caption)
                        .foregroundStyle(OpenClawChatTheme.accent).offset(x: 7, y: -6)
                }
            }
            .frame(
                width: CleanChatComposerMetrics.controlTouchSize,
                height: CleanChatComposerMetrics.controlTouchSize)
            .contentShape(Rectangle())
        }
        .menuIndicator(.hidden)
        .tint(OpenClawChatTheme.muted)
        .disabled(!self.viewModel.composerEffortMutationAvailable || self.viewModel.isUpdatingSessionSettings ||
            self.viewModel.hasActiveRunForComposerSettings)
        .accessibilityLabel("Effort")
        .accessibilityValue(self.viewModel.composerInlineEffortLabel)
        .accessibilityHint(self.viewModel.composerEffortMutationAvailable ? "" :
            String(localized: "Thinking and Fast controls require operator.admin access."))
        .accessibilityIdentifier("chat-composer-inline-effort")
        .task(id: self.viewModel.composerCapabilityOwnerID) { await self.viewModel.loadComposerCapabilities() }
    }
}
#endif
