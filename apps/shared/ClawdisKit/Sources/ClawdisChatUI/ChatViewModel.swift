import ClawdisKit
import Foundation
import Observation
import OSLog
import UniformTypeIdentifiers

#if canImport(AppKit)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

private let chatUILogger = Logger(subsystem: "com.steipete.clawdis", category: "ClawdisChatUI")

@MainActor
@Observable
public final class ClawdisChatViewModel {
    public private(set) var messages: [ClawdisChatMessage] = []
    public var input: String = ""
    public var thinkingLevel: String = "off"
    public private(set) var isLoading = false
    public private(set) var isSending = false
    public var errorText: String?
    public var attachments: [ClawdisPendingAttachment] = []
    public private(set) var healthOK: Bool = false
    public private(set) var pendingRunCount: Int = 0

    public let sessionKey: String
    private let transport: any ClawdisChatTransport

    @ObservationIgnored
    private nonisolated(unsafe) var eventTask: Task<Void, Never>?
    private var pendingRuns = Set<String>() {
        didSet { self.pendingRunCount = self.pendingRuns.count }
    }

    private var lastHealthPollAt: Date?

    public init(sessionKey: String, transport: any ClawdisChatTransport) {
        self.sessionKey = sessionKey
        self.transport = transport

        self.eventTask = Task { [weak self] in
            guard let self else { return }
            let stream = self.transport.events()
            for await evt in stream {
                if Task.isCancelled { return }
                await MainActor.run { [weak self] in
                    self?.handleTransportEvent(evt)
                }
            }
        }
    }

    deinit {
        self.eventTask?.cancel()
    }

    public func load() {
        Task { await self.bootstrap() }
    }

    public func refresh() {
        Task { await self.bootstrap() }
    }

    public func send() {
        Task { await self.performSend() }
    }

    public func addAttachments(urls: [URL]) {
        Task { await self.loadAttachments(urls: urls) }
    }

    public func addImageAttachment(data: Data, fileName: String, mimeType: String) {
        Task { await self.addImageAttachment(url: nil, data: data, fileName: fileName, mimeType: mimeType) }
    }

    public func removeAttachment(_ id: ClawdisPendingAttachment.ID) {
        self.attachments.removeAll { $0.id == id }
    }

    public var canSend: Bool {
        let trimmed = self.input.trimmingCharacters(in: .whitespacesAndNewlines)
        return !self.isSending && (!trimmed.isEmpty || !self.attachments.isEmpty)
    }

    // MARK: - Internals

    private func bootstrap() async {
        self.isLoading = true
        self.errorText = nil
        self.healthOK = false
        defer { self.isLoading = false }
        do {
            do {
                try await self.transport.setActiveSessionKey(self.sessionKey)
            } catch {
                // Best-effort only; history/send/health still work without push events.
            }

            let payload = try await self.transport.requestHistory(sessionKey: self.sessionKey)
            self.messages = Self.decodeMessages(payload.messages ?? [])
            if let level = payload.thinkingLevel, !level.isEmpty {
                self.thinkingLevel = level
            }
            await self.pollHealthIfNeeded(force: true)
            self.errorText = nil
        } catch {
            self.errorText = error.localizedDescription
            chatUILogger.error("bootstrap failed \(error.localizedDescription, privacy: .public)")
        }
    }

    private static func decodeMessages(_ raw: [AnyCodable]) -> [ClawdisChatMessage] {
        raw.compactMap { item in
            (try? ChatPayloadDecoding.decode(item, as: ClawdisChatMessage.self))
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

        // Optimistically append user message to UI.
        var userContent: [ClawdisChatMessageContent] = [
            ClawdisChatMessageContent(
                type: "text",
                text: messageText,
                mimeType: nil,
                fileName: nil,
                content: nil),
        ]
        let encodedAttachments = self.attachments.map { att -> ClawdisChatAttachmentPayload in
            ClawdisChatAttachmentPayload(
                type: att.type,
                mimeType: att.mimeType,
                fileName: att.fileName,
                content: att.data.base64EncodedString())
        }
        for att in encodedAttachments {
            userContent.append(
                ClawdisChatMessageContent(
                    type: att.type,
                    text: nil,
                    mimeType: att.mimeType,
                    fileName: att.fileName,
                    content: att.content))
        }
        self.messages.append(
            ClawdisChatMessage(
                id: UUID(),
                role: "user",
                content: userContent,
                timestamp: Date().timeIntervalSince1970 * 1000))

        do {
            let response = try await self.transport.sendMessage(
                sessionKey: self.sessionKey,
                message: messageText,
                thinking: self.thinkingLevel,
                idempotencyKey: runId,
                attachments: encodedAttachments)
            self.pendingRuns.insert(response.runId)
        } catch {
            self.errorText = error.localizedDescription
            chatUILogger.error("chat.send failed \(error.localizedDescription, privacy: .public)")
        }

        self.input = ""
        self.attachments = []
        self.isSending = false
    }

    private func handleTransportEvent(_ evt: ClawdisChatTransportEvent) {
        switch evt {
        case let .health(ok):
            self.healthOK = ok
        case .tick:
            Task { await self.pollHealthIfNeeded(force: false) }
        case let .chat(chat):
            self.handleChatEvent(chat)
        case .seqGap:
            self.errorText = "Event stream interrupted; try refreshing."
        }
    }

    private func handleChatEvent(_ chat: ClawdisChatEventPayload) {
        if let sessionKey = chat.sessionKey, sessionKey != self.sessionKey {
            return
        }

        if let runId = chat.runId, !self.pendingRuns.contains(runId) {
            // Ignore events for other runs.
            return
        }

        switch chat.state {
        case "final":
            if let raw = chat.message,
               let msg = try? ChatPayloadDecoding.decode(raw, as: ClawdisChatMessage.self)
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
            let ok = try await self.transport.requestHealth(timeoutMs: 5000)
            self.healthOK = ok
        } catch {
            self.healthOK = false
        }
    }

    private func loadAttachments(urls: [URL]) async {
        for url in urls {
            do {
                let data = try await Task.detached { try Data(contentsOf: url) }.value
                await self.addImageAttachment(
                    url: url,
                    data: data,
                    fileName: url.lastPathComponent,
                    mimeType: Self.mimeType(for: url) ?? "application/octet-stream")
            } catch {
                await MainActor.run { self.errorText = error.localizedDescription }
            }
        }
    }

    private static func mimeType(for url: URL) -> String? {
        let ext = url.pathExtension
        guard !ext.isEmpty else { return nil }
        return (UTType(filenameExtension: ext) ?? .data).preferredMIMEType
    }

    private func addImageAttachment(url: URL?, data: Data, fileName: String, mimeType: String) async {
        if data.count > 5_000_000 {
            self.errorText = "Attachment \(fileName) exceeds 5 MB limit"
            return
        }

        let uti: UTType = {
            if let url {
                return UTType(filenameExtension: url.pathExtension) ?? .data
            }
            return UTType(mimeType: mimeType) ?? .data
        }()
        guard uti.conforms(to: .image) else {
            self.errorText = "Only image attachments are supported right now"
            return
        }

        let preview = Self.previewImage(data: data)
        self.attachments.append(
            ClawdisPendingAttachment(
                url: url,
                data: data,
                fileName: fileName,
                mimeType: mimeType,
                preview: preview))
    }

    private static func previewImage(data: Data) -> ClawdisPlatformImage? {
        #if canImport(AppKit)
        NSImage(data: data)
        #elseif canImport(UIKit)
        UIImage(data: data)
        #else
        nil
        #endif
    }
}
