import Foundation
import Observation
import OpenClawKit
import SwiftUI
import Testing
import UIKit
@testable import OpenClaw
@testable import OpenClawChatUI

@MainActor
struct ChatAttachmentRailTests {
    private static let photo = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8)).image { context in
        UIColor.gray.setFill()
        context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
    }

    private static func attachment(
        _ fileName: String,
        _ mimeType: String,
        bytes: Int,
        preview: UIImage? = nil,
        durationSeconds: TimeInterval? = nil) -> OpenClawPendingAttachment
    {
        OpenClawPendingAttachment(
            url: nil,
            data: Data(count: bytes),
            fileName: fileName,
            mimeType: mimeType,
            preview: preview,
            durationSeconds: durationSeconds)
    }

    private static func height(
        _ attachments: [OpenClawPendingAttachment],
        preparing: [OpenClawPreparingAttachment] = [],
        _ typeSize: DynamicTypeSize) -> CGFloat
    {
        let strip = OpenClawChatAttachmentsStrip(attachments: attachments, preparing: preparing, onRemove: { _ in })
            .environment(\.dynamicTypeSize, typeSize)
        return UIHostingController(rootView: strip).sizeThatFits(in: CGSize(width: 402, height: 1000)).height
    }

    @Test func `tiles sit twelve points below the edge and file cards grow with dynamic type`() {
        let image = Self.attachment("IMG_0412.jpg", "image/jpeg", bytes: 10, preview: Self.photo)
        let file = Self.attachment("Q3 planning notes.pdf", "application/pdf", bytes: 2048)

        // Layout rounds to pixels, so compare within half a 3x pixel.
        #expect(abs(Self.height([image], .large) - (12 + 56)) < 0.17)
        #expect(abs(Self.height([image, file], .large) - (12 + 56)) < 0.17)
        #expect(abs(Self.height([image], .accessibility3) - (12 + 56)) < 0.17)
        #expect(Self.height([image, file], .accessibility3) > 12 + 56 + 1)
    }

    @Test func `remove targets reach the next tile without covering it`() {
        let metrics = ChatAttachmentRailMetrics.self
        #expect(metrics.badgeHitSize == 44)
        #expect(metrics.badgeOverhang == metrics.gap)
    }

    @Test func `file cards name the type and size, and a voice note its length`() {
        let pdf = Self.attachment("Q3 planning notes.pdf", "application/pdf", bytes: 2048)
        let note = Self.attachment("voice-note.m4a", "audio/mp4", bytes: 4096, durationSeconds: 65)
        let bare = Self.attachment("notes", "application/octet-stream", bytes: 2048)

        #expect(ChatAttachmentTile.detail(for: pdf) == "PDF · 2 KB")
        #expect(ChatAttachmentTile.detail(for: note) == "1:05")
        #expect(ChatAttachmentTile.detail(for: bare) == "2 KB")
    }

    @Test func `a tile keeps its size from the pick to the staged attachment`() {
        let photo = OpenClawPreparingAttachment(
            id: UUID(), fileName: "photo-3F2A91C4.heic", mimeType: "image/heic", preview: nil, durationSeconds: nil)
        var video = OpenClawPreparingAttachment(
            id: UUID(), fileName: "video-5C77A0B9.mov", mimeType: "video/quicktime", preview: nil, durationSeconds: nil)
        #expect(abs(Self.height([], preparing: [photo, video], .large) - (12 + 56)) < 0.17)
        video.failure = "Too large to send: video-5C77A0B9.mov"
        #expect(abs(Self.height([], preparing: [photo, video], .large) - (12 + 56)) < 0.17)
        // Only the type is known before the file is read.
        #expect(ChatAttachmentTile.detail(for: ChatAttachmentTileModel(video)) == "MOV")
    }

    @Test func `picked files get tiles at once, stage in place, and fail on their own tile`() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let notes = directory.appendingPathComponent("notes.pdf")
        try Data(count: 2048).write(to: notes)
        let gone = directory.appendingPathComponent("gone.pdf")
        let model = OpenClawChatViewModel(
            sessionKey: "main",
            transport: IOSGatewayChatTransport(gateway: GatewayNodeSession()))
        defer { model.detachTransport() }

        model.addAttachments(urls: [notes, gone])
        #expect(model.preparingAttachments.map(\.fileName) == ["notes.pdf", "gone.pdf"])
        #expect(model.preparingAttachments.allSatisfy { $0.failure == nil })
        let ids = model.preparingAttachments.map(\.id)
        await Self.settled(model)

        #expect(model.attachments.map(\.id) == [ids[0]])
        #expect(model.preparingAttachments.map(\.id) == [ids[1]])
        #expect(model.preparingAttachments.first?.failure == "Couldn’t attach gone.pdf.")
        #expect(model.preparingAttachments.first?.retry != nil)
        #expect(model.errorText == nil)

        model.removeAttachment(ids[1])
        #expect(model.preparingAttachments.isEmpty)
    }

    @Test func `removing a tile while it prepares cancels the file`() async throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).pdf")
        try Data(count: 2048).write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        let model = OpenClawChatViewModel(
            sessionKey: "main",
            transport: IOSGatewayChatTransport(gateway: GatewayNodeSession()))
        defer { model.detachTransport() }

        model.addAttachments(urls: [file])
        let id = try #require(model.preparingAttachments.first?.id)
        model.removeAttachment(id)
        await Self.settled(model)

        #expect(model.attachments.isEmpty)
        #expect(model.preparingAttachments.isEmpty)
        #expect(model.errorText == nil)
    }

    @Test func `a failed tile is read once, by its name, and a voice note never by its file name`() {
        var photo = OpenClawPreparingAttachment(
            id: UUID(), fileName: "camera-8B1D07E2.jpg", mimeType: "image/jpeg", preview: nil, durationSeconds: nil)
        photo.failure = OpenClawChatViewModel.couldNotAttachSentence("camera-8B1D07E2.jpg")
        #expect(ChatAttachmentTile.accessibilityValue(for: ChatAttachmentTileModel(photo)).isEmpty)
        photo.failure = "camera-8B1D07E2.jpg is too large to send."
        #expect(ChatAttachmentTile.accessibilityValue(for: ChatAttachmentTileModel(photo)) == photo.failure)

        let note = OpenClawPreparingAttachment(
            id: UUID(), fileName: "voice-note-1F2E.m4a", mimeType: "audio/mp4", preview: nil, durationSeconds: 12)
        #expect(ChatAttachmentTileModel(note).name == "Voice note")
    }

    @Test func `image failures name their case, not the processor's text`() {
        typealias Failure = ChatImageProcessor.ProcessError
        #expect(OpenClawChatViewModel.imageProcessingMessage(Failure.notAnImage, fileName: "a.heic")
            == "a.heic isn’t a supported image.")
        #expect(OpenClawChatViewModel.imageProcessingMessage(Failure.decodeFailed, fileName: "a.heic")
            == "a.heic isn’t a supported image.")
        #expect(OpenClawChatViewModel.imageProcessingMessage(Failure.encodeFailed, fileName: "a.heic")
            == "Couldn’t attach a.heic.")
    }

    @Test func `a file that fits alone but not with the others says so on its tile`() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let small = directory.appendingPathComponent("notes.pdf")
        try Data(count: 100).write(to: small)
        // Sparse: the size check reads the metadata and stops before reading the bytes.
        let huge = directory.appendingPathComponent("archive.zip")
        FileManager.default.createFile(atPath: huge.path, contents: nil)
        let handle = try FileHandle(forWritingTo: huge)
        let maxBytes = GatewayAttachmentLimits.legacyClientFallback.maxBytes
        try handle.truncate(atOffset: UInt64(maxBytes + 1))
        try handle.close()
        let model = OpenClawChatViewModel(
            sessionKey: "main",
            transport: IOSGatewayChatTransport(gateway: GatewayNodeSession()))
        defer { model.detachTransport() }
        model.attachments = [Self.attachment("big.pdf", "application/pdf", bytes: maxBytes - 50)]

        model.addAttachments(urls: [small, huge])
        await Self.settled(model)

        #expect(model.preparingAttachments.map(\.failure) == [
            "notes.pdf is too large to send with the other attachments.",
            "archive.zip is too large to send.",
        ])
        #expect(model.errorText == nil)
    }

    @Test func `a voice note that fails says so by name, with no retry`() async throws {
        let model = OpenClawChatViewModel(
            sessionKey: "main",
            transport: IOSGatewayChatTransport(gateway: GatewayNodeSession()))
        defer { model.detachTransport() }
        let missing = FileManager.default.temporaryDirectory.appendingPathComponent("voice-note-\(UUID()).m4a")
        await model.addVoiceNoteAttachment(fileURL: missing, durationSeconds: 4)
        let tooLong = FileManager.default.temporaryDirectory.appendingPathComponent("voice-note-\(UUID()).m4a")
        try Data(count: OpenClawChatViewModel.maxAttachmentBytes + 1).write(to: tooLong)
        await model.addVoiceNoteAttachment(fileURL: tooLong, durationSeconds: 300)

        #expect(model.preparingAttachments.map(\.failure) == [
            "Couldn’t attach voice note. Try recording again.",
            "Voice note is over the 5 MB limit. Record a shorter one.",
        ])
        #expect(model.preparingAttachments.allSatisfy { $0.retry == nil })
        #expect(model.errorText == nil)
    }

    /// Waits for staging to end by observing the count, without timers.
    private static func settled(_ model: OpenClawChatViewModel) async {
        while model.attachmentStagingCount > 0 {
            await withCheckedContinuation { continuation in
                withObservationTracking {
                    _ = model.attachmentStagingCount
                } onChange: {
                    Task { @MainActor in continuation.resume() }
                }
            }
        }
    }
}
