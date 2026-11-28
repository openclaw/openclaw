import Foundation
import SwiftUI
import UniformTypeIdentifiers

struct OpenClawChatPickerAttachmentMetadata: Equatable, Sendable {
    /// Match the web composer's picker hint. Drops and pasted file URLs use
    /// the same size admission as the web, without a separate type denylist.
    static let allowedFileContentTypes: [UTType] = [.image, .audio, .movie, .pdf, .text] +
        ["csv", "json", "md", "txt", "zip", "doc", "docx", "xls", "xlsx", "ppt", "pptx"]
        .compactMap { UTType(filenameExtension: $0) }

    let fileExtension: String
    let mimeType: String

    /// Control UI file overlay families. Extensions and MIME types have disjoint keys.
    private static let families: [String: Set<String>] = [
        "pdf": [
            "pdf", "application/pdf",
        ],
        "document": [
            "doc", "docx", "rtf", "odt", "pages", "application/msword",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/rtf",
            "text/rtf", "application/vnd.oasis.opendocument.text",
        ],
        "spreadsheet": [
            "csv", "xls", "xlsx", "ods", "numbers", "text/csv", "application/vnd.ms-excel",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/vnd.oasis.opendocument.spreadsheet",
        ],
        "image": [
            "gif", "jpg", "jpeg", "png", "webp", "avif", "heic", "image/gif", "image/jpeg", "image/png",
            "image/webp", "image/avif", "image/heic",
        ],
        "video": [
            "mp4", "mov", "m4v", "webm", "mkv", "video/mp4", "video/quicktime", "video/webm",
            "video/x-matroska",
        ],
        "audio": [
            "mp3", "wav", "m4a", "aac", "flac", "ogg", "audio/mpeg", "audio/wav", "audio/x-wav", "audio/mp4",
            "audio/aac", "audio/flac", "audio/ogg",
        ],
        "archive": [
            "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "application/zip", "application/x-rar-compressed",
            "application/x-7z-compressed", "application/x-tar", "application/gzip",
        ],
        "text": [
            "txt", "log", "text/plain",
        ],
        "markdown": [
            "md", "mdx", "markdown", "text/markdown", "text/x-markdown",
        ],
        "code": [
            "css", "html", "htm", "xml", "jsx", "tsx", "ts", "sh", "bash", "zsh", "text/css", "text/html",
            "application/xml", "text/xml", "application/typescript", "text/x-shellscript",
        ],
        "javascript": [
            "js", "cjs", "mjs", "text/javascript", "application/javascript",
        ],
        "json": [
            "json", "jsonl", "geojson", "application/json", "application/ld+json", "application/x-ndjson",
            "application/geo+json",
        ],
        "python": [
            "py", "pyw", "pyi", "text/x-python", "application/x-python-code",
        ],
        "svg": [
            "svg", "svgz", "image/svg+xml",
        ],
        "yaml": [
            "yaml", "yml", "application/yaml", "text/yaml", "application/x-yaml", "text/x-yaml",
        ],
    ]

    static func attachmentAsset(mimeType: String, fileName: String) -> String {
        let ext = (fileName as NSString).pathExtension.lowercased()
        let mime = mimeType.components(separatedBy: ";")[0].trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let family = self.families.first { $0.value.contains(ext) } ?? self.families.first { $0.value.contains(mime) }
        return "attachment-" + (family?.key ?? "unknown")
    }

    @MainActor @ViewBuilder static func glyph(mimeType: String, fileName: String, size: CGFloat = 16) -> some View {
        #if os(iOS)
        ChatVectorGlyph(asset: self.attachmentAsset(mimeType: mimeType, fileName: fileName), size: size)
        #else
        Image(systemName: self.fileIcon(mimeType: mimeType, fileName: fileName))
        #endif
    }

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

/// Names the app makes up for media that arrives without one: a Photos pick ("photo-1A2B3C4D"), a
/// camera shot ("camera-1A2B3C4D") or a pasted image ("pasted-image-1"), each with its extension.
/// They name nothing the person chose, so the image viewer does not show them.
enum OpenClawChatGeneratedAttachmentName {
    enum Source: String, CaseIterable {
        case photo
        case video
        case camera
    }

    private static let pastedPrefix = "pasted-image-"
    private static let tokenLength = 8

    static func picked(_ source: Source) -> String {
        "\(source.rawValue)-\(UUID().uuidString.prefix(self.tokenLength))"
    }

    static func pasted(index: Int) -> String {
        "\(self.pastedPrefix)\(index + 1)"
    }

    /// Whether `fileName` is one of the names above. Processing may change the extension
    /// ("photo-1A2B3C4D.heic" is sent as ".jpg"), so only the base name counts.
    static func isGenerated(_ fileName: String) -> Bool {
        let base = (fileName as NSString).deletingPathExtension
        if base.hasPrefix(self.pastedPrefix) {
            let index = base.dropFirst(self.pastedPrefix.count)
            return !index.isEmpty && index.allSatisfy(\.isASCII) && index.allSatisfy(\.isNumber)
        }
        return Source.allCases.contains { source in
            guard base.hasPrefix("\(source.rawValue)-") else { return false }
            let token = base.dropFirst(source.rawValue.count + 1)
            return token.count == self.tokenLength && token.allSatisfy { "0123456789ABCDEF".contains($0) }
        }
    }
}
