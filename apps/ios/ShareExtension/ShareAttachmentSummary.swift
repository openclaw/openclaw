import Foundation

struct ShareAttachmentSummary: Equatable {
    var selectedImageCount = 0
    var acceptedImageCount = 0
    var videoCount = 0
    var fileCount = 0
    var unknownCount = 0

    var omissionMessage: String? {
        var details: [String] = []

        if self.selectedImageCount > self.acceptedImageCount {
            details.append(String(
                format: NSLocalizedString(
                    "Only %d of %d images can be sent.",
                    comment: "Share extension image attachment limit warning"),
                self.acceptedImageCount,
                self.selectedImageCount))
        }

        var unsupported: [String] = []
        if self.videoCount > 0 {
            unsupported.append(String(
                format: NSLocalizedString(
                    "%d video(s)",
                    comment: "Share extension unsupported video count"),
                self.videoCount))
        }
        if self.fileCount > 0 {
            unsupported.append(String(
                format: NSLocalizedString(
                    "%d file(s)",
                    comment: "Share extension unsupported file count"),
                self.fileCount))
        }
        if self.unknownCount > 0 {
            unsupported.append(String(
                format: NSLocalizedString(
                    "%d unsupported item(s)",
                    comment: "Share extension unsupported attachment count"),
                self.unknownCount))
        }

        if !unsupported.isEmpty {
            details.append(String(
                format: NSLocalizedString(
                    "OpenClaw Share cannot send %@ yet.",
                    comment: "Share extension unsupported attachment warning"),
                unsupported.joined(separator: ", ")))
        }

        guard !details.isEmpty else { return nil }
        details.append(NSLocalizedString(
            "Remove omitted items and share again.",
            comment: "Share extension omitted attachment recovery"))
        return details.joined(separator: " ")
    }
}

enum ShareAttachmentBlockReason: Equatable {
    case imageProcessingFailed
    case omitted(String)

    static func resolve(
        hasImageProcessingError: Bool,
        summary: ShareAttachmentSummary) -> Self?
    {
        if hasImageProcessingError {
            return .imageProcessingFailed
        }
        if let omissionMessage = summary.omissionMessage {
            return .omitted(omissionMessage)
        }
        return nil
    }
}
