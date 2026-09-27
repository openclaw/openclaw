import Foundation
import Observation
import OpenClawKit
import Testing
import UniformTypeIdentifiers
@testable import OpenClawChatUI
#if os(macOS)
import AppKit
#endif

struct ChatFileAdmissionTests {
    #if os(macOS)
    @Test(arguments: [false, true])
    @MainActor
    func `stages whole file selection`(fromPasteboard: Bool) async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let defaultsName = "ChatFileAdmissionTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: defaultsName))
        defer { defaults.removePersistentDomain(forName: defaultsName) }
        let (events, continuation) = AsyncStream<FileAdmissionBatchEvent>.makeStream()
        defer { continuation.finish() }
        let policyReadGate = FileAdmissionPolicyReadGate(events: continuation)
        let model = OpenClawChatViewModel(
            sessionKey: "main",
            transport: FileAdmissionTransport(limits: nil, policyReadGate: policyReadGate),
            modelPickerStore: ChatModelPickerStore(defaults: defaults))
        defer { model.detachTransport() }
        let names = ["Quarterly release checklist.pdf", "release-metrics.csv", "standup-note.wav"]
        let sizes = [193, 54, 32 * 1024]
        let files = names.map { directory.appendingPathComponent($0) }
        for (file, size) in zip(files, sizes) {
            try Data(count: size).write(to: file)
        }
        let pasteboard = NSPasteboard(name: NSPasteboard.Name("test-\(UUID().uuidString)"))
        defer { pasteboard.releaseGlobally() }
        let urls: [URL]
        if fromPasteboard {
            #expect(pasteboard.writeObjects(files.map { $0 as NSURL }))
            urls = ChatComposerPasteSupport.fileURLs(from: pasteboard)
        } else {
            urls = files
        }
        #expect(urls == files)

        model.addAttachments(urls: urls)
        #expect(model.attachmentStagingCount == 1)
        withObservationTracking {
            _ = model.attachmentStagingCount
        } onChange: {
            continuation.yield(.finished)
        }
        var iterator = events.makeAsyncIterator()
        let firstEvent = await iterator.next()

