import Foundation
import Observation
import SwiftUI

#if !os(macOS)
import PhotosUI
import UniformTypeIdentifiers
#endif

@MainActor
struct OpenClawChatComposer: View {
    private static let menuThinkingLevels = ["off", "low", "medium", "high"]

    @Bindable var viewModel: OpenClawChatViewModel
    let style: OpenClawChatView.Style
    let showsSessionSwitcher: Bool

    #if !os(macOS)
    @State private var pickerItems: [PhotosPickerItem] = []
    @FocusState private var isFocused: Bool
    #else
    @State private var shouldFocusTextView = false
    #endif

    var body: some View {
        VStack(alignment: .leading, spacing: self.style == .workspace ? 10 : 4) {
            if self.showsToolbar {
                self.toolbarContent
            }

            if self.showsAttachments, !self.viewModel.attachments.isEmpty {
                self.attachmentsStrip
            }

            self.editor
        }
        .padding(self.composerPadding)
        .background {
            let cornerRadius: CGFloat = 18

            #if os(macOS)
            if self.style == .workspace {
                let shape = RoundedRectangle(cornerRadius: 22, style: .continuous)
                shape
                    .fill(OpenClawChatTheme.workspacePanel)
                    .overlay(shape.strokeBorder(OpenClawChatTheme.workspacePanelBorder, lineWidth: 1))
                    .shadow(color: .black.opacity(0.08), radius: 18, y: 10)
            } else if self.style == .standard {
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
        #if os(macOS)
        .onDrop(of: [.fileURL], isTargeted: nil) { providers in
            self.handleDrop(providers)
        }
        .onAppear {
            self.shouldFocusTextView = true
        }
        #endif
    }

    @ViewBuilder
    private var toolbarContent: some View {
        if self.style == .workspace {
            self.workspaceToolbar
        } else {
            HStack(spacing: 6) {
                if self.showsSessionSwitcher {
                    self.sessionPicker
                }
                if self.viewModel.showsModelPicker {
                    self.modelPicker
                }
                self.thinkingPicker
                Spacer()
                self.refreshButton
                self.attachmentPicker
            }
            .padding(.horizontal, 10)
        }
    }

    private var workspaceToolbar: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Manual Controls")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text("Choose the live session, model, and reasoning level before you intervene.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }

                Spacer(minLength: 0)

                self.refreshButton
                self.attachmentPicker
            }

