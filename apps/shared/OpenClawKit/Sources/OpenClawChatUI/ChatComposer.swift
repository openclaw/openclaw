import CoreTransferable
import Foundation
import Observation
import SwiftUI
import UniformTypeIdentifiers

#if os(macOS)
import AppKit
#endif

#if !os(macOS)
import PhotosUI
#if canImport(UIKit)
import UIKit

/// The camera hands us an immutable snapshot, but UIKit does not expose it as
/// Sendable. This wrapper is only used for one detached JPEG encoding pass.
private struct OpenClawSendableCameraImage: @unchecked Sendable {
    let value: UIImage
}
#endif
#endif

@MainActor
struct OpenClawChatAttachmentCaptureOwner {
    let viewModel: OpenClawChatViewModel
    let session: OpenClawChatViewModel.SessionSnapshot

    init(viewModel: OpenClawChatViewModel) {
        self.viewModel = viewModel
        self.session = viewModel.currentSessionSnapshot()
    }

    func addAttachments(urls: [URL]) {
        self.viewModel.addAttachments(urls: urls, for: self.session)
    }
}

/// Evaluates part of the composer in its own body. Debug builds keep every nested `some View` temporary on
/// the stack, and the whole composer evaluated in one body nearly fills the 1 MB main-thread stack of a device.
struct ChatComposerSection<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        self.content()
    }
}

struct OpenClawChatComposerPresentationOwner: Equatable {
    let viewModelID: ObjectIdentifier
    let session: OpenClawChatViewModel.SessionSnapshot

    @MainActor
    init(viewModel: OpenClawChatViewModel) {
        self.viewModelID = ObjectIdentifier(viewModel)
        self.session = viewModel.currentSessionSnapshot()
    }
}

@MainActor
struct OpenClawChatComposer: View {
    enum ModelSignInAction {
        case open
        case refresh
    }

    private struct ModelSignInRequest {
        let id = UUID()
        let action: ModelSignInAction
    }

    @Environment(\.openClawChatDesktopLayout) private var isDesktopLayout
    #if os(iOS)
    @Environment(\.openClawChatNewSessionOptionsPresented) private var newSessionOptionsPresented
    #endif
    @Environment(\.dynamicTypeSize) var dynamicTypeSize
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var colorSchemeContrast
    @Bindable var viewModel: OpenClawChatViewModel
    let style: OpenClawChatView.Style
    let showsSessionSwitcher: Bool
    let userAccent: Color?
    let composerChrome: OpenClawChatView.ComposerChrome
    let isComposerEnabled: Bool
    let isAttachmentInputEnabled: Bool
    let messagePlaceholder: String?
    var compactMessagePlaceholder: String?
    let talkControl: OpenClawChatTalkControl?
    let dictationControl: OpenClawChatDictationControl?
    let voiceNoteControl: OpenClawChatVoiceNoteControl?
    var focusRequest = 0
    var resolveInputModel: (@MainActor () -> OpenClawChatViewModel?)?

    @State private var isSlashPopoverPresented = false
    @State private var suppressNextSlashPopoverUpdate = false
    @State private var slashPanelHeight: CGFloat = 0
    @State private var slashRowsHeight: CGFloat = 0
    @Environment(ChatTranscriptRoom.self) private var transcriptRoom: ChatTranscriptRoom?
    @State private var slashHighlightIndex = 0
    @State var dictationTask: Task<Void, Never>?
    /// Set on the tap that sends a message expecting a reply; see `ChatComposerPrimaryButton.swift`.
    @State var primaryReplyMark: UUID?
    @State private var signInContext: OpenClawChatModelSignInContext?
    @State private var modelSignInRequest: ModelSignInRequest?
    @State private var modelSignInTask: Task<Void, Never>?
    #if !os(macOS)
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var showsPhotoPicker = false
    @State private var showsFileImporter = false
    @State private var showsCameraPicker = false
    @State private var photoPickerOwner: OpenClawChatAttachmentCaptureOwner?
    @State private var fileImporterOwner: OpenClawChatAttachmentCaptureOwner?
    #if canImport(UIKit)
    @State private var cameraEncodingTask: Task<Void, Never>?
    @State private var cameraCaptureOwner: OpenClawChatAttachmentCaptureOwner?
    #endif
    #if os(iOS)
    /// UIKit owns first responder; its bridge needs stored state, not an unbound SwiftUI FocusState.
    @State var isFocused = false
    @Environment(\.isEnabled) var interactionEnabled
    @Environment(\.openClawChatComposerPanels) var composerPanels
    @State var showsPermissionsSheet = false
    @State var showsAddSheet = false
    /// What runs once the "+" sheet is gone: a picker, or the keyboard after a skill went into the draft.
    @State var addSheetFollowUp: ChatComposerAddFollowUp?
    /// The draft had the keyboard when the "+" sheet opened; it gets it back once the sheet, or the picker
    /// it opened, closes.
    @State var addSheetReturnsFocus = false
    @State var pickedAttachmentFocusIDs: Set<UUID> = []
    /// Text or an attachment tile keeps the composer open when the keyboard goes down; only an empty
    /// composer closes to one row.
    @State var hasComposerContent = false
    #else
    @FocusState private var isFocused: Bool
    #endif
    #else
    @State private var shouldFocusTextView = false
    #endif
    @ScaledMetric(relativeTo: .body) private var scaledBodyLineHeight: CGFloat = 22

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if self.usesDesktopModelMenu,
               let message = self.viewModel.composerModelAvailabilityMessage
            {
                HStack(alignment: .center, spacing: 10) {
                    Image(systemName: "key.fill")
                        .foregroundStyle(OpenClawChatTheme.warning)
                        .accessibilityHidden(true)
                    Text(message)
                        .font(OpenClawChatTypography.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                        .help(message)
                    Spacer(minLength: 0)
                    self.modelSignInButton
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .fixedSize()
                    Button {
                        self.performModelSignInAction(.refresh)
                    } label: {
                        if self.modelSignInAction == .refresh {
                            ProgressView().controlSize(.small)
                        } else {
                            Text("Retry").font(OpenClawChatTypography.caption)
                        }
                    }
                    .buttonStyle(.borderless)
                    .disabled(self.modelSignInAction != nil)
                    .accessibilityLabel("Retry")
                    .accessibilityIdentifier("chat-composer-retry-model-sign-in")
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("chat-composer-model-sign-in-notice")
            }
            self.viewModel.composerNotice.map(ChatComposerRestoredNotice.init)
            #if os(iOS)
            if let optionsPresented = self.newSessionCommandOptions {
                ChatNewSessionSlashOption(optionsPresented: optionsPresented) { self.isFocused = false }
            }
            #endif
            self.lifecycleComposer
            if self.viewModel.modelCatalogMessage != nil || self.showsModelSignInRow {
                HStack {
                    if let message = self.viewModel.modelCatalogMessage {
                        Text(message).font(OpenClawChatTypography.caption)
                    }
                    Spacer()
                    if self.showsModelSignInRow {
                        self.modelSignInButton
                    }
                }
                .foregroundStyle(.secondary)
            }
        }
        #if os(macOS)
        .sheet(isPresented: Binding(
                get: { self.signInContext != nil },
                set: {
                    if !$0 {
                        self.signInContext = nil
                    }
                })) {
                    if let context = self.signInContext {
                        OpenClawChatModelSignInSheet(context: context) { await self.viewModel.refreshModelSignIn() }
                    }
            }
        #endif
        #if os(iOS)
        // Presented from here, not from the shield: the shield leaves the hierarchy while capabilities reload.
            .chatComposerPermissionsSheet(isPresented: self.$showsPermissionsSheet, viewModel: self.viewModel)
        .modifier(ChatNewDraftFocus(composer: self))
        .sheet(isPresented: self.$showsAddSheet, onDismiss: self.addSheetDidDismiss) {
            ChatComposerAddSheet(
                viewModel: self.viewModel,
                isAttachmentInputEnabled: self.isAttachmentInputEnabled,
                onAttachPhotos: { assets in
                    guard self.isAttachmentInputEnabled, !assets.isEmpty else { return }
                    self.viewModel.addRecentPhotos(
                        assets,
                        owner: OpenClawChatAttachmentCaptureOwner(viewModel: self.viewModel))
                },
                onClose: self.closeAddSheet)
        }
        // A picker counts as gone once it starts to leave, so the keyboard is asked for then, not after its tile
        // is ready.
        .modifier(ChatPickerAttachmentFocus(
            composer: self,
            pickerPresented: self.showsPhotoPicker || self.showsFileImporter || self.showsCameraPicker))
        #endif
        .onChange(of: self.presentationOwner) { _, _ in
            self.invalidateModelSignIn()
        }
        .onDisappear { self.invalidateModelSignIn() }
    }