        #expect(firstEvent == .finished)
        #expect(model.attachmentStagingCount == 0)
        #expect(model.attachments.map(\.fileName) == names)
        #expect(model.attachments.map(\.data.count) == sizes)
        #expect(Set(model.attachments.map(\.id)).count == 3)
        #expect(model.attachments.last?.mimeType.hasPrefix("audio/") == true)
        #expect(model.errorText == nil)
        // Always release a failing implementation's pending route lookup so
        // the test owns and joins its staging task without timers or polling.
        await policyReadGate.release()
        if firstEvent != .finished { _ = await iterator.next() }
    }
    #endif

    @Test(arguments: [
        "pdf",
        "txt",
        "swift",
        "csv",
        "json",
        "md",
        "zip",
        "doc",
        "docx",
        "xls",
        "xlsx",
        "ppt",
        "pptx",
        "mp3",
        "m4a",
        "wav",
        "png",
        "mp4",
    ])
    func `picker admits web file types`(fileExtension: String) throws {
        let type = try #require(UTType(filenameExtension: fileExtension))
        #expect(OpenClawChatPickerAttachmentMetadata.allowedFileContentTypes.contains {
            type.conforms(to: $0)
        })
    }

    @Test(arguments: [
        ("report.PDF", "application/pdf"), ("table.csv", "text/csv"),
        ("settings.json", "application/json"), ("notes.txt", "text/plain"),
        ("archive.zip", "application/zip"), ("song.mp3", "audio/mpeg"),
        ("recording.m4a", "audio/x-m4a"),
        ("report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    ])
    func `infers file MIME`(fileName: String, mimeType: String) {
        #expect(OpenClawChatViewModel.mimeType(for: URL(fileURLWithPath: fileName)) == mimeType)
    }

    @Test(arguments: ["file", "image", "voice", "image-file-batch"])
    @MainActor
    func `all staging paths count existing attachment bytes`(kind: String) async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let defaultsName = "ChatFileAdmissionTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: defaultsName))
        defer { defaults.removePersistentDomain(forName: defaultsName) }
        let model = OpenClawChatViewModel(
            sessionKey: "main",
            transport: FileAdmissionTransport(limits: .init(maxBytes: 10000, maxImageBytes: 10000)),
            modelPickerStore: ChatModelPickerStore(defaults: defaults))
        defer { model.detachTransport() }
        let first = directory.appendingPathComponent("first.pdf")
        try Data(count: 10000).write(to: first)
        await model.loadAttachments(urls: [first])
        #expect(model.attachments.map(\.fileName) == ["first.pdf"])
        if kind.hasPrefix("image") {
            let image = try #require(Data(base64Encoded:
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////GQAJ+wP/2hN8NwAAAABJRU5ErkJggg=="))
            if kind == "image" {
                await model.addImageAttachment(
                    data: image, fileName: "second.png", mimeType: "image/png", for: model.currentSessionSnapshot())
            } else {
                let imageURL = directory.appendingPathComponent("second.png")
                let oversized = directory.appendingPathComponent("third.pdf")
                try image.write(to: imageURL)
                try Data(count: 10001).write(to: oversized)
                await model.loadAttachments(urls: [imageURL, oversized])
            }
        } else {
            let file = directory.appendingPathComponent(kind == "voice" ? "second.m4a" : "second.pdf")
            try Data("file".utf8).write(to: file)
            if kind == "voice" {
                await model.addVoiceNoteAttachment(fileURL: file, durationSeconds: 1)
                #expect(!FileManager.default.fileExists(atPath: file.path))
            } else {
                await model.loadAttachments(urls: [file])
            }
        }
        #expect(model.attachments.map(\.fileName) == ["first.pdf"])
        let rejectedName = switch kind {
        case "image": "second.jpg"
        case "image-file-batch": "second.png, third.pdf"
        case "voice": "second.m4a"
        default: "second.pdf"
        }
        #expect(model.errorText == "Too large to send: \(rejectedName)")
    }

    @Test(arguments: [Int?.none, 6, 8])
    @MainActor
    func `outbox admission preserves an oversized draft`(maximumBytes: Int?) async throws {
        let (store, databases, directory) = try makeOutboxStore()
        defer {
            try? databases.close()
            try? FileManager.default.removeItem(at: directory)
        }
        let defaultsName = "ChatFileAdmissionTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: defaultsName))
        defer { defaults.removePersistentDomain(forName: defaultsName) }
        let model = OpenClawChatViewModel(
            sessionKey: "main",
            transport: FileAdmissionTransport(limits: maximumBytes.map {
                .init(maxBytes: $0, maxImageBytes: $0)
            }),
            activeAgentId: "main",
            sessionRoutingContract: "per-sender|main|main",
            outbox: store,
            modelPickerStore: ChatModelPickerStore(defaults: defaults))
        defer { model.detachTransport() }
        model.input = "Keep this draft"
        let data = maximumBytes == nil ? Data(count: 10 * 1024 * 1024) : Data("file".utf8)
        model.attachments = ["first.pdf", "second.pdf"].map {
            OpenClawPendingAttachment(
                url: nil,
                data: data,
                fileName: $0,
                mimeType: "application/pdf",
                preview: nil)
        }
        let attachmentIDs = model.attachments.map(\.id)
        let accepted = await model.enqueueOutboxCommand(
            text: model.input,
            draftInput: model.input,
            draftRevision: model.composerRevision(for: model.sessionKey),
            draftAttachments: model.attachments,
            session: model.currentSessionSnapshot())
        let commands = await store.loadCommands()
        #expect(accepted == (maximumBytes == 8))
        if maximumBytes != 8 {
            #expect(model.input == "Keep this draft")
            #expect(model.attachments.map(\.id) == attachmentIDs)
            #expect(model.errorText == "Too large to send: second.pdf")
            #expect(commands.isEmpty)
            #expect(model.messages.isEmpty)
        } else {
            #expect(model.input.isEmpty)
            #expect(model.attachments.isEmpty)
            #expect(commands.count == 1)
            #expect(commands.first?.attachments.map(\.data.count) == [4, 4])
        }
    }

    @Test(arguments: [Int?.none, 3, 4, 6, 12, 19_464_192])
    @MainActor
    func `stages files with gateway limits`(maximumBytes: Int?) async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let defaultsName = "ChatFileAdmissionTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: defaultsName))
        defer { defaults.removePersistentDomain(forName: defaultsName) }
        let limits = maximumBytes.map {
            GatewayAttachmentLimits(maxBytes: $0, maxImageBytes: $0 <= 12 ? 2 : 5_000_000)
        }
        let model = OpenClawChatViewModel(
            sessionKey: "main",
            transport: FileAdmissionTransport(limits: limits),
            modelPickerStore: ChatModelPickerStore(defaults: defaults))
        defer { model.detachTransport() }
        let names = ["report.pdf", "song.mp3", "unknown"]
        let data = Data("file".utf8)
        let files = names.map { directory.appendingPathComponent($0) }
        for file in files {
            try data.write(to: file)
        }
        await model.loadAttachments(urls: files)
        if let maximumBytes, maximumBytes < 12 {
            let acceptedNames = Array(names.prefix(maximumBytes / data.count))
            #expect(model.attachments.map(\.fileName) == acceptedNames)
            #expect(model.errorText == "Too large to send: " + names.dropFirst(acceptedNames.count)
                .joined(separator: ", "))
        } else {
            #expect(model.attachments.map(\.fileName) == names)
            #expect(model.attachments.map(\.mimeType) == ["application/pdf", "audio/mpeg", "application/octet-stream"])
            #expect(model.attachments.allSatisfy { $0.data == data && $0.type == "file" && $0.durationSeconds == nil })
            #expect(model.errorText == nil)
        }
        model.errorText = nil
        let empty = directory.appendingPathComponent("empty.txt")
        try Data().write(to: empty)
        await model.loadAttachments(urls: [empty, directory])
        #expect(model.errorText == "Could not attach: empty.txt, \(directory.lastPathComponent)")
        let pngData = try #require(Data(base64Encoded:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////GQAJ+wP/2hN8NwAAAABJRU5ErkJggg=="))
        if limits?.maxImageBytes == 2 {
            model.errorText = nil
            let image = directory.appendingPathComponent("image.png")
            try pngData.write(to: image)
            await model.loadAttachments(urls: [image])
            #expect(model.errorText == "Too large to send: image.png")
        }
        if limits == nil || maximumBytes == 19_464_192 {
            model.errorText = nil
            let attachmentCount = model.attachments.count
            let oversized = directory.appendingPathComponent("oversized.pdf")
            try Data().write(to: oversized)
            let handle = try FileHandle(forWritingTo: oversized)
            try handle.truncate(atOffset: 19_464_193)
            try handle.close()
            await model.loadAttachments(urls: [oversized])
            #expect(model.attachments.count == attachmentCount)
            #expect(model.errorText == "Too large to send: oversized.pdf")

            model.errorText = nil
            let image = directory.appendingPathComponent("resizable.png")
            var imageData = pngData
            // A valid image with trailing padding exceeds the final ceiling,
            // but must still pass through the existing resize step.
            imageData.append(Data(count: 5_000_001 - imageData.count))
            try imageData.write(to: image)
            for fromFile in [true, false] {
                model.errorText = nil
                if fromFile {
                    await model.loadAttachments(urls: [image])
                } else {
                    await model.addImageAttachment(
                        data: imageData,
                        fileName: "resizable.png",
                        mimeType: "image/png",
                        for: model.currentSessionSnapshot())
                }
                #expect(model.errorText == nil)
                #expect(model.attachments.count == attachmentCount + 1)
                let resized = try #require(model.attachments.first { $0.fileName == "resizable.jpg" })
                #expect(resized.mimeType == "image/jpeg")
                #expect(resized.data.count <= 5_000_000)
                model.removeAttachment(resized.id)
            }
        }
    }
}

