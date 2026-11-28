import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

extension OpenClawChatComposer {
    @ViewBuilder
    private var cleanAttachmentMenu: some View {
        #if os(macOS)
        Button {
            self.pickFilesMac()
        } label: {
            CompactChatAttachmentLabel(controlSize: self.cleanControlHeight)
        }
        .buttonStyle(.plain)
        .controlSize(.small)
        .accessibilityLabel("Attachments")
        .accessibilityIdentifier("chat-attachment-picker")
        .disabled(!self.isAttachmentInputEnabled)
        #else
        Menu {
            Button {
                self.photoPickerPresentation.wrappedValue = true
            } label: {
                chatActionLabel(Text("Photo Library"), systemImage: "photo.on.rectangle")
            }
            .disabled(!self.isAttachmentInputEnabled)

            #if canImport(UIKit)
            Button {
                self.cameraPickerPresentation.wrappedValue = true
            } label: {
                chatActionLabel(Text("Camera"), systemImage: "camera")
            }
            .disabled(
                !self.isAttachmentInputEnabled ||
                    !UIImagePickerController.isSourceTypeAvailable(.camera))
            #endif

            Button {
                self.fileImporterPresentation.wrappedValue = true
            } label: {
                chatActionLabel(Text("File"), systemImage: "folder")
            }
            .disabled(!self.isAttachmentInputEnabled)

            Divider()
            if self.viewModel.sessionBranches.count > 1 {
                self.branchMenu
            }
            self.verbosityPicker
                .disabled(!self.viewModel.composerVerboseMutationAvailable)
            self.cleanComposerCapabilityItems
        } label: {
            CompactChatAttachmentLabel()
        }
        .help("Composer options")
        .accessibilityLabel("Composer options")
        .accessibilityIdentifier("chat-attachment-picker")
        .buttonStyle(.plain)
        .task(id: self.viewModel.composerCapabilityOwnerID) {
            await self.viewModel.loadComposerCapabilities()
        }
        #endif
    }

    #if os(iOS)
    func cleanPhoneEditor(expanded: Bool) -> some View {
        CleanComposerPhoneLayout(expanded: expanded) {
            // Open, the field hugs its lines so the layout can place them; closed, it takes the
            // controls' full height, which centers the line on them and keeps the whole pill tappable.
            self.editorOverlay
                .frame(maxWidth: .infinity, minHeight: expanded ? nil : self.cleanControlHeight, alignment: .leading)
                .contentShape(Rectangle())
                .onTapGesture { self.focusDraft() }
            HStack(spacing: 0) {
                if expanded {
                    self.cleanLeadingControls
                } else {
                    self.cleanAttachmentMenu
                }
            }
            HStack(spacing: 0) {
                if expanded {
                    self.cleanTrailingControls
                } else {
                    self.cleanCaptureAndPrimaryControls
                }
            }
        }
    }
    #endif

    var compactEditor: some View {
        HStack(alignment: .center, spacing: 4) {
            self.cleanAttachmentMenu

            if self.viewModel.sessionBranches.count > 1 {
                self.branchMenu
            }

            self.editorOverlay
                .frame(maxWidth: .infinity, minHeight: self.cleanControlHeight, alignment: .leading)
                .layoutPriority(1)

            self.cleanCaptureAndPrimaryControls
        }
    }

    @ViewBuilder
    var cleanLeadingControls: some View {
        #if os(macOS)
        Menu {
            Button {
                self.pickFilesMac()
            } label: {
                Label("Attach…", systemImage: "paperclip")
            }
            .disabled(!self.isAttachmentInputEnabled)
            Divider()
            if self.viewModel.sessionBranches.count > 1 {
                self.branchMenu
            }
            self.verbosityPicker
                .disabled(!self.viewModel.composerVerboseMutationAvailable)
        } label: {
            CompactChatAttachmentLabel(controlSize: self.cleanControlHeight)
        }
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Composer options")
        .accessibilityLabel("Composer options")
        .accessibilityIdentifier("chat-attachment-picker")
        #elseif os(iOS)
        self.cleanAttachmentMenu
        if self.viewModel.supportsComposerCapabilities {
            self.cleanInlinePermissionMenu
        }
        #else
        self.cleanAttachmentMenu
        #endif
    }