    var usesDesktopModelMenu: Bool {
        #if os(macOS)
        self.isDesktopLayout && self.composerChrome == .clean
        #else
        false
        #endif
    }

    func performModelSignInAction(_ action: ModelSignInAction) {
        guard self.modelSignInAction == nil else { return }
        let owner = self.presentationOwner
        let request = ModelSignInRequest(action: action)
        self.modelSignInRequest = request
        self.modelSignInTask = Task {
            defer {
                if self.modelSignInRequest?.id == request.id {
                    self.modelSignInRequest = nil
                    self.modelSignInTask = nil
                }
            }
            guard !Task.isCancelled,
                  self.modelSignInRequest?.id == request.id,
                  self.presentationOwner == owner
            else { return }
            switch action {
            case .open:
                let context = await self.viewModel.modelSignInContext()
                guard !Task.isCancelled,
                      self.modelSignInRequest?.id == request.id,
                      self.presentationOwner == owner
                else { return }
                self.signInContext = context
            case .refresh:
                await self.viewModel.refreshModelSignIn()
            }
        }
    }

    var modelSignInAction: ModelSignInAction? {
        self.modelSignInRequest?.action
    }

    private func invalidateModelSignIn() {
        self.modelSignInRequest = nil
        self.modelSignInTask?.cancel()
        self.modelSignInTask = nil
        self.signInContext = nil
    }

    private var styledComposer: some View {
        ChatComposerSection { self.composerContent }
            .padding(composerPadding)
            .background { self.composerBackground }
    }

    #if os(macOS)
    private var platformComposer: some View {
        self.styledComposer
            .onDrop(of: [.fileURL], isTargeted: nil) { providers in
                self.handleDrop(providers)
            }
            .onAppear {
                self.shouldFocusTextView = true
                self.viewModel.loadSlashCommandsIfNeeded()
            }
            .onChange(of: self.focusRequest) { _, _ in
                self.shouldFocusTextView = true
            }
    }
    #else
    private var platformComposer: some View {
        self.styledComposer
            .onChange(of: self.focusRequest) { _, _ in self.isFocused = true }
            .onChange(of: self.isComposerEnabled) { _, isEnabled in
                if !isEnabled {
                    self.isFocused = false
                    self.setSlashPanelPresented(false)
                }
            }
            .onChange(of: self.isAttachmentInputEnabled) { _, isEnabled in
                if !isEnabled {
                    // The "+" sheet turns its own attachment rows off. Closing it here let a reconnect after
                    // the app came back close the sheet by itself.
                    self.dismissAttachmentCapture(keepingAddSheet: true)
                }
            }
            .onAppear {
                self.viewModel.loadSlashCommandsIfNeeded()
            }
            .fileImporter(
                isPresented: self.fileImporterPresentation,
                allowedContentTypes: OpenClawChatPickerAttachmentMetadata.allowedFileContentTypes,
                allowsMultipleSelection: true,
                onCompletion: { result in
                    let owner = self.fileImporterOwner
                    self.fileImporterOwner = nil
                    self.stagePickerSelection { self.handleFileImport(result, owner: owner) }
                })
            .photosPicker(
                isPresented: self.photoPickerPresentation,
                selection: self.$pickerItems,
                maxSelectionCount: 8,
                matching: .any(of: [.images, .videos]))
            .onChange(of: self.pickerItems) { _, items in
                guard !items.isEmpty else { return }
                let owner = self.photoPickerOwner
                self.photoPickerOwner = nil
                self.stagePickerSelection { self.stagePhotosPickerItems(items, owner: owner) }
            }
            #if canImport(UIKit)
            .fullScreenCover(
                isPresented: self.cameraPickerPresentation,
                onDismiss: {
                    self.cameraCaptureOwner = nil
                    self.returnFocusAfterAddSheet()
                },
                content: {
                    let owner = self.cameraCaptureOwner
                    OpenClawChatCameraPicker { image in
                        guard let owner else { return }
                        self.stagePickerSelection { self.addCameraImage(image, owner: owner) }
                    }
                    .ignoresSafeArea()
                })
            #endif
    }
    #endif

    private var recorderLifecycleComposer: some View {
        self.platformComposer
            .onChange(of: self.voiceNoteControl?.recorder.completedRecording) { _, recording in
                guard recording != nil else { return }
                self.stageCompletedVoiceNoteIfNeeded()
            }
            .onChange(of: self.voiceNoteControl?.recorder.ownsPendingChatAttachment) { _, _ in
                self.viewModel.attachmentOwnerActivityChanged()
            }
            .onChange(of: self.voiceNoteControl?.recorder.errorMessage) { _, message in
                if let message {
                    self.viewModel.errorText = message
                }
            }
    }

