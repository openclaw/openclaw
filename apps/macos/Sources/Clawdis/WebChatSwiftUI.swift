import AppKit
import ClawdisProtocol
import OSLog
import SwiftUI
import UniformTypeIdentifiers

private let webChatSwiftLogger = Logger(subsystem: "com.steipete.clawdis", category: "WebChatSwiftUI")

private enum WebChatSwiftUILayout {
    static let windowSize = NSSize(width: 1120, height: 840)
    static let panelSize = NSSize(width: 480, height: 640)
    static let anchorPadding: CGFloat = 8
}

// MARK: - Models

struct GatewayChatMessageContent: Codable, Hashable {
    let type: String?
    let text: String?
    let mimeType: String?
    let fileName: String?
    let content: String?
}

struct GatewayChatMessage: Codable, Identifiable {
    var id: UUID = .init()
    let role: String
    let content: [GatewayChatMessageContent]
    let timestamp: Double?

    enum CodingKeys: String, CodingKey {
        case role, content, timestamp
    }

    init(
        id: UUID = .init(),
        role: String,
        content: [GatewayChatMessageContent],
        timestamp: Double?
    ) {
        self.id = id
        self.role = role
        self.content = content
        self.timestamp = timestamp
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.role = try container.decode(String.self, forKey: .role)
        self.timestamp = try container.decodeIfPresent(Double.self, forKey: .timestamp)

        if let decoded = try? container.decode([GatewayChatMessageContent].self, forKey: .content) {
            self.content = decoded
            return
        }

        // Some session log formats store `content` as a plain string.
        if let text = try? container.decode(String.self, forKey: .content) {
            self.content = [
                GatewayChatMessageContent(
                    type: "text",
                    text: text,
                    mimeType: nil,
                    fileName: nil,
                    content: nil),
            ]
            return
        }

        self.content = []
    }
}

struct ChatHistoryPayload: Codable {
    let sessionKey: String
    let sessionId: String?
    let messages: [ClawdisProtocol.AnyCodable]?
    let thinkingLevel: String?
}

struct ChatSendResponse: Codable {
    let runId: String
    let status: String
}

struct ChatEventPayload: Codable {
    let runId: String?
    let sessionKey: String?
    let state: String?
    let message: ClawdisProtocol.AnyCodable?
    let errorMessage: String?
}

struct GatewayHealthOK: Codable {
    let ok: Bool?
}

struct PendingAttachment: Identifiable {
    let id = UUID()
    let url: URL?
    let data: Data
    let fileName: String
    let mimeType: String
    let type: String = "file"
    let preview: NSImage?
}

// MARK: - View model

@MainActor
final class WebChatViewModel: ObservableObject {
    @Published var messages: [GatewayChatMessage] = []
    @Published var input: String = ""
    @Published var thinkingLevel: String = "off"
    @Published var isLoading = false
    @Published var isSending = false
    @Published var errorText: String?
    @Published var attachments: [PendingAttachment] = []
    @Published var healthOK: Bool = true
    @Published var pendingRunCount: Int = 0

    let sessionKey: String
    private var eventTask: Task<Void, Never>?
    private var pendingRuns = Set<String>() {
        didSet { self.pendingRunCount = self.pendingRuns.count }
    }
    private var lastHealthPollAt: Date?

    init(sessionKey: String) {
        self.sessionKey = sessionKey
        self.eventTask = Task { [weak self] in
            guard let self else { return }
            let stream = await GatewayConnection.shared.subscribe()
            for await push in stream {
                if Task.isCancelled { return }
                await MainActor.run { [weak self] in
                    self?.handleGatewayPush(push)
                }
            }
        }
    }

    deinit {
        self.eventTask?.cancel()
    }

    func load() {
        Task { await self.bootstrap() }
    }

    func refresh() {
        Task { await self.bootstrap() }
    }

    func send() {
        Task { await self.performSend() }
    }