            HStack(alignment: .top, spacing: 10) {
                if self.showsSessionSwitcher {
                    self.workspaceControlCard(title: "Session", minWidth: 170) {
                        self.sessionPicker
                    }
                }

                if self.viewModel.showsModelPicker {
                    self.workspaceControlCard(title: "Model", minWidth: 250) {
                        self.modelPicker
                    }
                }

                self.workspaceControlCard(title: "Thinking", minWidth: 130) {
                    self.thinkingPicker
                }
            }
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(OpenClawChatTheme.workspacePanelSecondary)
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .strokeBorder(OpenClawChatTheme.workspacePanelBorder, lineWidth: 1)))
    }

    private func workspaceControlCard<Content: View>(
        title: String,
        minWidth: CGFloat,
        @ViewBuilder content: () -> Content)
        -> some View
    {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
            content()
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(minWidth: minWidth, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(OpenClawChatTheme.workspaceSoftFill)
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(OpenClawChatTheme.workspacePanelBorder, lineWidth: 1)))
    }

    private var thinkingPicker: some View {
        Picker(
            "Thinking",
            selection: Binding(
                get: { self.viewModel.thinkingLevel },
                set: { next in self.viewModel.selectThinkingLevel(next) }))
        {
            Text("Off").tag("off")
            Text("Low").tag("low")
            Text("Medium").tag("medium")
            Text("High").tag("high")
            if !Self.menuThinkingLevels.contains(self.viewModel.thinkingLevel) {
                Text(self.viewModel.thinkingLevel.capitalized).tag(self.viewModel.thinkingLevel)
            }
        }
        .labelsHidden()
        .pickerStyle(.menu)
        .controlSize(.small)
        .frame(maxWidth: 140, alignment: .leading)
    }

    private var modelPicker: some View {
        Picker(
            "Model",
            selection: Binding(
                get: { self.viewModel.modelSelectionID },
                set: { next in self.viewModel.selectModel(next) }))
        {
            Text(self.viewModel.defaultModelLabel).tag(OpenClawChatViewModel.defaultModelSelectionID)
            ForEach(self.viewModel.modelChoices) { model in
                Text(model.displayLabel).tag(model.selectionID)
            }
        }
        .labelsHidden()
        .pickerStyle(.menu)
        .controlSize(.small)
        .frame(maxWidth: 240, alignment: .leading)
        .help("Model")
    }

    private var sessionPicker: some View {
        Picker(
            "Session",
            selection: Binding(
                get: { self.viewModel.sessionKey },
                set: { next in self.viewModel.switchSession(to: next) }))
        {
            ForEach(self.viewModel.sessionChoices, id: \.key) { session in
                Text(session.displayName ?? session.key)
                    .font(.system(.caption, design: .monospaced))
                    .tag(session.key)
            }
        }
        .labelsHidden()
        .pickerStyle(.menu)
        .controlSize(.small)
        .frame(maxWidth: 160, alignment: .leading)
        .help("Session")
    }

    @ViewBuilder
    private var attachmentPicker: some View {
        #if os(macOS)
        Button {
            self.pickFilesMac()
        } label: {
            if self.style == .workspace {
                Label("Attach", systemImage: "paperclip")
            } else {
                Image(systemName: "paperclip")
            }
        }
        .help("Add Image")
        .buttonStyle(.bordered)
        .controlSize(.small)
        #else
        PhotosPicker(selection: self.$pickerItems, maxSelectionCount: 8, matching: .images) {
            Image(systemName: "paperclip")
        }
        .help("Add Image")
        .buttonStyle(.bordered)
        .controlSize(.small)
        .onChange(of: self.pickerItems) { _, newItems in
            Task { await self.loadPhotosPickerItems(newItems) }
        }
        #endif
    }

    private var attachmentsStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(
                    self.viewModel.attachments,
                    id: \OpenClawPendingAttachment.id)
                { (att: OpenClawPendingAttachment) in
                    HStack(spacing: 6) {
                        if let img = att.preview {
                            OpenClawPlatformImageFactory.image(img)
                                .resizable()
                                .scaledToFill()
                                .frame(width: 22, height: 22)
                                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                        } else {
                            Image(systemName: "photo")
                        }

                        Text(att.fileName)
                            .lineLimit(1)

                        Button {
                            self.viewModel.removeAttachment(att.id)
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.horizontal, self.style == .workspace ? 10 : 8)
                    .padding(.vertical, self.style == .workspace ? 7 : 5)
                    .background(self.attachmentChipBackground)
                    .overlay(
                        Capsule(style: .continuous)
                            .strokeBorder(self.style == .workspace ? OpenClawChatTheme.workspacePanelBorder : .clear, lineWidth: self.style == .workspace ? 1 : 0))
                    .clipShape(Capsule())
                }
            }
        }
    }

    private var editor: some View {
        VStack(alignment: .leading, spacing: 8) {
            if self.style == .workspace {
                self.draftHeader
            }

            self.editorOverlay

            if !self.isComposerCompacted {
                Rectangle()
                    .fill(OpenClawChatTheme.divider)
                    .frame(height: 1)
                    .padding(.horizontal, 2)
            }

            HStack(alignment: .center, spacing: 8) {
                if self.showsConnectionPill {
                    self.connectionPill
                }
                Spacer(minLength: 0)
                self.sendButton
            }

            if self.style == .workspace {
                Text("Manual Chat is for retries, redirects, and explicit status requests. Return sends, Shift-Return starts a new line.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(self.editorBackground)
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(self.editorBorder)))
        .padding(self.editorPadding)
    }

    private var connectionPill: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(self.viewModel.healthOK ? .green : .orange)
                .frame(width: 7, height: 7)
            Text(self.activeSessionLabel)
                .font(.caption2.weight(.semibold))
            Text(self.viewModel.healthOK ? "Connected" : "Connecting…")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(self.connectionPillBackground)
        .overlay(
            Capsule()
                .strokeBorder(self.style == .workspace ? OpenClawChatTheme.workspacePanelBorder : .clear, lineWidth: self.style == .workspace ? 1 : 0))
        .clipShape(Capsule())
    }

    @ViewBuilder
    private var draftHeader: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Draft")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(self.draftMetaLine)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 0)

            if self.hasDraftContent {
                Button("Clear") {
                    self.clearDraft()
                }
                .buttonStyle(.plain)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            }
        }
    }

    private var activeSessionLabel: String {
        let match = self.viewModel.sessions.first { $0.key == self.viewModel.sessionKey }
        let trimmed = match?.displayName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? self.viewModel.sessionKey : trimmed
    }

    private var editorOverlay: some View {
        ZStack(alignment: .topLeading) {
            if self.viewModel.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text(self.placeholderText)
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, 4)
                    .padding(.vertical, 4)
            }

            #if os(macOS)
            ChatComposerTextView(
                text: self.$viewModel.input,
                shouldFocus: self.$shouldFocusTextView,
                onSend: {
                    self.viewModel.send()
                },
                onPasteImageAttachment: { data, fileName, mimeType in
                    self.viewModel.addImageAttachment(data: data, fileName: fileName, mimeType: mimeType)
                })
            .frame(minHeight: self.textMinHeight, idealHeight: self.textMinHeight, maxHeight: self.textMaxHeight)
            .padding(.horizontal, 4)
            .padding(.vertical, 3)
            #else
            TextEditor(text: self.$viewModel.input)
                .font(.system(size: 15))
                .scrollContentBackground(.hidden)
                .frame(
                    minHeight: self.textMinHeight,
                    idealHeight: self.textMinHeight,
                    maxHeight: self.textMaxHeight)
                .padding(.horizontal, 4)
                .padding(.vertical, 4)
                .focused(self.$isFocused)
            #endif
        }
    }

    private var sendButton: some View {
        Group {
            if self.viewModel.pendingRunCount > 0 {
                Button {
                    self.viewModel.abort()
                } label: {
                    if self.style == .workspace {
                        Label {
                            if self.viewModel.isAborting {
                                Text("Stopping…")
                            } else {
                                Text("Stop")
                            }
                        } icon: {
                            if self.viewModel.isAborting {
                                ProgressView().controlSize(.mini)
                            } else {
                                Image(systemName: "stop.fill")
                                    .font(.system(size: 13, weight: .semibold))
                            }
                        }
                    } else {
                        if self.viewModel.isAborting {
                            ProgressView().controlSize(.mini)
                        } else {
                            Image(systemName: "stop.fill")
                                .font(.system(size: 13, weight: .semibold))
                        }
                    }
                }
                .buttonStyle(.plain)
                .foregroundStyle(.white)
                .padding(self.sendButtonPadding)
                .background(self.sendButtonBackground(color: .red))
                .opacity(self.viewModel.isAborting ? 0.85 : 1)
                .disabled(self.viewModel.isAborting)
            } else {
                Button {
                    self.viewModel.send()
                } label: {
                    if self.style == .workspace {
                        Label {
                            if self.viewModel.isSending {
                                Text("Sending…")
                            } else {
                                Text("Send")
                            }
                        } icon: {
                            if self.viewModel.isSending {
                                ProgressView().controlSize(.mini)
                            } else {
                                Image(systemName: "arrow.up")
                                    .font(.system(size: 13, weight: .semibold))
                            }
                        }
                    } else {
                        if self.viewModel.isSending {
                            ProgressView().controlSize(.mini)
                        } else {
                            Image(systemName: "arrow.up")
                                .font(.system(size: 13, weight: .semibold))
                        }
                    }
                }
                .buttonStyle(.plain)
                .foregroundStyle(.white)
                .padding(self.sendButtonPadding)
                .background(self.sendButtonBackground(color: Color.accentColor))
                .opacity(self.viewModel.canSend ? 1 : 0.54)
                .disabled(!self.viewModel.canSend)
            }
        }
    }

    private var refreshButton: some View {
        Button {
            self.viewModel.refresh()
        } label: {
            if self.style == .workspace {
                Label("Refresh", systemImage: "arrow.clockwise")
            } else {
                Image(systemName: "arrow.clockwise")
            }
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .help("Refresh")
    }

    private var showsToolbar: Bool {
        (self.style == .standard || self.style == .workspace) && !self.isComposerCompacted
    }

    private var showsAttachments: Bool {
        self.style == .standard || self.style == .workspace
    }

    private var showsConnectionPill: Bool {
        (self.style == .standard || self.style == .workspace) && !self.isComposerCompacted
    }

    private var composerPadding: CGFloat {
        if self.style == .workspace { return 0 }
        return self.style == .onboarding ? 5 : (self.isComposerCompacted ? 4 : 6)
    }

    private var editorPadding: CGFloat {
        if self.style == .workspace { return 0 }
        return self.style == .onboarding ? 5 : (self.isComposerCompacted ? 4 : 6)
    }

    private var textMinHeight: CGFloat {
        if self.style == .workspace { return 72 }
        return self.style == .onboarding ? 24 : 28
    }

    private var textMaxHeight: CGFloat {
        if self.style == .workspace { return 180 }
        return self.style == .onboarding ? 52 : 64
    }

    private var isComposerCompacted: Bool {
        #if os(macOS)
        false
        #else
        self.style == .standard && self.isFocused
        #endif
    }

    private var editorBackground: AnyShapeStyle {
        self.style == .workspace ? OpenClawChatTheme.workspacePanelSecondary : OpenClawChatTheme.composerField
    }

    private var editorBorder: Color {
        self.style == .workspace ? OpenClawChatTheme.workspacePanelBorder : OpenClawChatTheme.composerBorder
    }

    private var connectionPillBackground: AnyShapeStyle {
        self.style == .workspace ? OpenClawChatTheme.workspaceSoftFill : OpenClawChatTheme.subtleCard
    }

    private var attachmentChipBackground: AnyShapeStyle {
        self.style == .workspace ? OpenClawChatTheme.workspaceSoftFill : AnyShapeStyle(Color.accentColor.opacity(0.08))
    }

    private var placeholderText: String {
        if self.style == .workspace {
            return "Describe the intervention, retry request, or status question for the active session…"
        }
        return "Message OpenClaw…"
    }

    private var sendButtonPadding: CGFloat {
        self.style == .workspace ? 10 : 6
    }

    private func sendButtonBackground(color: Color) -> some View {
        Group {
            if self.style == .workspace {
                Capsule(style: .continuous)
                    .fill(color)
            } else {
                Circle()
                    .fill(color)
            }
        }
    }

    private var hasDraftContent: Bool {
        !self.viewModel.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !self.viewModel.attachments.isEmpty
    }

    private var draftMetaLine: String {
        let trimmed = self.viewModel.input.trimmingCharacters(in: .whitespacesAndNewlines)
        var parts: [String] = []
        if trimmed.isEmpty {
            parts.append("No text yet")
        } else {
            parts.append("\(trimmed.count) characters")
        }
        if !self.viewModel.attachments.isEmpty {
            parts.append(self.viewModel.attachments.count == 1 ? "1 attachment" : "\(self.viewModel.attachments.count) attachments")
        }
        return parts.joined(separator: " • ")
    }

    private func clearDraft() {
        self.viewModel.input = ""
        self.viewModel.attachments = []
    }

    #if os(macOS)
    private func pickFilesMac() {
        let panel = NSOpenPanel()
        panel.title = "Select image attachments"
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.image]
        panel.begin { resp in
            guard resp == .OK else { return }
            self.viewModel.addAttachments(urls: panel.urls)
        }
    }

    private func handleDrop(_ providers: [NSItemProvider]) -> Bool {
        let fileProviders = providers.filter { $0.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) }
        guard !fileProviders.isEmpty else { return false }
        for item in fileProviders {
            item.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
                guard let data = item as? Data,
                      let url = URL(dataRepresentation: data, relativeTo: nil)
                else { return }
                Task { @MainActor in
                    self.viewModel.addAttachments(urls: [url])
                }
            }
        }
        return true
    }
    #else
    private func loadPhotosPickerItems(_ items: [PhotosPickerItem]) async {
        for item in items {
            do {
                guard let data = try await item.loadTransferable(type: Data.self) else { continue }
                let type = item.supportedContentTypes.first ?? .image
                let ext = type.preferredFilenameExtension ?? "jpg"
                let mime = type.preferredMIMEType ?? "image/jpeg"
                let name = "photo-\(UUID().uuidString.prefix(8)).\(ext)"
                self.viewModel.addImageAttachment(data: data, fileName: name, mimeType: mime)
            } catch {
                self.viewModel.errorText = error.localizedDescription
            }
        }
        self.pickerItems = []
    }
    #endif
}