    private var lifecycleComposer: some View {
        self.recorderLifecycleComposer
            .onChange(of: ObjectIdentifier(self.viewModel)) { _, _ in
                self.viewModel.loadSlashCommandsIfNeeded()
            }
            .onChange(of: self.presentationOwner) { _, _ in
                ChatDictationActions.cancel(task: self.$dictationTask, control: self.dictationControl)
                #if !os(macOS)
                self.dismissAttachmentCapture()
                #endif
            }
            .onAppear {
                self.viewModel.attachmentOwnerActivityChanged()
                self.stageCompletedVoiceNoteIfNeeded()
            }
            .onDisappear {
                ChatDictationActions.cancel(task: self.$dictationTask, control: self.dictationControl)
                #if !os(macOS)
                self.dismissAttachmentCapture()
                #endif
                self.cancelActiveVoiceNoteIfNeeded()
                self.viewModel.attachmentOwnerActivityChanged()
            }
    }

    private var composerContent: some View {
        VStack(alignment: .leading, spacing: 4) {
            if self.composerChrome == .clean {
                self.cleanComposerCard
            } else {
                if self.style == .standard, self.voiceNoteControl?.recorder.isRecording != true {
                    self.composerToolbar
                }

                if self.showsAttachmentsStrip {
                    self.attachmentsStrip
                }

                self.composerContextRows

                if let voiceNoteControl, voiceNoteControl.recorder.isRecording {
                    OpenClawVoiceNoteRecordingRow(recorder: voiceNoteControl.recorder)
                        .padding(self.composerPadding)
                } else {
                    self.editor
                }
            }
        }
    }

    @ViewBuilder
    private var composerContextRows: some View {
        if let replyTarget = viewModel.replyTarget {
            ChatReplyPreview(target: replyTarget) {
                self.inputModel?.clearReplyTarget()
            }
        }

        #if !os(iOS)
        // The phone composer becomes the Talk surface itself (ChatTalkComposerRow).
        if let talkControl, talkControl.isEnabled {
            ChatTalkActivityStrip(control: talkControl)
        }
        #endif

        if let dictationControl, dictationTask != nil || dictationControl.isActive {
            ChatDictationActivityRow(
                control: dictationControl,
                onCancel: {
                    ChatDictationActions.cancel(task: self.$dictationTask, control: dictationControl)
                })
        }

        if self.composerChrome == .clean {
            composerCapabilityNoticeRow
        }
    }

    private var presentationOwner: OpenClawChatComposerPresentationOwner {
        OpenClawChatComposerPresentationOwner(viewModel: self.viewModel)
    }

    #if !os(macOS)
    var photoPickerPresentation: Binding<Bool> {
        Binding(
            get: { self.showsPhotoPicker },
            set: { isPresented in
                if isPresented {
                    self.photoPickerOwner = OpenClawChatAttachmentCaptureOwner(viewModel: self.viewModel)
                }
                self.showsPhotoPicker = isPresented
                if !isPresented { self.returnFocusAfterAddSheet() }
            })
    }

    var fileImporterPresentation: Binding<Bool> {
        Binding(
            get: { self.showsFileImporter },
            set: { isPresented in
                if isPresented {
                    self.fileImporterOwner = OpenClawChatAttachmentCaptureOwner(viewModel: self.viewModel)
                }
                self.showsFileImporter = isPresented
                if !isPresented { self.returnFocusAfterAddSheet() }
            })
    }

    var cameraPickerPresentation: Binding<Bool> {
        Binding(
            get: { self.showsCameraPicker },
            set: { isPresented in
                #if canImport(UIKit)
                if isPresented {
                    self.cameraCaptureOwner = OpenClawChatAttachmentCaptureOwner(viewModel: self.viewModel)
                }
                #endif
                self.showsCameraPicker = isPresented
            })
    }
    #endif

    @ViewBuilder
    private var composerBackground: some View {
        if self.composerChrome == .full {
            let cornerRadius: CGFloat = 18

            #if os(macOS)
            if self.style == .standard {
                let shape = UnevenRoundedRectangle(
                    cornerRadii: RectangleCornerRadii(
                        topLeading: 0,
                        bottomLeading: cornerRadius,
                        bottomTrailing: cornerRadius,
                        topTrailing: 0),
                    style: .continuous)
                shape
                    .fill(OpenClawChatTheme.composerBackground)
                    .overlay(shape.strokeBorder(OpenClawChatTheme.composerBorder, lineWidth: 1))
                    .shadow(color: .black.opacity(0.12), radius: 12, y: 6)
            } else {
                let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                shape
                    .fill(OpenClawChatTheme.composerBackground)
                    .overlay(shape.strokeBorder(OpenClawChatTheme.composerBorder, lineWidth: 1))
                    .shadow(color: .black.opacity(0.12), radius: 12, y: 6)
            }
            #else
            let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            shape
                .fill(OpenClawChatTheme.composerBackground)
                .overlay(shape.strokeBorder(OpenClawChatTheme.composerBorder, lineWidth: 1))
                .shadow(color: .black.opacity(0.12), radius: 12, y: 6)
            #endif
        }
    }

    private var composerToolbar: some View {
        HStack(spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 5) {
                    if self.viewModel.sessionBranches.count > 1 {
                        self.branchMenu
                    }
                    if self.showsSessionSwitcher {
                        self.sessionPicker
                        if self.viewModel.showsThinkingPicker {
                            self.thinkingPicker.labelsHidden()
                        }
                        #if os(macOS)
                        self.verbosityPicker.labelsHidden()
                        if self.viewModel.showsFastModeControls {
                            self.fastModeToggle.labelsHidden()
                        }
                        #endif
                    }
                    if self.viewModel.showsModelPicker {
                        self.modelPicker
                        if self.viewModel.modelSelectionID != OpenClawChatViewModel.defaultModelSelectionID {
                            self.modelPinButton
                        }
                    }
                }
            }

            Spacer(minLength: 4)

            if let fraction = self.viewModel.contextUsageFraction {
                self.contextUsageIndicator(fraction)
            }