    func addAttachments(urls: [URL]) {
        Task {
            for url in urls {
                do {
                    let data = try await Task.detached { try Data(contentsOf: url) }.value
                    guard data.count <= 5_000_000 else {
                        await MainActor.run { self.errorText = "Attachment \(url.lastPathComponent) exceeds 5 MB limit" }
                        continue
                    }
                    let uti = UTType(filenameExtension: url.pathExtension) ?? .data
                    guard uti.conforms(to: .image) else {
                        await MainActor.run { self.errorText = "Only image attachments are supported right now" }
                        continue
                    }
                    let mime = uti.preferredMIMEType ?? "application/octet-stream"
                    let preview = NSImage(data: data)
                    let att = PendingAttachment(
                        url: url,
                        data: data,
                        fileName: url.lastPathComponent,
                        mimeType: mime,
                        preview: preview)
                    await MainActor.run { self.attachments.append(att) }
                } catch {
                    await MainActor.run { self.errorText = error.localizedDescription }
                }
            }
        }
    }

    func removeAttachment(_ id: PendingAttachment.ID) {
        self.attachments.removeAll { $0.id == id }
    }

    var canSend: Bool {
        let trimmed = self.input.trimmingCharacters(in: .whitespacesAndNewlines)
        return !self.isSending && (!trimmed.isEmpty || !self.attachments.isEmpty)
    }

    // MARK: Internals

    private func bootstrap() async {
        self.isLoading = true
        defer { self.isLoading = false }
        do {
            let payload = try await self.requestHistory()
            self.messages = payload.messages
            if let level = payload.thinkingLevel, !level.isEmpty {
                self.thinkingLevel = level
            }
            await self.pollHealthIfNeeded(force: true)
        } catch {
            self.errorText = error.localizedDescription
            webChatSwiftLogger.error("bootstrap failed \(error.localizedDescription, privacy: .public)")
        }
    }

    private func performSend() async {
        guard !self.isSending else { return }
        let trimmed = self.input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !self.attachments.isEmpty else { return }

        guard self.healthOK else {
            self.errorText = "Gateway health not OK; cannot send"
            return
        }

        self.isSending = true
        self.errorText = nil
        let runId = UUID().uuidString
        let messageText = trimmed.isEmpty && !self.attachments.isEmpty ? "See attached." : trimmed

        // Optimistically append user message to UI
        var userContent: [GatewayChatMessageContent] = [
            GatewayChatMessageContent(
                type: "text",
                text: messageText,
                mimeType: nil,
                fileName: nil,
                content: nil),
        ]
        for att in self.attachments {
            userContent.append(
                GatewayChatMessageContent(
                    type: att.type,
                    text: nil,
                    mimeType: att.mimeType,
                    fileName: att.fileName,
                    content: att.data.base64EncodedString()))
        }

        let userMessage = GatewayChatMessage(
            id: UUID(),
            role: "user",
            content: userContent,
            timestamp: Date().timeIntervalSince1970 * 1000)
        self.messages.append(userMessage)

        let encodedAttachments = self.attachments.map { att in
            [
                "type": att.type,
                "mimeType": att.mimeType,
                "fileName": att.fileName,
                "content": att.data.base64EncodedString(),
            ]
        }

        do {
            var params: [String: AnyCodable] = [
                "sessionKey": AnyCodable(self.sessionKey),
                "message": AnyCodable(messageText),
                "thinking": AnyCodable(self.thinkingLevel),
                "idempotencyKey": AnyCodable(runId),
                "timeoutMs": AnyCodable(30000),
            ]
            if !encodedAttachments.isEmpty {
                params["attachments"] = AnyCodable(encodedAttachments)
            }
            let data = try await GatewayConnection.shared.request(method: "chat.send", params: params)
            let response = try JSONDecoder().decode(ChatSendResponse.self, from: data)
            self.pendingRuns.insert(response.runId)
        } catch {
            self.errorText = error.localizedDescription
            webChatSwiftLogger.error("chat.send failed \(error.localizedDescription, privacy: .public)")
        }

        self.input = ""
        self.attachments = []
        self.isSending = false
    }

    private func requestHistory() async throws -> (messages: [GatewayChatMessage], thinkingLevel: String?) {
        let data = try await GatewayConnection.shared.request(
            method: "chat.history",
            params: ["sessionKey": AnyCodable(self.sessionKey)])
        let payload = try JSONDecoder().decode(ChatHistoryPayload.self, from: data)
        let messages: [GatewayChatMessage] = (payload.messages ?? []).compactMap { raw in
            (try? GatewayPayloadDecoding.decode(raw, as: GatewayChatMessage.self))
        }
        return (messages, payload.thinkingLevel)
    }