#if os(macOS)
import AppKit
import UniformTypeIdentifiers

private struct ChatComposerTextView: NSViewRepresentable {
    @Binding var text: String
    @Binding var shouldFocus: Bool
    var onSend: () -> Void
    var onPasteImageAttachment: (_ data: Data, _ fileName: String, _ mimeType: String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let textView = ChatComposerNSTextView()
        textView.delegate = context.coordinator
        textView.drawsBackground = false
        textView.isRichText = false
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticSpellingCorrectionEnabled = false
        textView.font = .systemFont(ofSize: 14, weight: .regular)
        textView.textContainer?.lineBreakMode = .byWordWrapping
        textView.textContainer?.lineFragmentPadding = 0
        textView.textContainerInset = NSSize(width: 2, height: 4)
        textView.focusRingType = .none

        textView.minSize = .zero
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.isHorizontallyResizable = false
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        textView.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        textView.textContainer?.widthTracksTextView = true

        textView.string = self.text
        textView.onSend = { [weak textView] in
            textView?.window?.makeFirstResponder(nil)
            self.onSend()
        }
        textView.onPasteImageAttachment = self.onPasteImageAttachment

        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        scroll.hasHorizontalScroller = false
        scroll.documentView = textView
        return scroll
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? ChatComposerNSTextView else { return }
        textView.onPasteImageAttachment = self.onPasteImageAttachment

        if self.shouldFocus, let window = scrollView.window {
            window.makeFirstResponder(textView)
            self.shouldFocus = false
        }

        let isEditing = scrollView.window?.firstResponder == textView

        // Always allow clearing the text (e.g. after send), even while editing.
        // Only skip other updates while editing to avoid cursor jumps.
        let shouldClear = self.text.isEmpty && !textView.string.isEmpty
        if isEditing, !shouldClear { return }

        if textView.string != self.text {
            context.coordinator.isProgrammaticUpdate = true
            defer { context.coordinator.isProgrammaticUpdate = false }
            textView.string = self.text
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ChatComposerTextView
        var isProgrammaticUpdate = false

        init(_ parent: ChatComposerTextView) { self.parent = parent }

        func textDidChange(_ notification: Notification) {
            guard !self.isProgrammaticUpdate else { return }
            guard let view = notification.object as? NSTextView else { return }
            guard view.window?.firstResponder === view else { return }
            self.parent.text = view.string
        }
    }
}

private final class ChatComposerNSTextView: NSTextView {
    var onSend: (() -> Void)?
    var onPasteImageAttachment: ((_ data: Data, _ fileName: String, _ mimeType: String) -> Void)?

