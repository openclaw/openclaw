import Foundation
import Observation
import SwiftUI

#if !os(macOS)
import PhotosUI
import UniformTypeIdentifiers
#endif

@MainActor
struct ClawdisChatComposer: View {
    @Bindable var viewModel: ClawdisChatViewModel
    let style: ClawdisChatView.Style

    #if !os(macOS)
    @State private var pickerItems: [PhotosPickerItem] = []
    @FocusState private var isFocused: Bool
    #endif

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if self.showsToolbar {
                HStack(spacing: 6) {
                    self.thinkingPicker
                    Spacer()
                    self.refreshButton
                    self.attachmentPicker
                }
            }

            if self.showsAttachments, !self.viewModel.attachments.isEmpty {
                self.attachmentsStrip
            }

            self.editor

            if let error = self.viewModel.errorText, !error.isEmpty {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .lineLimit(2)
            }
        }
        .padding(self.composerPadding)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(ClawdisChatTheme.composerBackground)
                .shadow(color: .black.opacity(0.08), radius: 10, y: 4))
        #if os(macOS)
            .onDrop(of: [.fileURL], isTargeted: nil) { providers in
                self.handleDrop(providers)
            }
        #endif
    }

    private var thinkingPicker: some View {
        Picker("Thinking", selection: self.$viewModel.thinkingLevel) {
            Text("Off").tag("off")
            Text("Low").tag("low")
            Text("Medium").tag("medium")
            Text("High").tag("high")
        }
        .labelsHidden()
        .pickerStyle(.menu)
        .controlSize(.small)
        .frame(maxWidth: 140, alignment: .leading)
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
                    id: \ClawdisPendingAttachment.id)
                { (att: ClawdisPendingAttachment) in
                    HStack(spacing: 6) {
                        if let img = att.preview {
                            ClawdisPlatformImageFactory.image(img)
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
        RoundedRectangle(cornerRadius: 12, style: .continuous)
            .strokeBorder(ClawdisChatTheme.composerBorder)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(ClawdisChatTheme.composerField))
            .overlay {
                VStack(alignment: .leading, spacing: 4) {
                    self.editorOverlay
                    HStack(alignment: .bottom, spacing: 6) {
                        if self.showsConnectionPill {
                            self.connectionPill
                        }
                        Spacer(minLength: 0)
                        self.sendButton
                    }
                }
            }
            .padding(self.editorPadding)
            .frame(
                minHeight: self.editorMinHeight,
                idealHeight: self.editorMinHeight,
                maxHeight: self.editorMaxHeight)
    }

    private var connectionPill: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(self.viewModel.healthOK ? .green : .orange)
                .frame(width: 7, height: 7)
            Text(self.viewModel.sessionKey)
                .font(.caption2.weight(.semibold))
            Text(self.viewModel.healthOK ? "Connected" : "Connecting…")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(ClawdisChatTheme.subtleCard)
        .clipShape(Capsule())
    }

    private var editorOverlay: some View {
        ZStack(alignment: .topLeading) {
            if self.viewModel.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text("Message Clawd…")
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, 4)
                    .padding(.vertical, 4)
            }

            #if os(macOS)
            ChatComposerTextView(text: self.$viewModel.input) {
                self.viewModel.send()
            }
            .frame(minHeight: self.textMinHeight, idealHeight: self.textMinHeight, maxHeight: self.textMaxHeight)
            .padding(.horizontal, 4)
            .padding(.vertical, 3)
            #else
            TextEditor(text: self.$viewModel.input)
                .font(.system(size: 15))
                .scrollContentBackground(.hidden)
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
                    if self.viewModel.isAborting {
                        ProgressView().controlSize(.mini)
                    } else {
                        Image(systemName: "stop.fill")
                            .font(.system(size: 13, weight: .semibold))
                    }
                }
                .buttonStyle(.plain)
                .foregroundStyle(.white)
                .padding(6)
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
                            .font(.system(size: 13, weight: .semibold))
                    }
                }
                .buttonStyle(.plain)
                .foregroundStyle(.white)
                .padding(6)
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
        self.style == .onboarding ? 5 : 6
    }

    private var editorMinHeight: CGFloat {
        self.style == .onboarding ? 34 : 40
    }

    private var editorMaxHeight: CGFloat {
        self.style == .onboarding ? 60 : 84
    }

    private var textMinHeight: CGFloat {
        self.style == .onboarding ? 24 : 28
    }

    private var textMaxHeight: CGFloat {
        self.style == .onboarding ? 52 : 64
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
    var onSend: () -> Void

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
        let isEditing = scrollView.window?.firstResponder == textView
        if isEditing { return }

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

    override func keyDown(with event: NSEvent) {
        let isReturn = event.keyCode == 36
        if isReturn {
            if event.modifierFlags.contains(.shift) {
                super.insertNewline(nil)
                return
            }
            self.onSend?()
            return
        }
        super.keyDown(with: event)
    }
}
#endif