            if self.style == .standard {
                self.refreshButton
                self.attachmentPicker
                if let voiceNoteControl, !voiceNoteControl.isTalkActive {
                    OpenClawVoiceNoteButton(
                        control: voiceNoteControl,
                        isComposerEnabled: self.isComposerEnabled,
                        isAttachmentInputEnabled: self.isAttachmentInputEnabled)
                }
            }
        }
        .padding(.horizontal, 10)
    }

    private func contextUsageIndicator(_ fraction: Double) -> some View {
        let percentage = Int((fraction * 100).rounded())
        let color = fraction >= 0.8 ? OpenClawChatTheme.warning : OpenClawChatTheme.muted
        return ZStack {
            Circle()
                .stroke(OpenClawChatTheme.muted.opacity(0.2), lineWidth: 2)
            Circle()
                .trim(from: 0, to: fraction)
                .stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }
        .frame(width: 14, height: 14)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            String(
                format: String(localized: "Context %@%% used"),
                percentage.formatted()))
    }

    var attachmentPicker: some View {
        Button {
            #if os(macOS)
            self.pickFilesMac()
            #else
            self.photoPickerPresentation.wrappedValue = true
            #endif
        } label: {
            Image(systemName: "paperclip")
        }
        .accessibilityLabel("Attachments")
        .buttonStyle(.bordered)
        .controlSize(.small)
        .disabled(!self.isAttachmentInputEnabled)
    }

    private var attachmentsStrip: some View {
        OpenClawChatAttachmentsStrip(
            attachments: self.viewModel.composerAttachments,
            preparing: self.viewModel.composerPreparingAttachments,
            onRemove: { self.viewModel.removeAttachment($0) })
    }

    private var newSessionCommandOptions: Binding<Bool>? {
        #if os(iOS)
        if self.isFocused, self.slashQuery?.lowercased() == "new" {
            return self.newSessionOptionsPresented
        }
        #endif
        return nil
    }

    private var showsAttachmentsStrip: Bool {
        self.style == .standard
            && (!self.viewModel.composerAttachments.isEmpty || !self.viewModel.composerPreparingAttachments.isEmpty)
    }

    private var editor: some View {
        ChatComposerSection { self.editorContent }
            .overlay(alignment: .top) {
                if self.isSlashPopoverPresented, self.newSessionCommandOptions == nil {
                    self.slashCommandPanel
                        .background(
                            GeometryReader { geo in
                                Color.clear.preference(
                                    key: SlashPanelHeightKey.self,
                                    value: geo.size.height)
                            })
                        .offset(y: -(self.slashPanelHeight + 8))
                        .transition(.opacity)
                }
            }
            .onPreferenceChange(SlashPanelHeightKey.self) { newHeight in
                self.slashPanelHeight = newHeight
            }
    }

    @ViewBuilder
    private var editorContent: some View {
        if self.composerChrome == .clean {
            self.cleanEditor
        } else {
            self.fullEditor
        }
    }

    private var fullEditor: some View {
        VStack(alignment: .leading, spacing: 8) {
            self.editorOverlay

            Rectangle()
                .fill(OpenClawChatTheme.divider)
                .frame(height: 1)
                .padding(.horizontal, 2)

            HStack(alignment: .center, spacing: 8) {
                if let talkControl {
                    ChatTalkButton(
                        control: talkControl,
                        sessionKey: self.viewModel.sessionKey,
                        helpText: self.talkHelpText(talkControl),
                        style: .full)
                    if ChatCameraFlipButton.isAvailable(for: talkControl) {
                        ChatCameraFlipButton(
                            control: talkControl,
                            controlHeight: 32,
                            visualSize: 32)
                    }
                }
                if self.style == .standard {
                    ChatConnectionPill(
                        isConnected: self.viewModel.healthOK || (self.talkControl?.isGatewayConnected ?? false))
                }
                Spacer(minLength: 0)
                self.sendButton
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(OpenClawChatTheme.composerField)
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(OpenClawChatTheme.composerBorder)))
        .padding(composerPadding)
    }

    private var cleanComposerCard: some View {
        self.cleanComposerCardContent
            .modifier(CleanChatComposerSurface(cornerRadius: cleanCornerRadius, usesSystemGlassEdge: true))
            .modifier(ChatComposerPanelBridge(composer: self))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("chat-composer-surface")
    }

    #if !os(iOS)
    private var cleanComposerCardContent: some View {
        self.cleanComposerDraft
            .padding(.horizontal, self.isDesktopLayout ? 0 : 6)
            .padding(.vertical, self.isDesktopLayout ? 0 : 2)
    }
    #endif

    /// The draft and everything attached to it; on iPhone Talk holds it (ChatTalkComposerRow.swift).
    var cleanComposerDraft: some View {
        VStack(alignment: .leading, spacing: 8) {
            #if os(iOS)
            // As in the Control UI, notices come first and the attachments sit straight on the draft.
            self.composerContextRows
                .padding(.horizontal, CleanChatComposerMetrics.footerInlineInset)
            #endif

            VStack(alignment: .leading, spacing: OpenClawChatAttachmentsStrip.spacingToDraft) {
                if self.showsAttachmentsStrip {
                    self.attachmentsStrip
                }

                #if !os(iOS)
                self.composerContextRows
                #endif

                if let voiceNoteControl, voiceNoteControl.recorder.isRecording {
                    OpenClawVoiceNoteRecordingRow(
                        recorder: voiceNoteControl.recorder,
                        embedded: true)
                        #if os(iOS)
                            .padding(.horizontal, CleanChatComposerMetrics.footerInlineInset)
                            .padding(.vertical, CleanChatComposerMetrics.footerBlockInset)
                        #endif
                } else {
                    self.editor
                }
            }
        }
    }

    @ViewBuilder
    private var cleanEditor: some View {
        #if os(iOS)
        self.cleanPhoneEditor(expanded: self.isFocused || self.hasComposerContent)
            .background {
                // Read the draft in its own section so typing does not re-evaluate the whole composer.
                ChatComposerSection {
                    Color.clear.onChange(
                        of: self.viewModel.hasDraftToSend || !self.viewModel.composerPreparingAttachments.isEmpty,
                        initial: true) { self.hasComposerContent = $1 }
                }
            }
        #elseif os(macOS)
        if self.isDesktopLayout {
            self.desktopEditor
        } else {
            self.compactEditor
        }
        #else
        self.compactEditor
        #endif
    }

    #if os(macOS)
    private var desktopEditor: some View {
        VStack(alignment: .leading, spacing: 0) {
            self.editorOverlay
                .padding(.horizontal, CleanChatComposerMetrics.editorInlineInset)
                .padding(.top, 4)

            HStack(alignment: .center, spacing: 0) {
                self.cleanLeadingControls
                Spacer(minLength: 0)
                self.cleanTrailingControls
            }
            // Native borderless menus discard the custom context ring and effort dial.
            .menuStyle(.button)
            .buttonStyle(.plain)
            .padding(.horizontal, CleanChatComposerMetrics.footerInlineInset)
            .padding(.bottom, 2)
        }
    }
    #endif

    func talkHelpText(_ talkControl: OpenClawChatTalkControl) -> String {
        if !talkControl.isGatewayConnected, !talkControl.isEnabled {
            return "Connect the gateway before starting realtime chat"
        }
        let action = talkControl.isEnabled ? "Stop" : "Start"
        return "\(action) realtime chat for \(self.activeSessionLabel)"
    }

    private var activeSessionLabel: String {
        let match = self.viewModel.sessions.first { $0.key == self.viewModel.sessionKey }
        let trimmed = match?.displayName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? self.viewModel.sessionKey : trimmed
    }

    /// Track draft observation in the editor, not the model-menu/composer body.
    var editorOverlay: some View {
        ChatComposerSection { self.editorOverlayContent }
    }

    private var editorOverlayContent: some View {
        ZStack(alignment: editorOverlayAlignment) {
            #if !os(macOS)
            if self.viewModel.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                ChatComposerPlaceholder(text: self.placeholderText, compactText: self.compactMessagePlaceholder)
                    .padding(.horizontal, self.cleanFieldTextInset)
                    .padding(.vertical, self.composerChrome == .clean ? 0 : 4)
            }
            #endif

            #if os(macOS)
            ChatComposerTextView(
                text: self.inputText,
                shouldFocus: self.$shouldFocusTextView,
                isEnabled: self.isComposerEnabled,
                placeholder: self.placeholderText,
                textColor: self.isDesktopLayout
                    ? NSColor(OpenClawChatTheme.desktopText(in: self.colorScheme, contrast: self.colorSchemeContrast))
                    : .textColor,
                minHeight: self.textMinHeight,
                maxHeight: self.textMaxHeight,
                onSend: {
                    self.sendDraftIfEnabled()
                },
                onPasteImageAttachment: { data, fileName, mimeType in
                    guard self.isAttachmentInputEnabled else { return }
                    self.viewModel.addImageAttachment(data: data, fileName: fileName, mimeType: mimeType)
                },
                onPasteFiles: { urls in
                    guard self.isAttachmentInputEnabled else { return }
                    self.viewModel.addAttachments(urls: urls)
                },
                onKeyCommand: { command, context in
                    self.handleComposerKeyCommand(command, context: context)
                })
                .padding(.horizontal, 4)
                .padding(.vertical, self.usesDesktopModelMenu ? 0 : 3)
                .onChange(of: self.viewModel.input) { _, _ in
                    self.updateSlashPopoverPresentation()
                }
            #elseif os(iOS)
            ChatComposerTextViewIOS(
                text: self.inputText,
                focusRequested: self.isFocused,
                isEnabled: self.isComposerEnabled,
                // Clean: as tall as its lines, so it centers like the placeholder; the editor frame sets the target.
                minHeight: self.composerChrome == .clean ? 0 : self.textMinHeight,
                maxHeight: self.textMaxHeight,
                onFocusChange: { focused in
                    self.isFocused = focused
                },
                onHistoryUp: {
                    !self.isSlashPopoverPresented && self.inputModel?.recallPreviousInput(caretOnFirstLine: $0) == true
                },
                onHistoryDown: { !self.isSlashPopoverPresented && self.inputModel?.recallNextInput() == true },
                onPasteImageAttachment: self.isAttachmentInputEnabled
                    ? { self.viewModel.addImageAttachment(data: $0, fileName: $1, mimeType: $2) }
                    : nil)
                .padding(.horizontal, self.cleanFieldTextInset)
                .padding(.vertical, self.composerChrome == .clean ? 0 : 6)
                .onChange(of: self.viewModel.input) { _, _ in
                    self.updateSlashPopoverPresentation()
                }
                .onChange(of: self.isFocused) { _, focused in
                    if focused {
                        self.updateSlashPopoverPresentation()
                    } else {
                        self.setSlashPanelPresented(false)
                    }
                }
            #else
            TextField(
                "",
                text: self.inputText,
                axis: .vertical)
                .font(OpenClawChatTypography.body)
                .textFieldStyle(.plain)
                .lineLimit(1...4)
                .fixedSize(horizontal: false, vertical: true)
                // iMessage-style: return inserts a newline; sending is the
                // circle button's job, so keep the standard return key.
                .submitLabel(.return)
                .padding(.horizontal, self.cleanFieldTextInset)
                .padding(.vertical, self.composerChrome == .clean ? 0 : 6)
                .focused(self.$isFocused)
                .disabled(!self.isComposerEnabled)
                .accessibilityIdentifier("chat-message-input")
                .onChange(of: self.viewModel.input) { _, _ in
                    self.updateSlashPopoverPresentation()
                }
                .onChange(of: self.isFocused) { _, focused in
                    if focused {
                        self.updateSlashPopoverPresentation()
                    } else {
                        self.setSlashPanelPresented(false)
                    }
                }
                // SwiftUI exposes neither the caret row nor soft-wrap geometry.
                // Start recall only from an empty draft; an active recall can
                // still walk both directions through the shared state machine.
                .onKeyPress(.upArrow) {
                    guard !self.isSlashPopoverPresented else { return .ignored }
                    return self.inputModel?.recallPreviousInput(caretOnFirstLine: false) == true
                        ? .handled
                        : .ignored
                }
                .onKeyPress(.downArrow) {
                    guard !self.isSlashPopoverPresented else { return .ignored }
                    return self.inputModel?.recallNextInput() == true ? .handled : .ignored
                }
            #endif
        }
    }
}