    #if !os(iOS)
    @ViewBuilder
    var cleanContextUsageMenu: some View {
        if let usage = self.viewModel.contextUsage {
            OpenClawChatContextUsageControl(
                usage: usage,
                canCompact: self.viewModel.canRequestSessionCompact,
                controlSize: self.cleanControlHeight,
                onCompact: self.viewModel.requestSessionCompact)
        }
    }

    #endif

    var cleanTrailingControls: some View {
        ViewThatFits(in: .horizontal) {
            self.cleanInlineControls(compactModel: false)
            self.cleanInlineControls(compactModel: true)
        }
    }

    private func cleanInlineControls(compactModel: Bool) -> some View {
        HStack(spacing: 0) {
            #if !os(iOS)
            self.cleanContextUsageMenu
            #endif
            // Camera switching only displaces settings in the compact iOS footer.
            #if os(macOS)
            self.cleanInlineModelPicker(compact: compactModel)
            self.cleanInlineEffortMenu
            #else
            if !self.cleanShowsCameraFlip {
                self.cleanInlineModelPicker(compact: compactModel)
                self.cleanInlineEffortMenu
            }
            #endif
            self.cleanCaptureAndPrimaryControls
        }
    }

    private func cleanInlineModelPicker(compact: Bool) -> some View {
        Menu {
            // ViewThatFits constructs both footer variants while typing. Keep catalog
            // grouping and menu actions inside the menu's own evaluation boundary.
            ChatDeferredContent {
                let sections = self.viewModel.modelPickerSections
                if let target = self.viewModel.modelSelectionTargetDescription {
                    Text(target)
                        .font(OpenClawChatTypography.caption)
                        .accessibilityIdentifier("chat-composer-model-selection-target")
                    Divider()
                }
                Group {
                    if self.viewModel.canSelectDefaultModel {
                        self.modelMenuOption(
                            self.viewModel.defaultModelLabel,
                            selectionID: OpenClawChatViewModel.defaultModelSelectionID)
                    }
                    if !sections.pinned.isEmpty {
                        Section("Pinned") {
                            self.modelOptions(sections.pinned, showsDefaultBadge: false)
                        }
                    }
                    if !sections.recent.isEmpty {
                        Section("Recent") {
                            self.modelOptions(sections.recent, showsDefaultBadge: false)
                        }
                    }
                    ForEach(sections.providers) { provider in
                        Section(provider.displayName) {
                            self.modelOptions(provider.models, showsDefaultBadge: false)
                        }
                    }
                }
                .disabled(self.cleanModelChoicesDisabled)
                #if os(macOS)
                if self.viewModel.modelSelectionID != OpenClawChatViewModel.defaultModelSelectionID {
                    Divider()
                    Button {
                        self.viewModel.toggleSelectedModelPinned()
                    } label: {
                        Label(
                            self.viewModel.isSelectedModelPinned ? "Unpin model" : "Pin model",
                            systemImage: self.viewModel.isSelectedModelPinned ? "star.slash" : "star")
                    }
                }
                if self.usesDesktopModelMenu {
                    Divider()
                    self.modelSignInButton
                }
                #elseif os(iOS)
                Divider()
                self.modelSignInButton
                #endif
            }
        } label: {
            self.cleanInlineModelLabel(compact: compact)
        }
        .menuIndicator(.hidden)
        .tint(OpenClawChatTheme.muted)
        #if os(macOS)
        // Mac session settings remain editable during a response; pinning is
        // local and stays available while a Gateway settings save is pending.
        .fixedSize()
        #elseif !os(iOS)
        .disabled(
            !self.viewModel.showsModelPicker ||
                !self.viewModel.composerModelMutationAvailable ||
                self.viewModel.isUpdatingSessionSettings ||
                self.viewModel.hasActiveRunForComposerSettings)
        #endif
        // Sign-in stays reachable even when choosing a model is unavailable.
        .help(self.cleanInlineModelDisabledHint ?? self.viewModel.composerInlineModelLabel)
        .accessibilityLabel("Model")
        .accessibilityValue(self.viewModel.composerInlineModelLabel)
        .accessibilityHint(self.cleanInlineModelDisabledHint ?? "")
        .accessibilityIdentifier("chat-composer-inline-model")
        .layoutPriority(1)
    }

