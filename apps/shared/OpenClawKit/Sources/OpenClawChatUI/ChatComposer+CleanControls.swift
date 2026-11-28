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
        // The phone opens the "+" sheet (ChatComposerAddSheet).
        Button {
            self.openAddSheet()
        } label: {
            CompactChatAttachmentLabel()
        }
        .accessibilityLabel("Add")
        .accessibilityIdentifier("chat-attachment-picker")
        .buttonStyle(.plain)
        // The shield beside it and the sheet read the same capabilities.
        .task(id: self.viewModel.composerCapabilityOwnerID) {
            await self.viewModel.loadComposerCapabilities()
        }
        #endif
    }

    #if os(iOS)
    func cleanPhoneEditor(expanded focused: Bool) -> some View {
        ChatComposerPanelExpansion(isFocused: focused) { expanded in
            self.cleanPhoneEditor(expandedLayout: expanded)
        }
    }

    private func cleanPhoneEditor(expandedLayout expanded: Bool) -> some View {
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
            self.cleanInlinePermissionButton
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

    @ViewBuilder
    var cleanTrailingControls: some View {
        #if os(iOS)
        // Larger accessibility text gets its own row; at standard sizes only the name truncates.
        if self.dynamicTypeSize.isAccessibilitySize, !self.cleanShowsCameraFlip {
            self.cleanStackedControls
        } else {
            self.cleanInlineControls(compactModel: false)
        }
        #else
        ViewThatFits(in: .horizontal) {
            self.cleanInlineControls(compactModel: false)
            self.cleanInlineControls(compactModel: true)
        }
        #endif
    }

    #if os(iOS)
    private var cleanStackedControls: some View {
        VStack(alignment: .trailing, spacing: 0) {
            HStack(spacing: 0) {
                self.cleanPhoneModelControls
            }
            // The mic and the primary button come as separate views; keep them on one row.
            HStack(spacing: 0) {
                self.cleanCaptureAndPrimaryControls
            }
        }
    }

    @ViewBuilder
    private var cleanPhoneModelControls: some View {
        // The cold catalog reveals the name and its options together; a cached choice is ready now.
        if !self.viewModel.isWaitingForComposerModelName {
            self.cleanInlineModelPicker(compact: false)
                .frame(maxWidth: .infinity, alignment: .trailing)
            if self.viewModel.composerOffersEffortChoices {
                self.cleanInlineEffortMenu.fixedSize(horizontal: true, vertical: false)
            }
        }
    }
    #endif

    private func cleanInlineControls(compactModel: Bool) -> some View {
        // Each control owns its visual padding and touch target; only the model name can compress.
        HStack(spacing: 0) {
            #if !os(iOS)
            self.cleanContextUsageMenu
            #endif
            // Camera switching only displaces settings in the compact iOS footer.
            #if os(iOS)
            if !self.cleanShowsCameraFlip { self.cleanPhoneModelControls }
            #elseif os(macOS)
            self.cleanInlineModelPicker(compact: compactModel)
            self.cleanInlineEffortMenu
            #else
            if !self.cleanShowsCameraFlip {
                self.cleanInlineModelPicker(compact: compactModel)
                self.cleanInlineEffortMenu.padding(.trailing, -CleanChatComposerMetrics.effortTrailingPadding)
            }
            #endif
            self.cleanCaptureAndPrimaryControls
        }
    }

    @ViewBuilder
    private func cleanInlineModelPicker(compact: Bool) -> some View {
        #if os(iOS)
        ChatComposerPanelButton(panel: .model, isFocused: self.isFocused) {
            self.cleanInlineModelLabel(compact: compact)
        }
        .accessibilityLabel("Model")
        .accessibilityValue(self.viewModel.composerInlineModelLabel)
        .accessibilityHint(self.cleanInlineModelDisabledHint ?? "")
        .accessibilityIdentifier("chat-composer-inline-model")
        #else
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
                .disabled(self.viewModel.composerModelChoicesLocked)
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
        #endif
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
        #elseif os(iOS)
        // Always the name, never an icon: it hugs short names and truncates long ones.
        CleanComposerModelChipLabel(name: self.viewModel.composerInlineModelLabel) {
            self.cleanPhoneMenuChevron
        }
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
        #elseif os(iOS)
        // The phone opens the effort bar over the composer (ChatEffortBar). The chip always opens it; while
        // the bar's controls are locked it says why. A model with nothing to choose has no chip.
        ChatComposerPanelButton(panel: .effort, isFocused: self.isFocused) {
            HStack(spacing: 3) {
                CleanChatEffortGauge(
                    angle: self.viewModel.composerInlineEffortAngle,
                    fastModeEnabled: self.viewModel.fastModeIsEnabled,
                    accentProgress: self.viewModel.thinkingLevel == "ultra",
                    width: CleanChatComposerMetrics.effortGaugeWidth,
                    ink: CleanChatComposerMetrics.footerInk,
                    needleInk: CleanChatComposerMetrics.footerStrongInk)
                self.cleanPhoneMenuChevron
            }
            .foregroundStyle(CleanChatComposerMetrics.footerInk)
            .padding(.leading, 7)
            // Keep the glyphs trailing, but give the gauge its own full hit target before the mic.
            .frame(minWidth: CleanChatComposerMetrics.controlTouchSize, alignment: .trailing)
            .frame(height: self.cleanControlHeight)
            .contentShape(Rectangle())
        }
        // A model with speed options and no levels: the bar shows only Speed, and so does the chip.
        .accessibilityLabel(self.viewModel.showsThinkingPicker ? "Effort" : "Speed")
        .accessibilityValue(self.viewModel.composerPhoneEffortLabel)
        .accessibilityHint(self.cleanInlineEffortDisabledHint ?? "")
        .accessibilityIdentifier("chat-composer-inline-effort")
        #else
        Menu {
            if self.viewModel.showsThinkingPicker {
                self.thinkingPicker
            }
            if self.viewModel.showsFastModeControls {
                self.fastModeToggle
            }
        } label: {
            CleanChatEffortGauge(
                angle: self.viewModel.composerInlineEffortAngle,
                fastModeEnabled: self.viewModel.fastModeIsEnabled,
                accentProgress: self.viewModel.thinkingLevel == "ultra",
                width: 20,
                ink: .secondary,
                needleInk: .secondary)
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

    var modelSignInButton: some View {
        #if os(iOS)
        // The phone signs in on the model sheet's Provider accounts page.
        Button {
            self.composerPanels?.openAccounts()
        } label: {
            Text(self.viewModel.selectedModelUnavailableReason == .authFailed
                ? String(localized: "Sign in again")
                : String(localized: "Sign in"))
                .font(OpenClawChatTypography.caption)
        }
        .accessibilityIdentifier("chat-model-sign-in")
        #else
        Button {
            self.performModelSignInAction(.open)
        } label: {
            HStack(spacing: 6) {
                if self.modelSignInAction == .open {
                    ProgressView().controlSize(.small)
                }
                Text("Model sign-in").font(OpenClawChatTypography.caption)
            }
        }
        .disabled(self.modelSignInAction != nil)
        .accessibilityIdentifier("chat-model-sign-in")
        #endif
    }

    /// Keep recovery visible when authentication blocks send or a voice note replaces the model menu.
    /// Talk hides the model chip too, but a working chat needs no sign-in link under it.
    var showsModelSignInRow: Bool {
        #if os(iOS)
        guard self.composerChrome == .clean else { return true }
        return self.viewModel.composerModelAvailabilityMessage != nil ||
            self.voiceNoteControl?.recorder.isRecording == true
        #else
        !self.usesDesktopModelMenu
        #endif
    }

    private var cleanInlineModelDisabledHint: String? {
        if !self.viewModel.composerModelMutationAvailable {
            #if os(iOS)
            return String(localized: "You don’t have permission to change the model.")
            #else
            return String(localized: "Changing the model requires operator.write or operator.admin access.")
            #endif
        }
        #if !os(iOS)
        // The phone saves in the background and never waits on a save.
        if self.viewModel.isUpdatingSessionSettings {
            return String(localized: "Saving session settings…")
        }
        #endif
        return nil
    }

    private var cleanInlineEffortDisabledHint: String? {
        #if os(iOS)
        // The same words the effort bar shows under its locked controls.
        if let reason = self.viewModel.composerPhoneEffortLockReason {
            return reason
        }
        #else
        if !self.viewModel.composerEffortMutationAvailable {
            return String(localized: "Thinking and Fast controls require operator.write or operator.admin access.")
        }
        if self.viewModel.isUpdatingSessionSettings {
            return String(localized: "Saving session settings…")
        }
        #endif
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
/// The model chip's label: the name and a chevron. The shield's 44 pt target already leaves visible
/// space before the name, so the chip pads only toward the effort gauge. Only the name truncates.
private struct CleanComposerModelChipLabel<Chevron: View>: View {
    let name: String
    @ViewBuilder let chevron: () -> Chevron
    /// Leaves room for an identifiable prefix, the ellipsis and the chevron at the default text size.
    @ScaledMetric(relativeTo: .callout) private var minimumWidth: CGFloat = 64

    var body: some View {
        HStack(spacing: 3) {
            // One point under the other composer labels, so the name sits back next to the draft.
            Text(self.name)
                .font(OpenClawChatTypography.body(size: 15, weight: .medium, relativeTo: .callout))
                .lineLimit(1)
                .truncationMode(.tail)
            self.chevron().fixedSize()
        }
        .foregroundStyle(CleanChatComposerMetrics.footerInk)
        .padding(.trailing, 1)
        .frame(minWidth: self.minimumWidth, minHeight: CleanChatComposerMetrics.controlTouchSize)
        .contentShape(Rectangle())
    }
}

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
        for (index, frame) in self.frames(width: bounds.width, subviews: subviews).enumerated() {
            // The right-hand controls stay pinned while the model label changes intrinsic width.
            let trailing = index == 2
            subviews[index].place(
                at: CGPoint(x: bounds.minX + (trailing ? frame.maxX : frame.minX), y: bounds.minY + frame.minY),
                anchor: trailing ? .topTrailing : .topLeading,
                proposal: ProposedViewSize(frame.size))
        }
    }

    private func frames(width: CGFloat, subviews: Subviews) -> [CGRect] {
        let leadingEdge = self.leadingInset
        let trailingEdge = self.trailingInset
        let gap = CleanChatComposerMetrics.rowGap
        let top = self.expanded ? CleanChatComposerMetrics.expandedEditorTopInset : trailingEdge
        let leading = subviews[1].sizeThatFits(.unspecified)
        // The label can truncate up to the shield's target, never into it.
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
                // Open, the leading controls sit on the bottom row when the trailing ones wrap to two.
                y: controlsY + (self.expanded ? height - leading.height : (height - leading.height) / 2),
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
