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

struct GatewayChatMessageContent: Codable {
    let type: String?
    let text: String?
    let mimeType: String?
    let fileName: String?
    let content: String?
}

struct GatewayChatMessage: Codable, Identifiable {
    var id: UUID = .init()
    let role: String
    let content: [GatewayChatMessageContent]?
    let timestamp: Double?

    enum CodingKeys: String, CodingKey {
        case role, content, timestamp
    }
}

struct ChatHistoryPayload: Codable {
    let sessionKey: String
    let sessionId: String?
    let messages: [GatewayChatMessage]?
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
    let message: GatewayChatMessage?
    let errorMessage: String?
}

struct PendingAttachment: Identifiable {
    let id = UUID()
    let url: URL?
    let data: Data
    let fileName: String
    let mimeType: String
    let type: String = "file"
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

    private let sessionKey: String
    private var eventTask: Task<Void, Never>?
    private var pendingRuns = Set<String>()

    init(sessionKey: String) {
        self.sessionKey = sessionKey
        self.eventTask = Task { [weak self] in
            guard let self else { return }
            let stream = await GatewayConnection.shared.subscribe()
            for await push in stream {
                if Task.isCancelled { return }
                guard case let .event(evt) = push else { continue }
                await MainActor.run { [weak self] in
                    self?.handleGatewayEvent(evt)
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

    func send() {
        Task { await self.performSend() }
    }

    func addAttachments(urls: [URL]) {
        Task {
            for url in urls {
                guard let data = try? Data(contentsOf: url) else { continue }
                guard data.count <= 5_000_000 else {
                    await MainActor.run { self.errorText = "Attachment \(url.lastPathComponent) exceeds 5 MB limit" }
                    continue
                }
                let uti = UTType(filenameExtension: url.pathExtension) ?? .data
                let mime = uti.preferredMIMEType ?? "application/octet-stream"
                let att = PendingAttachment(
                    url: url,
                    data: data,
                    fileName: url.lastPathComponent,
                    mimeType: mime)
                await MainActor.run { self.attachments.append(att) }
            }
        }
    }

    func removeAttachment(_ id: PendingAttachment.ID) {
        self.attachments.removeAll { $0.id == id }
    }

    // MARK: Internals

    private func bootstrap() async {
        self.isLoading = true
        defer { self.isLoading = false }
        do {
            let payload = try await self.requestHistory()
            self.messages = payload.messages ?? []
            if let level = payload.thinkingLevel, !level.isEmpty {
                self.thinkingLevel = level
            }
        } catch {
            self.errorText = error.localizedDescription
            webChatSwiftLogger.error("bootstrap failed \(error.localizedDescription, privacy: .public)")
        }
    }

    private func performSend() async {
        guard !self.isSending else { return }
        let trimmed = self.input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !self.attachments.isEmpty else { return }

        self.isSending = true
        self.errorText = nil
        let runId = UUID().uuidString

        // Optimistically append user message to UI
        let userMessage = GatewayChatMessage(
            id: UUID(),
            role: "user",
            content: [
                GatewayChatMessageContent(
                    type: "text",
                    text: trimmed,
                    mimeType: nil,
                    fileName: nil,
                    content: nil)
            ],
            timestamp: Date().timeIntervalSince1970 * 1000)
        self.messages.append(userMessage)

        let encodedAttachments = self.attachments.map { att in
            [
                "type": att.type,
                "mimeType": att.mimeType,
                "fileName": att.fileName,
                "content": att.data.base64EncodedString()
            ]
        }

        do {
            let attachmentsPayload: [[String: String]]? = encodedAttachments.isEmpty ? nil : encodedAttachments
            let params: [String: AnyCodable] = [
                "sessionKey": AnyCodable(self.sessionKey),
                "message": AnyCodable(trimmed),
                "attachments": AnyCodable(attachmentsPayload as Any),
                "thinking": AnyCodable(self.thinkingLevel),
                "idempotencyKey": AnyCodable(runId),
                "timeoutMs": AnyCodable(30_000)
            ]
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

    private func requestHistory() async throws -> ChatHistoryPayload {
        let data = try await GatewayConnection.shared.request(
            method: "chat.history",
            params: ["sessionKey": AnyCodable(self.sessionKey)])
        return try JSONDecoder().decode(ChatHistoryPayload.self, from: data)
    }

    private func handleGatewayEvent(_ evt: EventFrame) {
        guard evt.event == "chat" else { return }
        guard let payload = evt.payload else { return }
        guard let data = try? JSONEncoder().encode(payload) else { return }
        guard let chat = try? JSONDecoder().decode(ChatEventPayload.self, from: data) else { return }
        guard chat.sessionKey == nil || chat.sessionKey == self.sessionKey else { return }

        if let runId = chat.runId, !self.pendingRuns.contains(runId) {
            // Ignore events for other runs
            return
        }

        switch chat.state {
        case "final":
            if let msg = chat.message {
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
}

// MARK: - View

struct WebChatView: View {
    @StateObject var viewModel: WebChatViewModel
    var body: some View {
        ZStack {
            Color(nsColor: .windowBackgroundColor)
                .ignoresSafeArea()

            VStack(spacing: 14) {
                header
                messageList
                composer
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 16)
            .frame(maxWidth: 1040)
        }
        .background(
            LinearGradient(
                colors: [
                    Color(red: 0.96, green: 0.97, blue: 1.0),
                    Color(red: 0.93, green: 0.94, blue: 0.98)
                ],
                startPoint: .top,
                endPoint: .bottom)
                .opacity(0.35)
                .ignoresSafeArea()
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .onAppear { viewModel.load() }
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("Clawd Web Chat")
                    .font(.title2.weight(.semibold))
                Text("Session \(self.viewModel.thinkingLevel.uppercased()) · \(self.viewModel.healthOK ? "Connected" : "Connecting…")")
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
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color(nsColor: .textBackgroundColor))
                .shadow(color: .black.opacity(0.06), radius: 10, y: 4)
        )
    }

    private var messageList: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                ForEach(self.viewModel.messages) { msg in
                    MessageBubble(message: msg)
                }
            }
            .padding(.vertical, 8)
        }
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color(nsColor: .textBackgroundColor))
                .shadow(color: .black.opacity(0.05), radius: 12, y: 6)
        )
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                thinkingPicker
                Spacer()
                Button {
                    self.pickFiles()
                } label: {
                    Label("Add File", systemImage: "paperclip")
                }
                .buttonStyle(.bordered)
            }
            if !self.viewModel.attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(self.viewModel.attachments) { att in
                            HStack(spacing: 6) {
                                Image(systemName: "doc")
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
                        .fill(Color(nsColor: .textBackgroundColor))
                )
                .overlay(
                    TextEditor(text: self.$viewModel.input)
                        .font(.body)
                        .background(Color.clear)
                        .frame(minHeight: 96, maxHeight: 168)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                )
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
                .disabled(self.viewModel.isSending)
            }
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color(nsColor: .textBackgroundColor))
                .shadow(color: .black.opacity(0.06), radius: 12, y: 6)
        )
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
        panel.title = "Select attachments"
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
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
        VStack(alignment: self.isUser ? .trailing : .leading, spacing: 6) {
            HStack {
                if !self.isUser { Text("Assistant").font(.caption).foregroundStyle(.secondary) }
                Spacer()
                if self.isUser { Text("You").font(.caption).foregroundStyle(.secondary) }
            }
            VStack(alignment: .leading, spacing: 6) {
                if let text = self.primaryText {
                    Text(text)
                        .font(.body)
                        .foregroundColor(.primary)
                        .multilineTextAlignment(self.isUser ? .trailing : .leading)
                }
                if let attachments = self.attachments {
                    ForEach(attachments.indices, id: \.self) { idx in
                        let att = attachments[idx]
                        HStack(spacing: 6) {
                            Image(systemName: "paperclip")
                            Text(att.fileName ?? "Attachment")
                                .font(.footnote)
                                .lineLimit(1)
                        }
                        .padding(8)
                        .background(Color.white.opacity(0.08))
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: self.isUser ? .trailing : .leading)
            .padding(12)
            .background(self.isUser ? Color.accentColor.opacity(0.12) : Color(nsColor: .textBackgroundColor))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(self.isUser ? Color.accentColor.opacity(0.35) : Color.secondary.opacity(0.15))
            )
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .padding(.horizontal, 6)
    }

    private var isUser: Bool { self.message.role.lowercased() == "user" }

    private var primaryText: String? {
        self.message.content?
            .compactMap { $0.text }
            .joined(separator: "\n")
    }

    private var attachments: [GatewayChatMessageContent]? {
        self.message.content?.filter { ($0.type ?? "") != "text" }
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
        self.window = Self.makeWindow(for: presentation, contentViewController: hosting)
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
        window.orderFrontRegardless()
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

    private static func makeWindow(for presentation: WebChatPresentation, contentViewController: NSViewController) -> NSWindow {
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
            let panel = NSPanel(
                contentRect: NSRect(origin: .zero, size: WebChatSwiftUILayout.panelSize),
                styleMask: [.nonactivatingPanel, .borderless],
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