    @ViewBuilder
    private func cleanInlineModelLabel(compact: Bool) -> some View {
        #if os(macOS)
        HStack(spacing: 6) {
            Text(self.viewModel.composerInlineModelLabel)
                .lineLimit(1)
                .truncationMode(.middle)
            Image(systemName: "chevron.down")
                .font(.system(size: 9, weight: .semibold))
                .accessibilityHidden(true)
        }
        .font(OpenClawChatTypography.caption)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 6)
        .frame(width: compact ? 104 : 160, height: self.cleanControlHeight)
        .contentShape(Rectangle())
        #else
        if compact || self.dynamicTypeSize.isAccessibilitySize {
            Image(systemName: "cpu")
                .font(.system(size: OpenClawChatTypography.scaled(16), weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(
                    width: CleanChatComposerMetrics.compactModelWidth,
                    height: CleanChatComposerMetrics.controlTouchSize)
                .contentShape(Rectangle())
        } else {
            Text(self.viewModel.composerInlineModelLabel)
                .font(OpenClawChatTypography.captionSemiBold)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
                // Hug short names; long catalog names stop at a cap instead of crowding Send.
                .padding(.horizontal, 6)
                .frame(
                    minWidth: CleanChatComposerMetrics.controlTouchSize,
                    maxWidth: CleanChatComposerMetrics.regularModelMaxWidth,
                    minHeight: CleanChatComposerMetrics.controlTouchSize)
                .contentShape(Rectangle())
        }
        #endif
    }

    #if os(iOS)
    private var cleanPhoneMenuChevron: some View {
        Image(systemName: "chevron.down")
            .font(OpenClawChatTypography.composerChevronGlyph)
            .opacity(0.8)
            .accessibilityHidden(true)
    }
    #endif

    private var cleanInlineEffortMenu: some View {
        #if os(macOS)
        OpenClawChatEffortControl(
            thinkingOptions: self.viewModel.showsThinkingPicker ? self.viewModel.thinkingLevelOptions : [],
            thinkingLevel: self.viewModel.thinkingLevel,
            thinkingIsInherited: self.viewModel.thinkingOverrideIsInherited,
            fastModeEnabled: self.viewModel.fastModeIsEnabled,
            fastModeIsInherited: self.viewModel.fastModeSelectionID == OpenClawChatViewModel
                .inheritedThinkingSelectionID,
            showsFastMode: self.viewModel.showsFastModeControls,
            supportsFastMode: self.viewModel.selectedModelSupportsFastMode,
            isEnabled: self.viewModel.composerEffortMutationAvailable && !self.viewModel.isUpdatingSessionSettings,
            controlHeight: self.cleanControlHeight,
            showsLabel: false,
            onSelectThinkingLevel: {
                self.viewModel.selectThinkingLevel($0 ?? OpenClawChatViewModel.inheritedThinkingSelectionID)
            },
            onSelectFastMode: {
                self.viewModel.selectFastMode($0.map { $0 ? "on" : "off" }
                    ?? OpenClawChatViewModel.inheritedThinkingSelectionID)
            })
            .help(self.cleanInlineEffortDisabledHint ?? self.viewModel.composerInlineEffortLabel)
            .accessibilityHint(self.cleanInlineEffortDisabledHint ?? "")
            .fixedSize()
        #else
        Menu {
            if self.viewModel.showsThinkingPicker {
                self.thinkingPicker
            }
            if self.viewModel.showsFastModeControls {
                self.fastModeToggle
            }
        } label: {
            ZStack(alignment: .topTrailing) {
                ZStack {
                    Circle()
                        .trim(from: 0.12, to: 0.88)
                        .stroke(.secondary, style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
                        .rotationEffect(.degrees(90))
                    Capsule()
                        .fill(.secondary)
                        .frame(width: 1.5, height: 7)
                        .offset(y: -3.5)
                        .rotationEffect(.degrees(self.viewModel.composerInlineEffortAngle))
                }
                .frame(width: 18, height: 18)
                if self.viewModel.fastModeIsEnabled {
                    Image(systemName: "bolt.fill")
                        .font(OpenClawChatTypography.caption)
                        .foregroundStyle(OpenClawChatTheme.accent)
                        .offset(x: 7, y: -6)
                }
            }
            .frame(
                width: self.cleanControlHeight,
                height: self.cleanControlHeight)
            .contentShape(Rectangle())
        }
        .menuIndicator(.hidden)
        .tint(OpenClawChatTheme.muted)
        .disabled(
            !self.viewModel.composerEffortMutationAvailable ||
                self.viewModel.isUpdatingSessionSettings)
        .disabled(self.viewModel.hasActiveRunForComposerSettings)
        .help(self.cleanInlineEffortDisabledHint ?? self.viewModel.composerInlineEffortLabel)
        .accessibilityLabel("Effort")
        .accessibilityValue(self.viewModel.composerInlineEffortLabel)
        .accessibilityHint(self.cleanInlineEffortDisabledHint ?? "")
        .accessibilityIdentifier("chat-composer-inline-effort")
        #endif
    }

    /// Keep recovery visible when authentication blocks send or capture UI replaces the model menu.
    var showsModelSignInRow: Bool {
        #if os(iOS)
        guard self.composerChrome == .clean else { return true }
        return self.viewModel.composerModelAvailabilityMessage != nil || self.cleanShowsCameraFlip ||
            self.voiceNoteControl?.recorder.isRecording == true
        #else
        !self.usesDesktopModelMenu
        #endif
    }

    private var cleanModelChoicesDisabled: Bool {
        let unavailable = !self.viewModel.composerModelMutationAvailable ||
            self.viewModel.isUpdatingSessionSettings
        #if os(iOS)
        return unavailable || !self.viewModel.showsModelPicker || self.viewModel.hasActiveRunForComposerSettings
        #else
        return unavailable
        #endif
    }

    private var cleanInlineModelDisabledHint: String? {
        #if os(iOS)
        if self.viewModel.hasActiveRunForComposerSettings {
            return String(localized: "Model changes are available after the current response finishes.")
        }
        #endif
        if !self.viewModel.composerModelMutationAvailable {
            return String(localized: "Changing the model requires operator.write or operator.admin access.")
        }
        if self.viewModel.isUpdatingSessionSettings {
            return String(localized: "Saving session settings.")
        }
        return nil
    }

    private var cleanInlineEffortDisabledHint: String? {
        #if os(iOS)
        if self.viewModel.hasActiveRunForComposerSettings {
            return String(localized: "Available after the current response finishes.")
        }
        #endif
        if !self.viewModel.composerEffortMutationAvailable {
            return String(localized: "Thinking and Fast controls require operator.write or operator.admin access.")
        }
        if self.viewModel.isUpdatingSessionSettings {
            return String(localized: "Saving session settings.")
        }
        return nil
    }

    /// Send/Talk observes the draft independently of the expensive model menu.
    var cleanCaptureAndPrimaryControls: some View {
        ChatComposerSection { self.cleanCaptureAndPrimaryContent }
    }

    @ViewBuilder
    private var cleanCaptureAndPrimaryContent: some View {
        #if os(iOS)
        let micWidth: CGFloat? = CleanChatComposerMetrics.glyphControlWidth
        #else
        let micWidth: CGFloat? = nil
        #endif
        let showsTalkMicrophone = self.talkControl?.isEnabled == true &&
            self.talkControl?.toggleMicrophone != nil
        // Live Talk owns its microphone control in the activity strip, not the dictation slot.
        if !showsTalkMicrophone, self.dictationControl != nil || self.voiceNoteControl != nil {
            OpenClawChatMicButton(
                dictationControl: self.dictationControl,
                voiceNoteControl: self.voiceNoteControl,
                isDictationPending: self.dictationTask != nil,
                isRealtimeTalkActive: self.talkControl?.isEnabled == true,
                isComposerEnabled: self.isComposerEnabled,
                isAttachmentInputEnabled: self.isAttachmentInputEnabled,
                controlSize: self.cleanControlHeight,
                controlWidth: micWidth,
                onCancelDictation: {
                    ChatDictationActions.cancel(task: self.$dictationTask, control: self.dictationControl)
                },
                onStartDictation: {
                    if let dictationControl = self.dictationControl {
                        ChatDictationActions.start(
                            dictationControl,
                            task: self.$dictationTask,
                            viewModel: self.viewModel)
                    }
                })
        }

        if let talkControl, self.cleanShowsCameraFlip {
            ChatCameraFlipButton(
                control: talkControl,
                controlHeight: self.cleanControlHeight,
                visualSize: self.cleanIconControlSize)
        }

        self.cleanTrailingControl
    }

    private var cleanShowsCameraFlip: Bool {
        guard let talkControl = self.talkControl else { return false }
        return ChatCameraFlipButton.isAvailable(for: talkControl)
    }
}

#if os(iOS)
/// Lay out the same text view across focus changes so its responder, selection, and draft survive.
private struct CleanComposerPhoneLayout: Layout {
    let expanded: Bool

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache _: inout ()) -> CGSize {
        let width = proposal.width ?? 320
        let frames = self.frames(width: width, subviews: subviews)
        return CGSize(width: width, height: (frames.map(\.maxY).max() ?? 0) + self.trailingInset)
    }

    private var leadingInset: CGFloat {
        self.expanded ? CleanChatComposerMetrics.expandedLeadingControlInset :
            CleanChatComposerMetrics.collapsedControlInset
    }

    /// Also the bottom inset, so the primary disc stays concentric with the corner.
    private var trailingInset: CGFloat {
        self.expanded ? CleanChatComposerMetrics.expandedControlInset :
            CleanChatComposerMetrics.collapsedControlInset
    }

    func placeSubviews(in bounds: CGRect, proposal _: ProposedViewSize, subviews: Subviews, cache _: inout ()) {
        for (view, frame) in zip(subviews, self.frames(width: bounds.width, subviews: subviews)) {
            view.place(
                at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                anchor: .topLeading,
                proposal: ProposedViewSize(frame.size))
        }
    }

    private func frames(width: CGFloat, subviews: Subviews) -> [CGRect] {
        let leadingEdge = self.leadingInset
        let trailingEdge = self.trailingInset
        let gap = CleanChatComposerMetrics.rowGap
        let top = self.expanded ? CleanChatComposerMetrics.expandedEditorTopInset : trailingEdge
        let leading = subviews[1].sizeThatFits(.unspecified)
        let trailingWidth = max(0, width - leadingEdge - trailingEdge - leading.width)
        let trailing = subviews[2].sizeThatFits(ProposedViewSize(
            width: self.expanded ? trailingWidth : nil, height: nil))
        let fieldX = self.expanded ? CleanChatComposerMetrics.editorInlineInset : leadingEdge + leading.width
        let fieldEnd = self.expanded ? width - fieldX : width - trailingEdge - trailing.width - gap
        let fieldWidth = max(0, fieldEnd - fieldX)
        let field = subviews[0].sizeThatFits(ProposedViewSize(width: fieldWidth, height: nil))
        let controlsHeight = max(leading.height, trailing.height)
        let height = self.expanded ? controlsHeight : max(controlsHeight, field.height)
        let controlsY = self.expanded ? top + field.height + CleanChatComposerMetrics.expandedControlsGap : top
        let fieldY = self.expanded ? top : top + (height - field.height) / 2
        return [
            CGRect(x: fieldX, y: fieldY, width: fieldWidth, height: field.height),
            CGRect(
                x: leadingEdge,
                y: controlsY + (height - leading.height) / 2,
                width: leading.width,
                height: leading.height),
            CGRect(
                x: width - trailingEdge - trailing.width,
                y: controlsY + (height - trailing.height) / 2,
                width: trailing.width,
                height: trailing.height),
        ]
    }
}
#endif

struct SlashPanelHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

struct ChatNewSessionSlashOption: View {
    let optionsPresented: Binding<Bool>
    let dismissInput: () -> Void

    var body: some View {
        Divider()
        Button {
            self.optionsPresented.wrappedValue = true
            self.dismissInput()
        } label: {
            Label("New session options…", systemImage: "slider.horizontal.3")
                .font(OpenClawChatTypography.footnoteSemiBold)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .padding(.horizontal, 14)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("chat-new-session-options")
    }
}