extension OpenClawChatComposer {
    private var slashQuery: String? {
        Self.slashQuery(forDraft: inputModel?.input ?? "")
    }

    /// The command name being typed, or nil when the panel has nothing to complete. As in the Control UI, a space
    /// after the name ends completion: "/release " is a command with its arguments next, not a search. "/skill"
    /// keeps the panel while its one argument, the skill's name, is typed.
    nonisolated static func slashQuery(forDraft draft: String) -> String? {
        let text = draft.drop(while: \.isWhitespace)
        guard text.hasPrefix("/"), !text.hasPrefix("//") else { return nil }
        let body = String(text.dropFirst())
        let lower = body.lowercased()
        if lower.hasPrefix("skill "), !lower.dropFirst("skill ".count).contains(where: \.isWhitespace) {
            return body
        }
        return body.contains(where: \.isWhitespace) ? nil : body
    }

    var slashCommandPanel: some View {
        // Query and catalog reads belong to the panel body, not the surrounding composer.
        ChatComposerSection {
            let query = self.slashQuery ?? ""
            let matches = self.viewModel.slashCommandMatches(query: query, filter: .all)
            // As tall as its rows, up to the space above the composer; the rows scroll beyond that.
            let room = self.transcriptRoom?.height ?? 0
            let rowsLimit = room > 0 ? max(room - 16, 60) : 340
            VStack(alignment: .leading, spacing: 0) {
                if self.viewModel.isLoadingSlashCommands, self.viewModel.slashCommands.isEmpty {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Loading commands")
                            .font(OpenClawChatTypography.caption)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, minHeight: 96)
                } else if let error = self.viewModel.slashCommandsErrorText,
                          self.viewModel.slashCommands.isEmpty
                {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Commands unavailable")
                            .font(OpenClawChatTypography.footnoteSemiBold)
                        Text(error)
                            .font(OpenClawChatTypography.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(3)
                        Button {
                            self.viewModel.refreshSlashCommands()
                        } label: {
                            Text("Retry")
                                .font(OpenClawChatTypography.captionSemiBold)
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                    }
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                } else if matches.isEmpty {
                    Text("No matching commands")
                        .font(OpenClawChatTypography.caption)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, minHeight: 96)
                } else {
                    ScrollViewReader { proxy in
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 2) {
                                ForEach(Array(matches.enumerated()), id: \.element.id) { index, command in
                                    Button {
                                        self.selectSlashCommand(command)
                                    } label: {
                                        self.slashCommandRow(
                                            command,
                                            isHighlighted: self.usesSlashKeyboardHighlight
                                                && index == self.slashHighlightIndex)
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityLabel(command.displayInvocation)
                                    .id(index)
                                    .onHover { hovering in
                                        if hovering {
                                            self.slashHighlightIndex = index
                                        }
                                    }
                                }
                            }
                            .padding(8)
                        }
                        .onChange(of: self.slashHighlightIndex) { _, index in
                            proxy.scrollTo(index)
                        }
                        .onScrollGeometryChange(for: CGFloat.self) { $0.contentSize.height } action: { _, height in
                            self.slashRowsHeight = height
                        }
                    }
                    .frame(height: min(self.slashRowsHeight > 0 ? self.slashRowsHeight : rowsLimit, rowsLimit))
                    .overlay(alignment: .bottom) {
                        if self.slashRowsHeight > rowsLimit {
                            self.slashCommandScrollAffordance
                        }
                    }
                }
            }
            .background(
                .regularMaterial,
                in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(Color.secondary.opacity(0.15), lineWidth: 0.5))
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .shadow(color: .black.opacity(0.12), radius: 12, y: 4)
        }
    }

    private func slashCommandRow(
        _ command: OpenClawChatCommandChoice,
        isHighlighted: Bool) -> some View
    {
        HStack(alignment: .top, spacing: 0) {
            VStack(alignment: .leading, spacing: 3) {
                Text(command.displayInvocation)
                    .font(OpenClawChatTypography.mono(
                        size: 15,
                        weight: .semibold,
                        relativeTo: .subheadline))
                    .lineLimit(1)
                if !command.description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text(command.description)
                        .font(OpenClawChatTypography.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 8)
        .contentShape(Rectangle())
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(isHighlighted ? AnyShapeStyle(.selection) : AnyShapeStyle(.clear)))
    }

    private var slashCommandScrollAffordance: some View {
        VStack(spacing: 0) {
            Rectangle()
                .fill(.regularMaterial)
                .mask(
                    LinearGradient(
                        colors: [.clear, .black],
                        startPoint: .top,
                        endPoint: .bottom))
                .frame(height: 34)

            Image(systemName: "chevron.compact.down")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .padding(.bottom, 6)
                .background(.regularMaterial)
        }
        .allowsHitTesting(false)
    }

    private func selectSlashCommand(_ command: OpenClawChatCommandChoice) {
        guard let inputModel else { return }
        self.suppressNextSlashPopoverUpdate = true
        inputModel.applySlashCommandSelection(command)
        self.setSlashPanelPresented(false)
        #if os(macOS)
        self.shouldFocusTextView = true
        #else
        self.isFocused = true
        #endif
    }

    private func setSlashPanelPresented(_ presented: Bool) {
        withAnimation(.easeInOut(duration: 0.18)) {
            self.isSlashPopoverPresented = presented
        }
        if presented {
            self.slashHighlightIndex = 0
        }
    }

    private var slashPanelCanPresent: Bool {
        // Transports without a command catalog (e.g. onboarding) get no panel
        // instead of an empty "No matching commands" box.
        guard inputModel?.transport.supportsSlashCommandCatalog == true else { return false }
        // macOS input is an NSTextView outside SwiftUI focus tracking; it is
        // the composer's only editable field, so enablement is the gate.
        #if os(macOS)
        return self.isComposerEnabled
        #else
        return self.isComposerEnabled && self.isFocused
        #endif
    }

    /// Keyboard-driven row highlight is macOS-only; on touch platforms a
    /// persistent highlight on row 0 would read as a stray selection.
    private var usesSlashKeyboardHighlight: Bool {
        #if os(macOS)
        true
        #else
        false
        #endif
    }

    private func updateSlashPopoverPresentation() {
        if self.suppressNextSlashPopoverUpdate {
            self.suppressNextSlashPopoverUpdate = false
            return
        }
        let shouldShow = self.slashPanelCanPresent && self.slashQuery != nil
        if shouldShow {
            inputModel?.loadSlashCommandsIfNeeded()
            self.slashHighlightIndex = 0
        }
        if shouldShow != self.isSlashPopoverPresented {
            self.setSlashPanelPresented(shouldShow)
        }
    }

    #if os(macOS)
    /// Keyboard routing while the slash panel is open: arrows move the
    /// highlight, Tab/Return accept, Escape dismisses. Returning false hands
    /// the key back to the text view (typing, send-on-return).
    private func handleComposerKeyCommand(
        _ command: ChatComposerKeyCommand,
        context: ChatComposerKeyCommandContext) -> Bool
    {
        guard let inputModel else { return false }
        if self.isSlashPopoverPresented {
            let matches = inputModel.slashCommandMatches(query: self.slashQuery ?? "", filter: .all)
            switch command {
            case .escape:
                self.setSlashPanelPresented(false)
                return true
            case .moveUp:
                guard !matches.isEmpty else { return true }
                self.slashHighlightIndex = (self.slashHighlightIndex - 1 + matches.count) % matches.count
                return true
            case .moveDown:
                guard !matches.isEmpty else { return true }
                self.slashHighlightIndex = (self.slashHighlightIndex + 1) % matches.count
                return true
            case .tab, .returnKey:
                guard matches.indices.contains(self.slashHighlightIndex) else {
                    self.setSlashPanelPresented(false)
                    return command == .tab
                }
                self.selectSlashCommand(matches[self.slashHighlightIndex])
                return true
            }
        }

        switch command {
        case .moveUp:
            return inputModel.recallPreviousInput(caretOnFirstLine: context.caretOnFirstLine)
        case .moveDown:
            return inputModel.recallNextInput()
        case .escape:
            if inputModel.cancelInputRecall() {
                return true
            }
            guard inputModel.replyTarget != nil else { return false }
            inputModel.clearReplyTarget()
            return true
        case .tab, .returnKey:
            return false
        }
    }
    #endif
}

