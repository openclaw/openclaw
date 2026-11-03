import Foundation
import Testing

struct ShareAttachmentSummaryTests {
    @Test func `has no omission message when every selected image is accepted`() {
        let summary = ShareAttachmentSummary(selectedImageCount: 3, acceptedImageCount: 3)

        #expect(summary.omissionMessage == nil)
    }

    @Test func `reports image truncation before the share can be sent`() {
        let summary = ShareAttachmentSummary(selectedImageCount: 6, acceptedImageCount: 3)

        #expect(summary.omissionMessage ==
            "Only 3 of 6 images can be sent.")
    }

    @Test func `reports unsupported videos files and unknown attachments`() {
        let summary = ShareAttachmentSummary(
            selectedImageCount: 1,
            acceptedImageCount: 1,
            videoCount: 1,
            fileCount: 2,
            unknownCount: 1)

        #expect(summary.omissionMessage ==
            "OpenClaw Share cannot send 1 video, 2 files, 1 unsupported item yet.")
    }

    @Test func `counts an unclassified provider only when its content is absent from the direct draft`() {
        var summary = ShareAttachmentSummary()

        summary.recordUnclassifiedProvider(didIncludeContent: true)
        #expect(summary.unknownCount == 0)

        summary.recordUnclassifiedProvider(didIncludeContent: false)
        #expect(summary.unknownCount == 1)
    }

    @Test func `keeps image processing failures authoritative before omission warnings`() {
        let summary = ShareAttachmentSummary(selectedImageCount: 2, acceptedImageCount: 1)

        #expect(ShareAttachmentBlockReason.resolve(
            hasImageProcessingError: true,
            summary: summary) == .imageProcessingFailed)
    }

    @Test func `uses omission warning when no image processing failure exists`() {
        let summary = ShareAttachmentSummary(selectedImageCount: 6, acceptedImageCount: 3)

        #expect(ShareAttachmentBlockReason.resolve(
            hasImageProcessingError: false,
            summary: summary) == .omitted(
            "Only 3 of 6 images can be sent."))
    }
}

extension ShareAttachmentSummaryTests {
    @Test(arguments: [ShareImportRecovery.save, .selectDestination, .unreadableDestination])
    func blockedRecoveryMatchesAvailableAction(_ recovery: ShareImportRecovery) throws {
        let reason = try #require(ShareAttachmentBlockReason.resolve(
            hasImageProcessingError: false, summary: ShareAttachmentSummary(fileCount: 1)))
        let message = reason.message(recovery: recovery)
        let controls = ShareComposeControlState.resolve(status: .blocked(message), hasDraftText: true)
        #expect(!controls.isSendEnabled)
        #expect(controls.isCancelEnabled)
        #expect(message.contains("Save to OpenClaw") == recovery.canSave)
        if !recovery.canSave {
            #expect(message.contains("select the intended Gateway and chat, then share again"))
        }
        if case .unreadableDestination = recovery {
            #expect(message.contains("could not be read"))
        }
    }
}