    private func handleGatewayPush(_ push: GatewayPush) {
        switch push {
        case let .snapshot(hello):
            let health = try? GatewayPayloadDecoding.decode(hello.snapshot.health, as: GatewayHealthOK.self)
            self.healthOK = health?.ok ?? true
        case let .event(evt):
            self.handleGatewayEvent(evt)
        case .seqGap:
            self.errorText = "Event stream interrupted; try refreshing."
        }
    }

    private func handleGatewayEvent(_ evt: EventFrame) {
        if evt.event == "health", let payload = evt.payload,
           let ok = (try? GatewayPayloadDecoding.decode(payload, as: GatewayHealthOK.self))?.ok
        {
            self.healthOK = ok
            return
        }

        if evt.event == "tick" {
            Task { await self.pollHealthIfNeeded(force: false) }
            return
        }

        guard evt.event == "chat" else { return }
        guard let payload = evt.payload else { return }
        guard let chat = try? GatewayPayloadDecoding.decode(payload, as: ChatEventPayload.self) else { return }
        guard chat.sessionKey == nil || chat.sessionKey == self.sessionKey else { return }

        if let runId = chat.runId, !self.pendingRuns.contains(runId) {
            // Ignore events for other runs
            return
        }

        switch chat.state {
        case "final":
            if let raw = chat.message,
               let msg = try? GatewayPayloadDecoding.decode(raw, as: GatewayChatMessage.self)
            {
                self.messages.append(msg)
            }
            if let runId = chat.runId {
                self.pendingRuns.remove(runId)
            }
        case "error":
            self.errorText = chat.errorMessage ?? "Chat failed"
            if let runId = chat.runId {
                self.pendingRuns.remove(runId)
            }
        default:
            break
        }
    }

    private func pollHealthIfNeeded(force: Bool) async {
        if !force, let last = self.lastHealthPollAt, Date().timeIntervalSince(last) < 10 {
            return
        }
        self.lastHealthPollAt = Date()
        do {
            let data = try await GatewayConnection.shared.request(method: "health", params: nil, timeoutMs: 5000)
            let ok = (try? JSONDecoder().decode(GatewayHealthOK.self, from: data))?.ok ?? true
            self.healthOK = ok
        } catch {
            self.healthOK = false
        }
    }
}

// MARK: - View

