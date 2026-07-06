import CoreGraphics
import Foundation
import ImageIO
import OpenClawKit
import UniformTypeIdentifiers
import XCTest
@testable import OpenClawChatUI

private actor AttachmentSendCapture {
    private(set) var attachments: [OpenClawChatAttachmentPayload] = []

    func store(_ attachments: [OpenClawChatAttachmentPayload]) {
        self.attachments = attachments
    }

    func count() -> Int {
        self.attachments.count
    }

    func first() -> OpenClawChatAttachmentPayload? {
        self.attachments.first
    }
}

private actor AttachmentHealthGate {
    private var entered = false
    private var released = false
    private var continuation: CheckedContinuation<Void, Never>?

    func wait() async {
        self.entered = true
        guard !self.released else { return }
        await withCheckedContinuation { continuation in
            self.continuation = continuation
        }
    }

    func hasEntered() -> Bool {
        self.entered
    }

    func release() {
        self.released = true
        self.continuation?.resume()
        self.continuation = nil
    }
}

private struct AttachmentProcessingTransport: OpenClawChatTransport {
    let capture: AttachmentSendCapture?
    let healthGate: AttachmentHealthGate?

    init(capture: AttachmentSendCapture? = nil, healthGate: AttachmentHealthGate? = nil) {
        self.capture = capture
        self.healthGate = healthGate
    }

    func requestHistory(sessionKey _: String) async throws -> OpenClawChatHistoryPayload {
        throw NSError(domain: "ChatViewModelAttachmentTests", code: 1)
    }

    func sendMessage(
        sessionKey _: String,
        message _: String,
        thinking _: String,
        idempotencyKey: String,
        attachments: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        await self.capture?.store(attachments)
        return OpenClawChatSendResponse(runId: idempotencyKey, status: "started")
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        await self.healthGate?.wait()
        true
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        AsyncStream { _ in }
    }
}

private func makeChatAttachmentJPEG(width: Int, height: Int) throws -> Data {
    guard
        let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else {
        throw NSError(domain: "ChatViewModelAttachmentTests", code: 3)
    }

    context.setFillColor(CGColor(red: 0.2, green: 0.4, blue: 0.8, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.setFillColor(CGColor(red: 0.9, green: 0.5, blue: 0.1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width / 2, height: height / 2))

    guard let image = context.makeImage() else {
        throw NSError(domain: "ChatViewModelAttachmentTests", code: 4)
    }

    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else {
        throw NSError(domain: "ChatViewModelAttachmentTests", code: 5)
    }
    CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.95] as CFDictionary)
    guard CGImageDestinationFinalize(destination) else {
        throw NSError(domain: "ChatViewModelAttachmentTests", code: 6)
    }
    return data as Data
}

private func chatAttachmentDimensions(for data: Data) -> (width: Int, height: Int)? {
    guard
        let source = CGImageSourceCreateWithData(data as CFData, nil),
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
        let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
        let height = properties[kCGImagePropertyPixelHeight] as? NSNumber
    else {
        return nil
    }
    return (width.intValue, height.intValue)
}

final class ChatViewModelAttachmentTests: XCTestCase {
    func testImageAttachmentsAreProcessedBeforeStaging() async throws {
        let imageData = try makeChatAttachmentJPEG(width: 3000, height: 4000)
        let viewModel = await MainActor.run {
            OpenClawChatViewModel(sessionKey: "main", transport: AttachmentProcessingTransport())
        }

        await MainActor.run {
            viewModel.addImageAttachment(data: imageData, fileName: "camera.heic", mimeType: "image/jpeg")
        }

        try await waitUntil("attachment processed") {
            await MainActor.run { !viewModel.attachments.isEmpty || viewModel.errorText != nil }
        }

        let attachment = try await MainActor.run {
            guard let attachment = viewModel.attachments.first else {
                throw NSError(domain: "ChatViewModelAttachmentTests", code: 7)
            }
            return (attachment.fileName, attachment.mimeType, attachment.data)
        }
        let dimensions = try XCTUnwrap(chatAttachmentDimensions(for: attachment.2))

        XCTAssertEqual(attachment.0, "camera.jpg")
        XCTAssertEqual(attachment.1, "image/jpeg")
        XCTAssertLessThanOrEqual(attachment.2.count, ChatImageProcessor.maxPayloadBytes)
        XCTAssertLessThanOrEqual(max(dimensions.width, dimensions.height), ChatImageProcessor.maxLongEdgePx)
        let errorText = await MainActor.run { viewModel.errorText }
        XCTAssertNil(errorText)
    }