    override var readablePasteboardTypes: [NSPasteboard.PasteboardType] {
        var types = super.readablePasteboardTypes
        for type in ChatComposerPasteSupport.readablePasteboardTypes where !types.contains(type) {
            types.append(type)
        }
        return types
    }

    override func keyDown(with event: NSEvent) {
        let isReturn = event.keyCode == 36
        if isReturn {
            if self.hasMarkedText() {
                super.keyDown(with: event)
                return
            }
            if event.modifierFlags.contains(.shift) {
                super.insertNewline(nil)
                return
            }
            self.onSend?()
            return
        }
        super.keyDown(with: event)
    }

    override func readSelection(from pboard: NSPasteboard, type: NSPasteboard.PasteboardType) -> Bool {
        if !self.handleImagePaste(from: pboard, matching: type) {
            return super.readSelection(from: pboard, type: type)
        }
        return true
    }

    override func paste(_ sender: Any?) {
        if !self.handleImagePaste(from: NSPasteboard.general, matching: nil) {
            super.paste(sender)
        }
    }

    override func pasteAsPlainText(_ sender: Any?) {
        self.paste(sender)
    }

    private func handleImagePaste(
        from pasteboard: NSPasteboard,
        matching preferredType: NSPasteboard.PasteboardType?) -> Bool
    {
        let attachments = ChatComposerPasteSupport.imageAttachments(from: pasteboard, matching: preferredType)
        if !attachments.isEmpty {
            self.deliver(attachments)
            return true
        }

        let fileReferences = ChatComposerPasteSupport.imageFileReferences(from: pasteboard, matching: preferredType)
        if !fileReferences.isEmpty {
            self.loadAndDeliver(fileReferences)
            return true
        }

        return false
    }