struct WebChatView: View {
    @StateObject var viewModel: WebChatViewModel
    @State private var scrollerBottomID = UUID()
    var body: some View {
        ZStack {
            Color(nsColor: .windowBackgroundColor)
                .ignoresSafeArea()

            VStack(spacing: 14) {
                self.header
                self.messageList
                self.composer
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 16)
            .frame(maxWidth: 1040)
        }
        .background(
            LinearGradient(
                colors: [
                    Color(red: 0.96, green: 0.97, blue: 1.0),
                    Color(red: 0.93, green: 0.94, blue: 0.98),
                ],
                startPoint: .top,
                endPoint: .bottom)
                .opacity(0.35)
                .ignoresSafeArea())
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .onAppear { self.viewModel.load() }
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("Clawd Chat")
                    .font(.title2.weight(.semibold))
                Text(
                    "Session \(self.viewModel.sessionKey) · \(self.viewModel.healthOK ? "Connected" : "Connecting…")")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if self.viewModel.isLoading {
                ProgressView().controlSize(.small)
            } else {
                Circle()
                    .fill(self.viewModel.healthOK ? Color.green.opacity(0.7) : Color.orange)
                    .frame(width: 10, height: 10)
            }
            Button {
                self.viewModel.refresh()
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.borderless)
            .help("Refresh history")
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color(nsColor: .textBackgroundColor))
                .shadow(color: .black.opacity(0.06), radius: 10, y: 4))
    }

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if self.viewModel.messages.isEmpty {
                        VStack(spacing: 10) {
                            Image(systemName: "bubble.left.and.bubble.right.fill")
                                .font(.system(size: 34, weight: .semibold))
                                .foregroundStyle(Color.accentColor.opacity(0.9))
                            Text("Say hi to Clawd")
                                .font(.headline)
                            Text(self.viewModel.healthOK ? "This is the native SwiftUI debug chat." : "Connecting to the gateway…")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        .padding(18)
                        .frame(maxWidth: .infinity)
                        .background(
                            RoundedRectangle(cornerRadius: 18, style: .continuous)
                                .fill(Color.white.opacity(0.06)))
                        .padding(.vertical, 34)
                    } else {
                        ForEach(self.viewModel.messages) { msg in
                            MessageBubble(message: msg)
                                .frame(maxWidth: .infinity, alignment: msg.role.lowercased() == "user" ? .trailing : .leading)
                        }
                    }

                    if self.viewModel.pendingRunCount > 0 {
                        TypingIndicatorBubble()
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .transition(.opacity)
                    }

                    Color.clear
                        .frame(height: 1)
                        .id(self.scrollerBottomID)
                }
                .padding(.vertical, 10)
                .padding(.horizontal, 12)
            }
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(Color(nsColor: .textBackgroundColor))
                    .shadow(color: .black.opacity(0.05), radius: 12, y: 6))
            .onChange(of: self.viewModel.messages.count) { _, _ in
                withAnimation(.snappy(duration: 0.22)) {
                    proxy.scrollTo(self.scrollerBottomID, anchor: .bottom)
                }
            }
            .onChange(of: self.viewModel.pendingRunCount) { _, _ in
                withAnimation(.snappy(duration: 0.22)) {
                    proxy.scrollTo(self.scrollerBottomID, anchor: .bottom)
                }
            }
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                self.thinkingPicker
                Spacer()
                Button {
                    self.pickFiles()
                } label: {
                    Label("Add Image", systemImage: "paperclip")
                }
                .buttonStyle(.bordered)
            }
            if !self.viewModel.attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(self.viewModel.attachments) { att in
                            HStack(spacing: 6) {
                                if let img = att.preview {
                                    Image(nsImage: img)
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
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .padding(.horizontal, 10)
                            .background(Color.accentColor.opacity(0.08))
                            .clipShape(Capsule())
                        }
                    }
                }
            }
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color.secondary.opacity(0.2))
                .background(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(Color(nsColor: .textBackgroundColor)))
                .overlay(
                    ZStack(alignment: .topLeading) {
                        if self.viewModel.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            Text("Message Clawd…")
                                .foregroundStyle(.tertiary)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 10)
                        }
                        ComposerTextView(text: self.$viewModel.input) {
                            self.viewModel.send()
                        }
                        .frame(minHeight: 54, maxHeight: 160)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                    })
                .frame(maxHeight: 180)

            HStack {
                if let error = self.viewModel.errorText {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
                Spacer()
                Button {
                    self.viewModel.send()
                } label: {
                    Label(self.viewModel.isSending ? "Sending…" : "Send", systemImage: "arrow.up.circle.fill")
                        .font(.headline)
                }
                .buttonStyle(.borderedProminent)
                .disabled(!self.viewModel.canSend)
            }
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color(nsColor: .textBackgroundColor))
                .shadow(color: .black.opacity(0.06), radius: 12, y: 6))
        .onDrop(of: [.fileURL], isTargeted: nil) { providers in
            self.handleDrop(providers)
        }
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
        .frame(maxWidth: 200)
    }

    private func pickFiles() {
        let panel = NSOpenPanel()
        panel.title = "Select image attachments"
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.image]
        panel.begin { resp in
            guard resp == .OK else { return }
            let urls = panel.urls
            self.viewModel.addAttachments(urls: urls)
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
                Task { await self.viewModel.addAttachments(urls: [url]) }
            }
        }
        return true
    }
}

private struct MessageBubble: View {
    let message: GatewayChatMessage