private struct FileAdmissionTransport: OpenClawChatTransport {
    let limits: GatewayAttachmentLimits?
    var policyReadGate: FileAdmissionPolicyReadGate?

    func attachmentLimits() async -> GatewayAttachmentLimits? {
        await self.policyReadGate?.read()
        return self.limits
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        AsyncStream { $0.finish() }
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        true
    }

    func requestHistory(sessionKey _: String) async throws -> OpenClawChatHistoryPayload {
        throw CancellationError()
    }

    func sendMessage(
        sessionKey _: String,
        message _: String,
        thinking _: String,
        idempotencyKey _: String,
        attachments _: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        throw CancellationError()
    }
}

private enum FileAdmissionBatchEvent: Sendable {
    case policyReread
    case finished
}

private actor FileAdmissionPolicyReadGate {
    let events: AsyncStream<FileAdmissionBatchEvent>.Continuation
    private var reads = 0
    private var isReleased = false
    private var continuation: CheckedContinuation<Void, Never>?

    init(events: AsyncStream<FileAdmissionBatchEvent>.Continuation) {
        self.events = events
    }

    func read() async {
        self.reads += 1
        guard self.reads > 1, !self.isReleased else { return }
        self.events.yield(.policyReread)
        await withCheckedContinuation { self.continuation = $0 }
    }

    func release() {
        self.isReleased = true
        self.continuation?.resume()
        self.continuation = nil
    }
}