    private func deliver(_ attachments: [ChatComposerPasteSupport.ImageAttachment]) {
        for attachment in attachments {
            self.onPasteImageAttachment?(
                attachment.data,
                attachment.fileName,
                attachment.mimeType)
        }
    }

    private func loadAndDeliver(_ fileReferences: [ChatComposerPasteSupport.FileImageReference]) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self, fileReferences] in
            let attachments = ChatComposerPasteSupport.loadImageAttachments(from: fileReferences)
            guard !attachments.isEmpty else { return }
            DispatchQueue.main.async {
                guard let self else { return }
                self.deliver(attachments)
            }
        }
    }
}

enum ChatComposerPasteSupport {
    typealias ImageAttachment = (data: Data, fileName: String, mimeType: String)
    typealias FileImageReference = (url: URL, fileName: String, mimeType: String)

    static var readablePasteboardTypes: [NSPasteboard.PasteboardType] {
        [.fileURL] + self.preferredImagePasteboardTypes.map(\.type)
    }

    static func imageAttachments(
        from pasteboard: NSPasteboard,
        matching preferredType: NSPasteboard.PasteboardType? = nil) -> [ImageAttachment]
    {
        let dataAttachments = self.imageAttachmentsFromRawData(in: pasteboard, matching: preferredType)
        if !dataAttachments.isEmpty {
            return dataAttachments
        }

        if let preferredType, !self.matchesImageType(preferredType) {
            return []
        }

        guard let images = pasteboard.readObjects(forClasses: [NSImage.self]) as? [NSImage], !images.isEmpty else {
            return []
        }
        return images.enumerated().compactMap { index, image in
            self.imageAttachment(from: image, index: index)
        }
    }

