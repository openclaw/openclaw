import CoreTransferable
import Foundation
import SwiftUI
import UniformTypeIdentifiers

#if !os(macOS) && canImport(UIKit)
import PhotosUI

private struct OpenClawVideoTransfer: Sendable, Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { video in
            SentTransferredFile(video.url)
        } importing: { received in
            let fileExtension = received.file.pathExtension
            let destination = FileManager.default.temporaryDirectory
                .appendingPathComponent("openclaw-picker-video-\(UUID().uuidString)")
                .appendingPathExtension(fileExtension.isEmpty ? "mov" : fileExtension)
            try FileManager.default.copyItem(at: received.file, to: destination)
            return OpenClawVideoTransfer(url: destination)
        }
    }
}

private struct OpenClawPickerTransferUnavailable: LocalizedError {
    var errorDescription: String? {
        String(localized: "Could not load this attachment. Try selecting it again.")
    }
}

/// One Photos pick and its tile. Loading it again is the tile's retry.
@MainActor
struct OpenClawPhotosPick {
    let item: PhotosPickerItem
    let type: UTType
    let baseName: String
    let preparation: UUID?

    func load(owner: OpenClawChatAttachmentCaptureOwner) async {
        do {
            if self.type.conforms(to: .movie) {
                guard let transfer = try await item.loadTransferable(type: OpenClawVideoTransfer.self)
                else { throw OpenClawPickerTransferUnavailable() }
                defer { try? FileManager.default.removeItem(at: transfer.url) }
                let metadata = OpenClawChatPickerAttachmentMetadata.resolve(
                    contentType: self.type,
                    transferredFileURL: transfer.url)
                await owner.viewModel.addVideoAttachment(
                    url: transfer.url,
                    fileName: "\(self.baseName).\(metadata.fileExtension)",
                    mimeType: metadata.mimeType,
                    expectedSession: owner.session,
                    preparation: self.preparation)
            } else {
                guard let data = try await item.loadTransferable(type: Data.self)
                else { throw OpenClawPickerTransferUnavailable() }
                let metadata = OpenClawChatPickerAttachmentMetadata.resolve(contentType: self.type)
                await owner.viewModel.addImageAttachment(
                    data: data,
                    fileName: "\(self.baseName).\(metadata.fileExtension)",
                    mimeType: metadata.mimeType,
                    for: owner.session,
                    preparation: self.preparation)
            }
        } catch {
            guard owner.viewModel.isCurrentSession(owner.session) else { return }
            owner.viewModel.reportAttachmentFailure(
                error.localizedDescription,
                preparation: self.preparation,
                transient: true)
        }
    }
}
#endif