    var body: some View {
        VStack(alignment: self.isUser ? .trailing : .leading, spacing: 8) {
            HStack(spacing: 8) {
                if !self.isUser {
                    Label("Assistant", systemImage: "sparkles")
                        .labelStyle(.titleAndIcon)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                if self.isUser {
                    Label("You", systemImage: "person.fill")
                        .labelStyle(.titleAndIcon)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            ChatMessageBody(message: self.message, isUser: self.isUser)
                .frame(maxWidth: WebChatSwiftUITheme.bubbleMaxWidth, alignment: self.isUser ? .trailing : .leading)
        }
        .padding(.horizontal, 2)
    }

    private var isUser: Bool { self.message.role.lowercased() == "user" }
}

private enum WebChatSwiftUITheme {
    static let bubbleMaxWidth: CGFloat = 760
    static let bubbleCorner: CGFloat = 16
}

private struct ChatMessageBody: View {
    let message: GatewayChatMessage
    let isUser: Bool

    var body: some View {
        let text = self.primaryText
        let split = MarkdownSplitter.split(markdown: text)

        VStack(alignment: .leading, spacing: 10) {
            ForEach(split.blocks) { block in
                switch block.kind {
                case .text:
                    MarkdownTextView(text: block.text)
                case .code(let language):
                    CodeBlockView(code: block.text, language: language)
                }
            }

            if !split.images.isEmpty {
                ForEach(split.images) { item in
                    if let img = item.image {
                        Image(nsImage: img)
                            .resizable()
                            .scaledToFit()
                            .frame(maxHeight: 260)
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: 12, style: .continuous)
                                    .strokeBorder(Color.white.opacity(0.12), lineWidth: 1))
                    } else {
                        Text(item.label.isEmpty ? "Image" : item.label)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            if !self.inlineAttachments.isEmpty {
                ForEach(self.inlineAttachments.indices, id: \.self) { idx in
                    AttachmentRow(att: self.inlineAttachments[idx])
                }
            }
        }
        .textSelection(.enabled)
        .padding(12)
        .background(self.bubbleBackground)
        .overlay(self.bubbleBorder)
        .clipShape(RoundedRectangle(cornerRadius: WebChatSwiftUITheme.bubbleCorner, style: .continuous))
    }

    private var primaryText: String {
        let parts = self.message.content.compactMap(\.text)
        return parts.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var inlineAttachments: [GatewayChatMessageContent] {
        self.message.content.filter { ($0.type ?? "text") != "text" }
    }

    private var bubbleBackground: AnyShapeStyle {
        if self.isUser {
            return AnyShapeStyle(
                LinearGradient(
                    colors: [
                        Color.orange.opacity(0.22),
                        Color.accentColor.opacity(0.18),
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing))
        }
        return AnyShapeStyle(Color(nsColor: .textBackgroundColor).opacity(0.55))
    }

    private var bubbleBorder: some View {
        RoundedRectangle(cornerRadius: WebChatSwiftUITheme.bubbleCorner, style: .continuous)
            .strokeBorder(
                self.isUser ? Color.orange.opacity(0.35) : Color.white.opacity(0.10),
                lineWidth: 1)
    }
}

private struct AttachmentRow: View {
    let att: GatewayChatMessageContent

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "paperclip")
            Text(att.fileName ?? "Attachment")
                .font(.footnote)
                .lineLimit(1)
            Spacer()
        }
        .padding(10)
        .background(Color.white.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

private struct TypingIndicatorBubble: View {
    var body: some View {
        HStack(spacing: 10) {
            TypingDots()
            Text("Clawd is thinking…")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color(nsColor: .textBackgroundColor).opacity(0.55)))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Color.white.opacity(0.10), lineWidth: 1))
        .frame(maxWidth: WebChatSwiftUITheme.bubbleMaxWidth, alignment: .leading)
    }
}

private struct TypingDots: View {
    @State private var phase: Double = 0

    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<3, id: \.self) { idx in
                Circle()
                    .fill(Color.secondary.opacity(0.55))
                    .frame(width: 7, height: 7)
                    .scaleEffect(self.dotScale(idx))
            }
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) {
                self.phase = 1
            }
        }
    }

    private func dotScale(_ idx: Int) -> CGFloat {
        let base = 0.85 + (self.phase * 0.35)
        let offset = Double(idx) * 0.15
        return CGFloat(base - offset)
    }
}

private struct MarkdownTextView: View {
    let text: String

    var body: some View {
        if let attributed = try? AttributedString(markdown: self.text) {
            Text(attributed)
                .font(.system(size: 14))
                .foregroundStyle(.primary)
        } else {
            Text(self.text)
                .font(.system(size: 14))
                .foregroundStyle(.primary)
        }
    }
}

private struct CodeBlockView: View {
    let code: String
    let language: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let language, !language.isEmpty {
                Text(language)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
            }
            Text(self.code)
                .font(.system(size: 13, weight: .regular, design: .monospaced))
                .foregroundStyle(.primary)
                .textSelection(.enabled)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.black.opacity(0.06))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color.white.opacity(0.10), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

private enum MarkdownSplitter {
    struct InlineImage: Identifiable {
        let id = UUID()
        let label: String
        let image: NSImage?
    }