    static func imageFileReferences(
        from pasteboard: NSPasteboard,
        matching preferredType: NSPasteboard.PasteboardType? = nil) -> [FileImageReference]
    {
        guard self.matchesFileURL(preferredType) else { return [] }
        return self.imageFileReferencesFromFileURLs(in: pasteboard)
    }

    static func loadImageAttachments(from fileReferences: [FileImageReference]) -> [ImageAttachment] {
        fileReferences.compactMap { reference in
            guard let data = try? Data(contentsOf: reference.url), !data.isEmpty else {
                return nil
            }
            return (
                data: data,
                fileName: reference.fileName,
                mimeType: reference.mimeType)
        }
    }

    private static func imageFileReferencesFromFileURLs(in pasteboard: NSPasteboard) -> [FileImageReference] {
        guard let urls = pasteboard.readObjects(forClasses: [NSURL.self]) as? [URL], !urls.isEmpty else {
            return []
        }

        return urls.enumerated().compactMap { index, url -> FileImageReference? in
            guard url.isFileURL,
                  let type = UTType(filenameExtension: url.pathExtension),
                  type.conforms(to: .image)
            else {
                return nil
            }

            let mimeType = type.preferredMIMEType ?? "image/\(type.preferredFilenameExtension ?? "png")"
            let fileName = url.lastPathComponent.isEmpty
                ? self.defaultFileName(index: index, ext: type.preferredFilenameExtension ?? "png")
                : url.lastPathComponent
            return (url: url, fileName: fileName, mimeType: mimeType)
        }
    }

