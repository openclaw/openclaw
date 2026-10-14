import Foundation
import UniformTypeIdentifiers

struct OpenClawChatPickerAttachmentMetadata: Equatable, Sendable {
    /// Match the web composer's picker hint. Drops and pasted file URLs use
    /// the same size admission as the web, without a separate type denylist.
    static let allowedFileContentTypes: [UTType] = [.image, .audio, .movie, .pdf, .text] +
        ["csv", "json", "md", "txt", "zip", "doc", "docx", "xls", "xlsx", "ppt", "pptx"]
        .compactMap { UTType(filenameExtension: $0) }

    let fileExtension: String
    let mimeType: String

    static func fileIcon(mimeType: String, fileName: String) -> String {
        if mimeType.hasPrefix("audio/") { return "waveform" }
        if mimeType.hasPrefix("video/") { return "video" }
        if mimeType.hasPrefix("image/") { return "photo" }
        let type = UTType(mimeType: mimeType) ?? UTType(filenameExtension: (fileName as NSString).pathExtension)
        if type?.conforms(to: .archive) == true { return "archivebox" }
        if type?.conforms(to: .spreadsheet) == true || type?.conforms(to: .commaSeparatedText) == true {
            return "tablecells"
        }
        if type?.conforms(to: .text) == true || type?.conforms(to: .json) == true { return "doc.text" }
        if type?.conforms(to: .pdf) == true || type?.conforms(to: .presentation) == true {
            return "doc.richtext"
        }
        return "doc"
    }

    static func resolve(contentType: UTType, transferredFileURL: URL? = nil) -> Self {
        let isVideo = contentType.conforms(to: .movie)
        let transferredExtension = transferredFileURL?.pathExtension
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        let transferredType = transferredExtension.flatMap { extensionName in
            extensionName.isEmpty ? nil : UTType(filenameExtension: extensionName)
        }
        if isVideo {
            return Self(
                fileExtension: transferredType?.preferredFilenameExtension
                    ?? transferredExtension.flatMap { $0.isEmpty ? nil : $0 }
                    ?? contentType.preferredFilenameExtension
                    ?? "mov",
                mimeType: transferredType?.preferredMIMEType
                    ?? contentType.preferredMIMEType
                    ?? "video/quicktime")
        }
        return Self(
            fileExtension: contentType.preferredFilenameExtension ?? "jpg",
            mimeType: contentType.preferredMIMEType ?? "image/jpeg")
    }
}