    func testVoiceNoteAttachmentStagesAudioAndDeletesTemporaryFile() async throws {
        let fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("voice-note-20260706-120000.m4a")
        let data = Data("voice-note-data".utf8)
        try data.write(to: fileURL)
        let viewModel = await MainActor.run {
            OpenClawChatViewModel(sessionKey: "main", transport: AttachmentProcessingTransport())
        }

        await viewModel.addVoiceNoteAttachment(fileURL: fileURL, durationSeconds: 8.4)

        let attachment = try await MainActor.run { () throws -> (Data, String, String, String, Double?, Bool) in
            let attachment = try XCTUnwrap(viewModel.attachments.first)
            return (
                attachment.data,
                attachment.fileName,
                attachment.mimeType,
                attachment.type,
                attachment.durationSeconds,
                attachment.preview == nil)
        }
        XCTAssertEqual(attachment.0, data)
        XCTAssertEqual(attachment.1, "voice-note-20260706-120000.m4a")
        XCTAssertEqual(attachment.2, "audio/mp4")
        XCTAssertEqual(attachment.3, "file")
        XCTAssertEqual(attachment.4, 8.4)
        XCTAssertTrue(attachment.5)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fileURL.path))
    }

    func testOversizeVoiceNoteIsRejectedAndDeleted() async throws {
        let fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("voice-note-oversize.m4a")
        try Data(repeating: 0x41, count: 5_000_001).write(to: fileURL)
        let viewModel = await MainActor.run {
            OpenClawChatViewModel(sessionKey: "main", transport: AttachmentProcessingTransport())
        }

        await viewModel.addVoiceNoteAttachment(fileURL: fileURL, durationSeconds: 180)

        let result = await MainActor.run { (viewModel.attachments.count, viewModel.errorText) }
        XCTAssertEqual(result.0, 0)
        XCTAssertEqual(result.1, "Voice note exceeds the 5 MB attachment limit")
        XCTAssertFalse(FileManager.default.fileExists(atPath: fileURL.path))
    }

    func testVoiceNoteSendUsesExistingAttachmentPayloadAndOptimisticDuration() async throws {
        let capture = AttachmentSendCapture()
        let transport = AttachmentProcessingTransport(capture: capture)
        let fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("voice-note-20260706-120001.m4a")
        let data = Data("encoded-voice-note".utf8)
        try data.write(to: fileURL)
        let viewModel = await MainActor.run {
            OpenClawChatViewModel(sessionKey: "main", transport: transport)
        }

        await viewModel.addVoiceNoteAttachment(fileURL: fileURL, durationSeconds: 21.2)
        await MainActor.run { viewModel.send() }
        try await waitUntil("voice note sent") {
            await capture.count() == 1
        }

        let capturedPayload = await capture.first()
        let payload = try XCTUnwrap(capturedPayload)
        XCTAssertEqual(payload.type, "file")
        XCTAssertEqual(payload.mimeType, "audio/mp4")
        XCTAssertEqual(payload.fileName, "voice-note-20260706-120001.m4a")
        XCTAssertEqual(payload.content, data.base64EncodedString())

        let optimisticAudio = await MainActor.run {
            viewModel.messages.last?.content.first { $0.mimeType == "audio/mp4" }
        }
        XCTAssertEqual(optimisticAudio?.type, "file")
        XCTAssertEqual(optimisticAudio?.mimeType, "audio/mp4")
        XCTAssertEqual(optimisticAudio?.durationSeconds, 21.2)
    }

    func testVoiceNoteSendKeepsCapturedDurationWhenDraftChangesDuringHealthCheck() async throws {
        let capture = AttachmentSendCapture()
        let healthGate = AttachmentHealthGate()
        let transport = AttachmentProcessingTransport(capture: capture, healthGate: healthGate)
        let draftAttachment = OpenClawPendingAttachment(
            url: nil,
            data: Data("draft-audio".utf8),
            fileName: "draft.m4a",
            mimeType: "audio/mp4",
            preview: nil,
            durationSeconds: 21.2)
        let replacementAttachment = OpenClawPendingAttachment(
            url: nil,
            data: Data("replacement-audio".utf8),
            fileName: "replacement.m4a",
            mimeType: "audio/mp4",
            preview: nil,
            durationSeconds: 99)
        let viewModel = await MainActor.run {
            let viewModel = OpenClawChatViewModel(sessionKey: "main", transport: transport)
            viewModel.attachments = [draftAttachment]
            return viewModel
        }

        await MainActor.run { viewModel.send() }
        try await waitUntil("health check started") {
            await healthGate.hasEntered()
        }
        await MainActor.run {
            viewModel.removeAttachment(draftAttachment.id)
            viewModel.attachments.append(replacementAttachment)
        }
        await healthGate.release()
        try await waitUntil("voice note sent") {
            await capture.count() == 1
        }

        let optimisticAudio = await MainActor.run {
            viewModel.messages.last?.content.first { $0.mimeType == "audio/mp4" }
        }
        XCTAssertEqual(optimisticAudio?.fileName, "draft.m4a")
        XCTAssertEqual(optimisticAudio?.durationSeconds, 21.2)
    }

    @MainActor
    func testCanonicalVoiceNotePreservesOptimisticDuration() throws {
        let localAudio = OpenClawChatMessageContent(
            type: "file",
            text: nil,
            mimeType: "audio/mp4",
            fileName: "voice-note-local.m4a",
            durationSeconds: 14.6,
            content: AnyCodable("local"))
        let canonicalAudio = OpenClawChatMessageContent(
            type: "file",
            text: nil,
            mimeType: "audio/mp4",
            fileName: "media-1.m4a",
            content: AnyCodable("canonical"))
        let existing = OpenClawChatMessage(
            role: "user",
            content: [localAudio],
            timestamp: nil,
            idempotencyKey: "run:user")
        let incoming = OpenClawChatMessage(
            role: "user",
            content: [canonicalAudio],
            timestamp: nil,
            idempotencyKey: "run:user")

        let adopted = OpenClawChatViewModel.adoptingCanonicalMessage(incoming, over: existing)

        let audio = try XCTUnwrap(adopted.content.first)
        XCTAssertEqual(audio.fileName, "media-1.m4a")
        XCTAssertEqual(audio.content, AnyCodable("canonical"))
        XCTAssertEqual(audio.durationSeconds, 14.6)
    }
}