    private static func imageAttachmentsFromRawData(
        in pasteboard: NSPasteboard,
        matching preferredType: NSPasteboard.PasteboardType?) -> [ImageAttachment]
    {
        let items = pasteboard.pasteboardItems ?? []
        guard !items.isEmpty else { return [] }

        return items.enumerated().compactMap { index, item in
            self.imageAttachment(from: item, index: index, matching: preferredType)
        }
    }

    private static func imageAttachment(from image: NSImage, index: Int) -> ImageAttachment? {
        guard let tiffData = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiffData)
        else {
            return nil
        }

        if let pngData = bitmap.representation(using: .png, properties: [:]), !pngData.isEmpty {
            return (
                data: pngData,
                fileName: self.defaultFileName(index: index, ext: "png"),
                mimeType: "image/png")
        }

        guard !tiffData.isEmpty else {
            return nil
        }
        return (
            data: tiffData,
            fileName: self.defaultFileName(index: index, ext: "tiff"),
            mimeType: "image/tiff")
    }

    private static func imageAttachment(
        from item: NSPasteboardItem,
        index: Int,
        matching preferredType: NSPasteboard.PasteboardType?) -> ImageAttachment?
    {
        for type in self.preferredImagePasteboardTypes where self.matches(preferredType, candidate: type.type) {
            guard let data = item.data(forType: type.type), !data.isEmpty else { continue }
            return (
                data: data,
                fileName: self.defaultFileName(index: index, ext: type.fileExtension),
                mimeType: type.mimeType)
        }
        return nil
    }

    private static let preferredImagePasteboardTypes: [
        (type: NSPasteboard.PasteboardType, fileExtension: String, mimeType: String)
    ] = [
        (.png, "png", "image/png"),
        (.tiff, "tiff", "image/tiff"),
        (NSPasteboard.PasteboardType("public.jpeg"), "jpg", "image/jpeg"),
        (NSPasteboard.PasteboardType("com.compuserve.gif"), "gif", "image/gif"),
        (NSPasteboard.PasteboardType("public.heic"), "heic", "image/heic"),
        (NSPasteboard.PasteboardType("public.heif"), "heif", "image/heif"),
    ]

    private static func matches(_ preferredType: NSPasteboard.PasteboardType?, candidate: NSPasteboard.PasteboardType) -> Bool {
        guard let preferredType else { return true }
        return preferredType == candidate
    }

    private static func matchesFileURL(_ preferredType: NSPasteboard.PasteboardType?) -> Bool {
        guard let preferredType else { return true }
        return preferredType == .fileURL
    }

    private static func matchesImageType(_ preferredType: NSPasteboard.PasteboardType) -> Bool {
        self.preferredImagePasteboardTypes.contains { $0.type == preferredType }
    }

    private static func defaultFileName(index: Int, ext: String) -> String {
        "pasted-image-\(index + 1).\(ext)"
    }
}
#endif