extension OpenClawChatComposer {
    private var inputText: Binding<String> {
        Binding(
            get: { self.inputModel?.input ?? "" },
            set: { self.inputModel?.input = $0 })
    }

    var inputModel: OpenClawChatViewModel? {
        // Resolve synchronous input at delivery time, including callbacks from the previous render.
        if let resolveInputModel {
            return resolveInputModel()
        }
        return self.viewModel
    }

    @ViewBuilder
    var sendButton: some View {
        if self.viewModel.pendingRunCount > 0 {
            Button {
                self.viewModel.abort()
            } label: {
                if self.viewModel.isAborting {
                    ProgressView().controlSize(.mini)
                } else {
                    Image(systemName: "stop.fill")
                        .font(.system(size: OpenClawChatTypography.scaled(17), weight: .semibold))
                }
            }
            .buttonStyle(.plain)
            .foregroundStyle(.white)
            #if os(iOS)
            .tint(.white)
            #endif
            .frame(width: self.sendButtonSize, height: self.sendButtonSize)
            .background(
                RoundedRectangle(cornerRadius: self.sendButtonCornerRadius, style: .continuous)
                    .fill(self.stopButtonFill)
                    .frame(width: self.sendButtonVisualSize, height: self.sendButtonVisualSize))
            .contentShape(Rectangle())
            .accessibilityLabel("Stop response")
            .disabled(self.viewModel.isAborting)
            .modifier(ChatStopGuard())
        }
        if self.viewModel.pendingRunCount == 0 || self.viewModel.hasDraftToSend {
            Button {
                self.sendDraftIfEnabled()
            } label: {
                if self.viewModel.isSending {
                    ProgressView().controlSize(.mini)
                } else {
                    Image(systemName: "arrow.up")
                        .font(.system(size: OpenClawChatTypography.scaled(18), weight: .semibold))
                }
            }
            .buttonStyle(.plain)
            .foregroundStyle(self.sendButtonForeground)
            .frame(width: self.sendButtonSize, height: self.sendButtonSize)
            .background(
                RoundedRectangle(cornerRadius: self.sendButtonCornerRadius, style: .continuous)
                    .fill(self.canSendMessage ? self.sendButtonFill : self.disabledSendButtonFill)
                    .frame(width: self.sendButtonVisualSize, height: self.sendButtonVisualSize))
            .overlay(
                RoundedRectangle(cornerRadius: self.sendButtonCornerRadius, style: .continuous)
                    .strokeBorder(Color.white.opacity(self.sendButtonBorderOpacity), lineWidth: 1)
                    .frame(width: self.sendButtonVisualSize, height: self.sendButtonVisualSize))
            .contentShape(Rectangle())
            .accessibilityLabel(Text(verbatim: "Send message"))
            .accessibilityIdentifier("chat-send-message")
            .disabled(!self.canSendMessage)
            .chatActionContextMenu {
                if self.canSendMessage {
                    ForEach(self.inputModel?.sendModeChoices ?? [], id: \.self) { mode in
                        Button {
                            self.sendDraftIfEnabled(queueMode: mode)
                        } label: {
                            switch mode {
                            case .steer:
                                Label("Steer now", systemImage: "arrow.turn.up.right")
                                    .font(OpenClawChatTypography.body)
                            case .followup:
                                Label("Queue next", systemImage: "clock")
                                    .font(OpenClawChatTypography.body)
                            }
                        }
                    }
                }
            }
        }
    }

