import Foundation
import Observation
import SwiftUI

#if !os(macOS)
import PhotosUI
import UIKit
import UniformTypeIdentifiers
#endif

@MainActor
struct OpenClawChatComposer: View {
    private static let menuThinkingLevels = ["off", "low", "medium", "high"]
    private static let slashCommandPresets: [SlashCommandPreset] = [
        .init(name: "help", description: "Show available commands"),
        .init(name: "commands", description: "List all slash commands"),
        .init(name: "tools", description: "List available runtime tools"),
        .init(name: "skill", description: "Run a skill by name"),
        .init(name: "status", description: "Show current status"),
        .init(name: "tasks", description: "List background tasks for this session"),
        .init(name: "allowlist", description: "List, add, or remove allowlist entries"),
        .init(name: "approve", description: "Approve or deny exec requests"),
        .init(name: "context", description: "Explain how context is built and used"),
        .init(name: "btw", description: "Ask a side question without changing session context"),
        .init(name: "export-session", description: "Export the current session to HTML", aliases: ["export", "es"]),
        .init(name: "tts", description: "Control text-to-speech settings"),
        .init(name: "whoami", description: "Show your sender id", aliases: ["id"]),
        .init(name: "session", description: "Manage session-level settings"),
        .init(name: "subagents", description: "List, spawn, steer, or kill subagents"),
        .init(name: "acp", description: "Manage ACP sessions and runtime options"),
        .init(name: "focus", description: "Bind this conversation to a session target"),
        .init(name: "unfocus", description: "Remove the current conversation binding"),
        .init(name: "agents", description: "List thread-bound agents for this session"),
        .init(name: "kill", description: "Kill a running subagent"),
        .init(name: "steer", description: "Send guidance to a running subagent", aliases: ["tell"]),
        .init(name: "config", description: "Show or set config values"),
        .init(name: "mcp", description: "Show or set MCP servers"),
        .init(name: "plugins", description: "List, show, enable, or disable plugins", aliases: ["plugin"]),
        .init(name: "debug", description: "Set runtime debug overrides"),
        .init(name: "usage", description: "Show usage footer or cost summary"),
        .init(name: "stop", description: "Stop the current run"),
        .init(name: "restart", description: "Restart OpenClaw"),
        .init(name: "activation", description: "Set group activation mode"),
        .init(name: "send", description: "Set send policy"),
        .init(name: "new", description: "Start a fresh session"),
        .init(name: "reset", description: "Reset the current session"),
        .init(name: "compact", description: "Compact session context"),
        .init(name: "think", description: "Set thinking level", aliases: ["thinking", "t"]),
        .init(name: "verbose", description: "Toggle verbose mode", aliases: ["v"]),
        .init(name: "fast", description: "Toggle fast mode"),
        .init(name: "reasoning", description: "Toggle reasoning visibility", aliases: ["reason"]),
        .init(name: "elevated", description: "Toggle elevated mode", aliases: ["elev"]),
        .init(name: "exec", description: "Set exec defaults for this session"),
        .init(name: "model", description: "Change or inspect the model"),
        .init(name: "models", description: "List model providers or provider models"),
        .init(name: "queue", description: "Adjust queue settings"),
        .init(name: "bash", description: "Run host shell commands"),
        .init(name: "clear", description: "Clear chat history"),
        .init(name: "redirect", description: "Abort and restart with a new message"),
    ]

    @Bindable var viewModel: OpenClawChatViewModel
    let style: OpenClawChatView.Style
    let showsSessionSwitcher: Bool