    struct Block: Identifiable {
        enum Kind: Equatable {
            case text
            case code(language: String?)
        }

        let id = UUID()
        let kind: Kind
        let text: String
    }

    struct SplitResult {
        let blocks: [Block]
        let images: [InlineImage]
    }

    static func split(markdown raw: String) -> SplitResult {
        let extracted = self.extractInlineImages(from: raw)
        let blocks = self.splitCodeBlocks(from: extracted.cleaned)
        return SplitResult(blocks: blocks, images: extracted.images)
    }

    private static func splitCodeBlocks(from raw: String) -> [Block] {
        var blocks: [Block] = []
        var buffer: [String] = []
        var inCode = false
        var codeLang: String?
        var codeLines: [String] = []

        for line in raw.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            if line.hasPrefix("```") {
                if inCode {
                    blocks.append(Block(kind: .code(language: codeLang), text: codeLines.joined(separator: "\n")))
                    codeLines.removeAll(keepingCapacity: true)
                    inCode = false
                    codeLang = nil
                } else {
                    let text = buffer.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
                    if !text.isEmpty {
                        blocks.append(Block(kind: .text, text: text))
                    }
                    buffer.removeAll(keepingCapacity: true)
                    inCode = true
                    codeLang = line.dropFirst(3).trimmingCharacters(in: .whitespacesAndNewlines)
                    if codeLang?.isEmpty == true { codeLang = nil }
                }
                continue
            }

            if inCode {
                codeLines.append(line)
            } else {
                buffer.append(line)
            }
        }

        if inCode {
            blocks.append(Block(kind: .code(language: codeLang), text: codeLines.joined(separator: "\n")))
        } else {
            let text = buffer.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty {
                blocks.append(Block(kind: .text, text: text))
            }
        }

        return blocks.isEmpty ? [Block(kind: .text, text: raw)] : blocks
    }

    private static func extractInlineImages(from raw: String) -> (cleaned: String, images: [InlineImage]) {
        let pattern = #"!\[([^\]]*)\]\((data:image\/[^;]+;base64,[^)]+)\)"#
        guard let re = try? NSRegularExpression(pattern: pattern) else {
            return (raw, [])
        }

        let ns = raw as NSString
        let matches = re.matches(in: raw, range: NSRange(location: 0, length: ns.length))
        if matches.isEmpty { return (raw, []) }

        var images: [InlineImage] = []
        var cleaned = raw

        for match in matches.reversed() {
            guard match.numberOfRanges >= 3 else { continue }
            let label = ns.substring(with: match.range(at: 1))
            let dataURL = ns.substring(with: match.range(at: 2))

            let image: NSImage? = {
                guard let comma = dataURL.firstIndex(of: ",") else { return nil }
                let b64 = String(dataURL[dataURL.index(after: comma)...])
                guard let data = Data(base64Encoded: b64) else { return nil }
                return NSImage(data: data)
            }()
            images.append(InlineImage(label: label, image: image))

            let start = cleaned.index(cleaned.startIndex, offsetBy: match.range.location)
            let end = cleaned.index(start, offsetBy: match.range.length)
            cleaned.replaceSubrange(start..<end, with: "")
        }

        let normalized = cleaned
            .replacingOccurrences(of: "\n\n\n", with: "\n\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return (normalized, images.reversed())
    }
}

private struct ComposerTextView: NSViewRepresentable {
    @Binding var text: String
    var onSend: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let textView = ComposerNSTextView()
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
        textView.textContainerInset = NSSize(width: 2, height: 8)
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
        guard let textView = scrollView.documentView as? ComposerNSTextView else { return }
        let isEditing = scrollView.window?.firstResponder == textView
        if isEditing { return }

        if textView.string != self.text {
            context.coordinator.isProgrammaticUpdate = true
            defer { context.coordinator.isProgrammaticUpdate = false }
            textView.string = self.text
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ComposerTextView
        var isProgrammaticUpdate = false

        init(_ parent: ComposerTextView) { self.parent = parent }

        func textDidChange(_ notification: Notification) {
            guard !self.isProgrammaticUpdate else { return }
            guard let view = notification.object as? NSTextView else { return }
            guard view.window?.firstResponder === view else { return }
            self.parent.text = view.string
        }
    }
}