    private var refreshButton: some View {
        Button {
            self.viewModel.refresh()
        } label: {
            Image(systemName: "arrow.clockwise")
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
    }

    private var composerPadding: CGFloat {
        Self.padding(style: self.style, chrome: self.composerChrome)
    }

    private static func padding(style: OpenClawChatView.Style, chrome: OpenClawChatView.ComposerChrome) -> CGFloat {
        style == .onboarding ? 5 : (chrome == .clean ? 4 : 6)
    }

    /// How far the visible composer sits inside its frame, so a card stacked on it can share its edges.
    /// The clean surface is drawn inside the padding; the full background is drawn around it.
    static func surfaceInset(style: OpenClawChatView.Style, chrome: OpenClawChatView.ComposerChrome) -> CGFloat {
        chrome == .clean ? self.padding(style: style, chrome: chrome) : 0
    }

    #if os(iOS)
    /// The "+" sheet opens with the keyboard down, and over any open panel.
    func openAddSheet() {
        self.addSheetReturnsFocus = self.isFocused
        self.addSheetFollowUp = nil
        self.composerPanels?.dismiss()
        // The draft's text view treats a false focus request as no request; end editing instead.
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        self.pickedAttachmentFocusIDs.removeAll()
        self.showsAddSheet = true
    }
    #endif

    #if !os(macOS)
    /// Each native picker creates its tiles synchronously before loading the selected files.
    private func stagePickerSelection(_ stage: () -> Void) {
        #if os(iOS)
        let first = self.viewModel.preparingAttachments.count
        #endif
        stage()
        #if os(iOS)
        guard self.composerChrome == .clean, !self.isFocused, !self.addSheetReturnsFocus else { return }
        self.pickedAttachmentFocusIDs = Set(self.viewModel.preparingAttachments.dropFirst(first).map(\.id))
        #endif
    }

    func returnFocusAfterAddSheet() {
        #if os(iOS)
        guard self.addSheetReturnsFocus else { return }
        self.addSheetReturnsFocus = false
        self.focusDraft()
        #endif
    }
    #endif

    private var textMinHeight: CGFloat {
        #if os(macOS)
        if self.usesDesktopModelMenu {
            return self.scaledBodyLineHeight
        }
        #endif
        let base: CGFloat = if self.style == .onboarding {
            24
        } else {
            self.composerChrome == .clean ? 24 : 28
        }
        return max(base, self.scaledBodyLineHeight)
    }

    private var textMaxHeight: CGFloat {
        #if os(macOS)
        if self.isDesktopLayout {
            return 160
        }
        #endif
        let base: CGFloat = if self.style == .onboarding {
            52
        } else {
            self.composerChrome == .clean ? 48 : 64
        }
        // The clean draft grows to six lines, then scrolls inside the composer.
        return max(base, self.scaledBodyLineHeight * (self.composerChrome == .clean ? 6 : 4))
    }

    private var sendButtonSize: CGFloat {
        self.composerChrome == .clean ? self.cleanControlHeight : 44
    }

    private var sendButtonVisualSize: CGFloat {
        self.composerChrome == .clean ? self.cleanIconControlSize : self.sendButtonSize
    }

    private var sendButtonCornerRadius: CGFloat {
        self.composerChrome == .clean ? self.cleanIconControlSize / 2 : 12
    }

    var cleanControlHeight: CGFloat {
        self.usesDesktopModelMenu ? 32 : CleanChatComposerMetrics.controlTouchSize
    }

    private var cleanCornerRadius: CGFloat {
        #if os(macOS)
        self.isDesktopLayout ? CleanChatComposerMetrics.surfaceCornerRadius : 24
        #elseif os(iOS)
        self.isFocused || self.hasComposerContent ? CleanChatComposerMetrics.expandedCornerRadius :
            self.cleanControlHeight / 2 + CleanChatComposerMetrics.collapsedControlInset
        #else
        CleanChatComposerMetrics.surfaceCornerRadius
        #endif
    }

    var cleanIconControlSize: CGFloat {
        CleanChatComposerMetrics.primaryVisualSize
    }

    private var cleanFieldTextInset: CGFloat {
        self.composerChrome == .clean ? 0 : 4
    }

    private var editorOverlayAlignment: Alignment {
        self.composerChrome == .clean ? .leading : .topLeading
    }

    var canSendMessage: Bool {
        guard let inputModel else { return false }
        return self.isComposerEnabled
            // Dictation appends when capture completes; sending mid-capture
            // would split one draft across two messages.
            && self.dictationTask == nil
            && self.voiceNoteControl?.recorder.ownsPendingChatAttachment != true
            && inputModel.canSend
            && (self.isAttachmentInputEnabled ||
                inputModel.composerAttachments.isEmpty && inputModel.composerPreparingAttachments.isEmpty)
    }

    private func stageCompletedVoiceNoteIfNeeded() {
        guard let recorder = voiceNoteControl?.recorder,
              let recording = recorder.claimCompletedRecording()
        else { return }

        let viewModel = self.viewModel
        Task {
            await viewModel.addVoiceNoteAttachment(
                fileURL: recording.fileURL,
                durationSeconds: recording.durationSeconds)
            recorder.completeStaging(recording)
        }
    }

    private func cancelActiveVoiceNoteIfNeeded() {
        guard let recorder = voiceNoteControl?.recorder,
              recorder.isRecording || recorder.isRequestingPermission
        else { return }
        // The app-owned recorder outlives this view. Release the microphone
        // when its only recording UI disappears so capture never runs hidden.
        recorder.cancel()
    }

    private var placeholderText: String {
        let trimmed = self.messagePlaceholder?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? "Message…" : trimmed
    }

    #if os(macOS)
    func pickFilesMac() {
        guard self.isAttachmentInputEnabled else { return }
        let panel = NSOpenPanel()
        panel.title = "Select attachments"
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.allowedContentTypes = OpenClawChatPickerAttachmentMetadata.allowedFileContentTypes
        let owner = OpenClawChatAttachmentCaptureOwner(viewModel: viewModel)
        panel.begin { resp in
            guard resp == .OK else { return }
            owner.addAttachments(urls: panel.urls)
        }
    }

    private func handleDrop(_ providers: [NSItemProvider]) -> Bool {
        guard self.isAttachmentInputEnabled else { return false }
        let fileProviders = providers.filter { $0.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) }
        guard !fileProviders.isEmpty else { return false }
        let owner = OpenClawChatAttachmentCaptureOwner(viewModel: viewModel)
        for item in fileProviders {
            item.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
                guard let data = item as? Data,
                      let url = URL(dataRepresentation: data, relativeTo: nil)
                else { return }
                Task { @MainActor in
                    owner.addAttachments(urls: [url])
                }
            }
        }
        return true
    }
    #else
    private func handleFileImport(
        _ result: Result<[URL], Error>,
        owner: OpenClawChatAttachmentCaptureOwner?)
    {
        guard self.isAttachmentInputEnabled else { return }
        guard let owner,
              viewModel === owner.viewModel,
              owner.viewModel.isCurrentSession(owner.session)
        else { return }
        switch result {
        case let .success(urls):
            owner.addAttachments(urls: urls)
        case let .failure(error):
            if !(error is CancellationError) {
                owner.viewModel.reportFailure(String(localized: "Couldn’t add that file."), error, while: "import file")
            }
        }
    }

    #if canImport(UIKit)
    private func addCameraImage(_ image: UIImage, owner: OpenClawChatAttachmentCaptureOwner) {
        guard self.isAttachmentInputEnabled else { return }
        guard self.viewModel === owner.viewModel,
              owner.viewModel.isCurrentSession(owner.session)
        else { return }
        self.cancelActiveCameraEncoding()
        let sendableImage = OpenClawSendableCameraImage(value: image)
        let fileName = "\(OpenClawChatGeneratedAttachmentName.picked(.camera)).jpg"
        let viewModel = owner.viewModel
        let session = owner.session
        // The photo is already in hand, so its tile shows it dimmed under the spinner while it encodes.
        let preparation = viewModel.beginAttachmentPreparation(
            fileName: fileName,
            mimeType: "image/jpeg",
            preview: image)
        // Pin routing before JPEG encoding suspends so an external agent or
        // session update cannot adopt this camera result under a new owner.
        self.cameraEncodingTask = viewModel.runAttachmentPreparation([preparation]) { @MainActor in
            let data = await Task.detached(priority: .userInitiated) {
                sendableImage.value.jpegData(compressionQuality: 0.92)
            }.value
            guard !Task.isCancelled,
                  self.viewModel === viewModel,
                  viewModel.isCurrentSession(session),
                  self.isAttachmentInputEnabled
            else { return }
            guard let data else {
                viewModel.reportAttachmentFailure(
                    OpenClawChatViewModel.couldNotAttachMessage(fileName, preparation: preparation),
                    preparation: preparation)
                return
            }
            await viewModel.addImageAttachment(
                data: data,
                fileName: fileName,
                mimeType: "image/jpeg",
                for: session,
                preparation: preparation)
        }
    }
    #endif

    private func dismissAttachmentCapture(keepingAddSheet: Bool = false) {
        #if os(iOS)
        if !keepingAddSheet {
            self.showsAddSheet = false
            self.addSheetReturnsFocus = false
        }
        self.addSheetFollowUp = nil
        self.pickedAttachmentFocusIDs.removeAll()
        #endif
        self.showsPhotoPicker = false
        self.showsFileImporter = false
        self.showsCameraPicker = false
        self.photoPickerOwner = nil
        self.fileImporterOwner = nil
        #if canImport(UIKit)
        self.cameraCaptureOwner = nil
        #endif
        self.cancelActiveCameraEncoding()
    }

    private func cancelActiveCameraEncoding() {
        #if canImport(UIKit)
        self.cameraEncodingTask?.cancel()
        self.cameraEncodingTask = nil
        #endif
    }

    private func stagePhotosPickerItems(
        _ items: [PhotosPickerItem],
        owner: OpenClawChatAttachmentCaptureOwner?)
    {
        guard self.isAttachmentInputEnabled,
              let owner,
              viewModel === owner.viewModel,
              owner.viewModel.isCurrentSession(owner.session)
        else {
            self.pickerItems = []
            return
        }
        let viewModel = owner.viewModel
        // Every pick gets its tile now, before the Photos library hands over any data.
        let picks = items.map { item in
            let type = item.supportedContentTypes.first(where: {
                $0.conforms(to: .movie) || $0.conforms(to: .image)
            }) ?? item.supportedContentTypes.first ?? .image
            let metadata = OpenClawChatPickerAttachmentMetadata.resolve(contentType: type)
            let baseName = OpenClawChatGeneratedAttachmentName.picked(type.conforms(to: .movie) ? .video : .photo)
            let preparation = viewModel.beginAttachmentPreparation(
                fileName: "\(baseName).\(metadata.fileExtension)",
                mimeType: metadata.mimeType)
            let pick = OpenClawPhotosPick(item: item, type: type, baseName: baseName, preparation: preparation)
            viewModel.setAttachmentPreparationReload(preparation) {
                await pick.load(owner: owner)
            }
            return pick
        }
        viewModel.runAttachmentPreparation(picks.map(\.preparation)) { @MainActor in
            for pick in picks {
                guard self.viewModel === viewModel, viewModel.isCurrentSession(owner.session) else { break }
                guard !viewModel.isAttachmentPreparationRemoved(pick.preparation) else { continue }
                await pick.load(owner: owner)
            }
            self.pickerItems = []
        }
    }
    #endif

    func sendDraftIfEnabled(queueMode: OpenClawChatQueueMode? = nil) {
        guard self.canSendMessage else { return }
        ChatBehaviorProbe.mark("send")
        self.inputModel?.send(queueMode: queueMode)
    }
}
