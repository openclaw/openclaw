import Foundation
import OpenClawKit
import Testing
import UniformTypeIdentifiers
@testable import OpenClawChatUI

struct ChatFileAdmissionTests {
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

    @Test(arguments: [Int?.none, 3, 4])
    @MainActor
    func `stages files with gateway limits`(maximumBytes: Int?) async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let defaultsName = "ChatFileAdmissionTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: defaultsName))
        defer { defaults.removePersistentDomain(forName: defaultsName) }
        let limits = maximumBytes.map { GatewayAttachmentLimits(maxBytes: $0, maxImageBytes: 2) }
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
        if maximumBytes == 3 {
            #expect(model.attachments.isEmpty)
            #expect(model.errorText == "Too large to send: report.pdf, song.mp3, unknown")
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
        if limits != nil {
            model.errorText = nil
            let image = directory.appendingPathComponent("image.png")
            try Data(count: 3).write(to: image)
            await model.loadAttachments(urls: [image])
            #expect(model.errorText == "Too large to send: image.png")
        }
    }
}

private struct FileAdmissionTransport: OpenClawChatTransport {
    let limits: GatewayAttachmentLimits?

    func attachmentLimits() async -> GatewayAttachmentLimits? {
        self.limits
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