private final class ComposerNSTextView: NSTextView {
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

// MARK: - Window controller

@MainActor
final class WebChatSwiftUIWindowController {
    private let presentation: WebChatPresentation
    private let sessionKey: String
    private let hosting: NSHostingController<WebChatView>
    private var window: NSWindow?
    private var dismissMonitor: Any?
    var onClosed: (() -> Void)?
    var onVisibilityChanged: ((Bool) -> Void)?

    init(sessionKey: String, presentation: WebChatPresentation) {
        self.sessionKey = sessionKey
        self.presentation = presentation
        let vm = WebChatViewModel(sessionKey: sessionKey)
        self.hosting = NSHostingController(rootView: WebChatView(viewModel: vm))
        self.window = Self.makeWindow(for: presentation, contentViewController: self.hosting)
    }

    deinit {}

    var isVisible: Bool {
        self.window?.isVisible ?? false
    }

    func show() {
        guard let window else { return }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.onVisibilityChanged?(true)
    }

    func presentAnchored(anchorProvider: () -> NSRect?) {
        guard case .panel = self.presentation, let window else { return }
        self.reposition(using: anchorProvider)
        self.installDismissMonitor()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.onVisibilityChanged?(true)
    }

    func close() {
        self.window?.orderOut(nil)
        self.onVisibilityChanged?(false)
        self.onClosed?()
        self.removeDismissMonitor()
    }

    private func reposition(using anchorProvider: () -> NSRect?) {
        guard let window else { return }
        guard let anchor = anchorProvider() else { return }
        let screen = NSScreen.screens.first { screen in
            screen.frame.contains(anchor.origin) || screen.frame.contains(NSPoint(x: anchor.midX, y: anchor.midY))
        } ?? NSScreen.main
        var frame = window.frame
        if let screen {
            let minX = screen.frame.minX + WebChatSwiftUILayout.anchorPadding
            let maxX = screen.frame.maxX - frame.width - WebChatSwiftUILayout.anchorPadding
            frame.origin.x = min(max(round(anchor.midX - frame.width / 2), minX), maxX)
            let desiredY = anchor.minY - frame.height - WebChatSwiftUILayout.anchorPadding
            frame.origin.y = max(desiredY, screen.frame.minY + WebChatSwiftUILayout.anchorPadding)
        } else {
            frame.origin.x = round(anchor.midX - frame.width / 2)
            frame.origin.y = anchor.minY - frame.height
        }
        window.setFrame(frame, display: false)
    }

    private func installDismissMonitor() {
        guard self.dismissMonitor == nil, self.window != nil else { return }
        self.dismissMonitor = NSEvent.addGlobalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown])
        { [weak self] _ in
            guard let self, let win = self.window else { return }
            let pt = NSEvent.mouseLocation
            if !win.frame.contains(pt) {
                self.close()
            }
        }
    }

    private func removeDismissMonitor() {
        if let monitor = self.dismissMonitor {
            NSEvent.removeMonitor(monitor)
            self.dismissMonitor = nil
        }
    }

    private static func makeWindow(
        for presentation: WebChatPresentation,
        contentViewController: NSViewController) -> NSWindow
    {
        switch presentation {
        case .window:
            let window = NSWindow(
                contentRect: NSRect(origin: .zero, size: WebChatSwiftUILayout.windowSize),
                styleMask: [.titled, .closable, .resizable, .miniaturizable],
                backing: .buffered,
                defer: false)
            window.title = "Clawdis Chat (SwiftUI)"
            window.contentViewController = contentViewController
            window.isReleasedWhenClosed = false
            window.titleVisibility = .visible
            window.titlebarAppearsTransparent = false
            window.backgroundColor = .windowBackgroundColor
            window.isOpaque = true
            window.center()
            window.minSize = NSSize(width: 880, height: 680)
            return window
        case .panel:
            let panel = WebChatPanel(
                contentRect: NSRect(origin: .zero, size: WebChatSwiftUILayout.panelSize),
                styleMask: [.borderless],
                backing: .buffered,
                defer: false)
            panel.level = .statusBar
            panel.hidesOnDeactivate = true
            panel.hasShadow = true
            panel.isMovable = false
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            panel.titleVisibility = .hidden
            panel.titlebarAppearsTransparent = true
            panel.backgroundColor = .clear
            panel.isOpaque = false
            panel.contentViewController = contentViewController
            panel.becomesKeyOnlyIfNeeded = true
            return panel
        }
    }
}