    #if !os(macOS)
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var isFocused = false
    #else
    @State private var shouldFocusTextView = false
    #endif

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if self.showsToolbar {
                HStack(spacing: 6) {
                    if self.showsSessionSwitcher {
                        self.sessionPicker
                    }
                    self.modelPicker
                    self.thinkingPicker
                    self.refreshButton
                    Spacer(minLength: 0)
                    self.attachmentPicker
                }
                .padding(.horizontal, 10)
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
        #if os(macOS)
        .onDrop(of: [.fileURL], isTargeted: nil) { providers in
            self.handleDrop(providers)
        }
        .onAppear {
            self.shouldFocusTextView = true
        }
        #endif
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
        Menu {
            Button {
                self.viewModel.selectModel(OpenClawChatViewModel.defaultModelSelectionID)
            } label: {
                self.modelMenuItem(
                    title: self.viewModel.defaultModelLabel,
                    isSelected: self.viewModel.resolvedDisplayedModelSelectionID == nil)
            }
            ForEach(self.viewModel.modelChoices) { model in
                Button {
                    self.viewModel.selectModel(model.selectionID)
                } label: {
                    self.modelMenuItem(
                        title: self.viewModel.modelOptionLabel(model),
                        isSelected: self.viewModel.resolvedDisplayedModelSelectionID == model.selectionID)
                }
            }
        } label: {
            HStack(spacing: 4) {
                Text(self.compactModelDisplayLabel)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
            .font(.caption)
            .frame(maxWidth: 74, alignment: .leading)
        }
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
            Image(systemName: "paperclip")
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
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(Color.accentColor.opacity(0.08))
                    .clipShape(Capsule())
                }
            }
        }
    }

    private var editor: some View {
        VStack(alignment: .leading, spacing: 5) {
            if !self.slashSuggestions.isEmpty {
                self.slashSuggestionsView
            }

            HStack(alignment: .bottom, spacing: 6) {
                self.editorOverlay
                    .frame(maxWidth: .infinity, alignment: .leading)
                self.sendButton
            }

            if self.showsConnectionPill {
                self.connectionPill
            }
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 4)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(OpenClawChatTheme.composerField)
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(OpenClawChatTheme.composerBorder)))
        .padding(self.editorPadding)
    }

    private var connectionPill: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(self.viewModel.healthOK ? .green : .orange)
                .frame(width: 6, height: 6)
            Text(self.activeSessionLabel)
                .font(.caption2.weight(.semibold))
            Text(self.viewModel.healthOK ? "Connected" : "Connecting…")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 1)
    }

    private var activeSessionLabel: String {
        let match = self.viewModel.sessions.first { $0.key == self.viewModel.sessionKey }
        let trimmed = match?.displayName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? self.viewModel.sessionKey : trimmed
    }

    private var compactModelDisplayLabel: String {
        if self.viewModel.resolvedDisplayedModelSelectionID == nil {
            let defaultLabel = self.viewModel.defaultModelLabel
            let trimmedDefault: String
            if let open = defaultLabel.firstIndex(of: "("),
               let close = defaultLabel.lastIndex(of: ")"),
               open < close
            {
                trimmedDefault = String(defaultLabel[defaultLabel.index(after: open)..<close])
            } else {
                trimmedDefault = defaultLabel
                    .replacingOccurrences(of: "Default:", with: "")
                    .replacingOccurrences(of: "Default", with: "")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
            }
            return Self.compactModelLabel(trimmedDefault)
        }
        let selected =
            self.viewModel.modelChoices.first(where: { $0.selectionID == self.viewModel.resolvedDisplayedModelSelectionID })
                .map { self.viewModel.modelOptionLabel($0) } ??
            self.viewModel.resolvedDisplayedModelSelectionID ??
            self.viewModel.modelSelectionID
        return Self.compactModelLabel(selected)
    }

    private static func compactModelLabel(_ label: String) -> String {
        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "Model" }

        let base = trimmed.split(separator: "/").last.map(String.init) ?? trimmed
        if base.count <= 6 {
            return base
        }
        return String(base.prefix(6))
    }

    @ViewBuilder
    private func modelMenuItem(title: String, isSelected: Bool) -> some View {
        if isSelected {
            Label {
                Text(title)
                    .lineLimit(1)
            } icon: {
                Image(systemName: "checkmark")
            }
        } else {
            Text(title)
                .lineLimit(1)
        }
    }

    private var editorOverlay: some View {
        ZStack(alignment: .topLeading) {
            if self.viewModel.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text("Message OpenClaw…")
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, 4)
                    .padding(.vertical, 4)
                    .allowsHitTesting(false)
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
            .padding(.vertical, 2)
            #else
            ChatComposerTextView(
                text: self.$viewModel.input,
                isFocused: Binding(
                    get: { self.isFocused },
                    set: { self.isFocused = $0 }),
                minHeight: self.textMinHeight,
                maxHeight: self.textMaxHeight,
                onSend: {
                    if self.viewModel.canSend {
                        self.viewModel.send()
                    }
                })
                .frame(minHeight: self.textMinHeight, maxHeight: self.textMaxHeight, alignment: .topLeading)
                .padding(.horizontal, 2)
                .padding(.vertical, 0)
            #endif
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 1)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(OpenClawChatTheme.composerBackground)
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(OpenClawChatTheme.composerBorder.opacity(0.7))))
    }

    private var slashSuggestionsView: some View {
        ScrollView(showsIndicators: true) {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(self.slashSuggestions) { command in
                    Button {
                        self.applySlashSuggestion(command)
                    } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Text("/\(command.name)")
                                .font(.system(.subheadline, design: .monospaced).weight(.semibold))
                                .foregroundStyle(.primary)
                                .frame(width: 128, alignment: .leading)
                            Text(command.description)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        .background(OpenClawChatTheme.subtleCard)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .frame(maxHeight: 176)
        .padding(.horizontal, 2)
        .padding(.top, 2)
        .transition(.opacity.combined(with: .move(edge: .top)))
    }

    private var sendButton: some View {
        Group {
            if self.viewModel.pendingRunCount > 0 {
                Button {
                    self.viewModel.abort()
                } label: {
                    if self.viewModel.isAborting {
                        ProgressView().controlSize(.mini)
                    } else {
                        Image(systemName: "stop.fill")
                            .font(.system(size: 12, weight: .semibold))
                    }
                }
                .buttonStyle(.plain)
                .foregroundStyle(.white)
                .frame(width: 28, height: 28)
                .background(Circle().fill(Color.red))
                .disabled(self.viewModel.isAborting)
            } else {
                Button {
                    self.viewModel.send()
                } label: {
                    if self.viewModel.isSending {
                        ProgressView().controlSize(.mini)
                    } else {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 12, weight: .semibold))
                    }
                }
                .buttonStyle(.plain)
                .foregroundStyle(.white)
                .frame(width: 28, height: 28)
                .background(Circle().fill(Color.accentColor))
                .disabled(!self.viewModel.canSend)
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
        .help("Refresh")
    }

    private var showsToolbar: Bool {
        self.style == .standard
    }

    private var showsAttachments: Bool {
        self.style == .standard
    }

    private var showsConnectionPill: Bool {
        self.style == .standard
    }

    private var composerPadding: CGFloat {
        self.style == .onboarding ? 5 : 6
    }

    private var editorPadding: CGFloat {
        self.style == .onboarding ? 4 : 2
    }

    private var textMinHeight: CGFloat {
        self.style == .onboarding ? 17 : 17
    }

    private var textMaxHeight: CGFloat {
        self.style == .onboarding ? 60 : 84
    }

    private var isComposerCompacted: Bool {
        false
    }

    private var slashSuggestions: [SlashCommandPreset] {
        guard let query = self.activeSlashQuery else { return [] }
        if query.isEmpty {
            return Self.slashCommandPresets
        }
        return Self.slashCommandPresets
            .compactMap { command in
                self.matchScore(for: command, query: query).map { (command, $0) }
            }
            .sorted {
                if $0.1 != $1.1 {
                    return $0.1 < $1.1
                }
                return $0.0.name < $1.0.name
            }
            .map(\.0)
    }

    private var activeSlashQuery: String? {
        let trimmed = self.viewModel.input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("/") else { return nil }
        let commandBody = String(trimmed.dropFirst())
        guard !commandBody.contains(where: \.isWhitespace) else { return nil }
        return commandBody.lowercased()
    }

    private func applySlashSuggestion(_ command: SlashCommandPreset) {
        self.viewModel.input = "/\(command.name) "
    }

    private func matchScore(for command: SlashCommandPreset, query: String) -> Int? {
        if command.name.hasPrefix(query) {
            return 0
        }
        if command.aliases.contains(where: { $0.hasPrefix(query) }) {
            return 1
        }
        if Self.isSubsequence(query, of: command.name) {
            return 2
        }
        if command.aliases.contains(where: { Self.isSubsequence(query, of: $0) }) {
            return 3
        }
        if command.description.localizedCaseInsensitiveContains(query) {
            return 4
        }
        return nil
    }

    private static func isSubsequence(_ needle: String, of haystack: String) -> Bool {
        guard !needle.isEmpty else { return true }
        var currentIndex = haystack.startIndex
        for char in needle {
            guard let matchIndex = haystack[currentIndex...].firstIndex(of: char) else {
                return false
            }
            currentIndex = haystack.index(after: matchIndex)
        }
        return true
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

private struct SlashCommandPreset: Identifiable {
    let name: String
    let description: String
    var aliases: [String] = []

    var id: String { self.name }
}

#if !os(macOS)
private struct ChatComposerTextView: UIViewRepresentable {
    @Binding var text: String
    @Binding var isFocused: Bool
    let minHeight: CGFloat
    let maxHeight: CGFloat
    var onSend: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeUIView(context: Context) -> UITextView {
        let textView = ChatComposerUITextView()
        textView.delegate = context.coordinator
        textView.backgroundColor = .clear
        textView.font = .systemFont(ofSize: 15)
        textView.isEditable = true
        textView.isSelectable = true
        textView.isUserInteractionEnabled = true
        textView.textContainerInset = UIEdgeInsets(top: 0, left: 0, bottom: 0, right: 0)
        textView.textContainer.lineFragmentPadding = 0
        textView.isScrollEnabled = false
        textView.showsVerticalScrollIndicator = false
        textView.showsHorizontalScrollIndicator = false
        textView.returnKeyType = .send
        textView.enablesReturnKeyAutomatically = true
        textView.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        textView.text = self.text
        return textView
    }

    func updateUIView(_ textView: UITextView, context: Context) {
        if textView.text != self.text {
            context.coordinator.isProgrammaticUpdate = true
            textView.text = self.text
            context.coordinator.isProgrammaticUpdate = false
        }

        let fittingSize = CGSize(width: textView.bounds.width > 0 ? textView.bounds.width : UIScreen.main.bounds.width, height: .greatestFiniteMagnitude)
        let measuredHeight = textView.sizeThatFits(fittingSize).height
        textView.isScrollEnabled = measuredHeight > self.maxHeight

        if self.isFocused, !textView.isFirstResponder {
            textView.becomeFirstResponder()
        } else if !self.isFocused, textView.isFirstResponder {
            textView.resignFirstResponder()
        }
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: ChatComposerTextView
        var isProgrammaticUpdate = false

        init(_ parent: ChatComposerTextView) {
            self.parent = parent
        }

        func textViewDidChange(_ textView: UITextView) {
            guard !self.isProgrammaticUpdate else { return }
            self.parent.text = textView.text
        }

        func textView(
            _ textView: UITextView,
            shouldChangeTextIn range: NSRange,
            replacementText text: String)
            -> Bool
        {
            guard text == "\n", textView.markedTextRange == nil else { return true }
            self.parent.onSend()
            return false
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            if !self.parent.isFocused {
                self.parent.isFocused = true
            }
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            if self.parent.isFocused {
                self.parent.isFocused = false
            }
        }
    }
}

private final class ChatComposerUITextView: UITextView {
    override var canBecomeFirstResponder: Bool { true }

    override func paste(_ sender: Any?) {
        super.paste(sender)
    }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        return super.canPerformAction(action, withSender: sender)
    }
}
#endif

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
        let textView = ChatComposerTextViewFactory.makeConfiguredTextView()
        guard let composerTextView = textView as? ChatComposerNSTextView else {
            preconditionFailure("ChatComposerTextViewFactory must return ChatComposerNSTextView")
        }
        composerTextView.delegate = context.coordinator

        composerTextView.string = self.text
        composerTextView.onSend = { [weak composerTextView] in
            composerTextView?.window?.makeFirstResponder(nil)
            self.onSend()
        }
        composerTextView.onPasteImageAttachment = self.onPasteImageAttachment

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

enum ChatComposerTextViewFactory {
    // Internal for @testable import coverage of composer text view defaults.
    @MainActor
    static func makeConfiguredTextView() -> NSTextView {
        let textView = ChatComposerNSTextView()
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
        textView.allowsUndo = true
        textView.minSize = .zero
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.isHorizontallyResizable = false
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        textView.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        textView.textContainer?.widthTracksTextView = true
        return textView
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
