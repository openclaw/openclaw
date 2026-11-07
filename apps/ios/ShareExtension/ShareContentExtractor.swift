import Foundation
import OpenClawKit
import UniformTypeIdentifiers

struct ExtractedShareProviderContent {
    var originalText: String
    var payload: SharedContentPayload
    var imageProviders: [NSItemProvider]
    var attachmentSummary: ShareAttachmentSummary
}

@MainActor
enum ShareContentExtractor {
    static func extract(from items: [NSExtensionItem]) async -> ExtractedShareProviderContent {
        var originalTexts: [String] = []
        var title: String?
        var attributedContentText: String?
        var providers: [NSItemProvider] = []
        for item in items {
            originalTexts.append(contentsOf: [
                item.attributedTitle?.string,
                item.attributedContentText?.string,
            ].compactMap(\.self))
            if title == nil { title = item.attributedTitle?.string }
            if attributedContentText == nil { attributedContentText = item.attributedContentText?.string }
            providers.append(contentsOf: item.attachments ?? [])
        }

        var providersIncludedInDirectDraft = Set<ObjectIdentifier>()
        var sharedURL: URL?
        for provider in providers {
            guard let providerURL = await self.loadURL(from: provider) else { continue }
            guard !providerURL.isFileURL else { continue }
            originalTexts.append(providerURL.absoluteString)
            sharedURL = sharedURL ?? providerURL
            if sharedURL == providerURL {
                providersIncludedInDirectDraft.insert(ObjectIdentifier(provider))
            }
        }

        var sharedText: String?
        for provider in providers {
            guard let providerText = await self.loadText(from: provider) else { continue }
            if !self.isFileProvider(provider) { originalTexts.append(providerText) }
            guard let distinctText = SharePayloadNormalizer.distinctProviderText(
                providerText,
                sharedURL: sharedURL)
            else { continue }
            sharedText = sharedText ?? distinctText
            if sharedText == distinctText {
                providersIncludedInDirectDraft.insert(ObjectIdentifier(provider))
            }
        }

        var imageProviders: [NSItemProvider] = []
        var attachmentSummary = ShareAttachmentSummary()
        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                attachmentSummary.selectedImageCount += 1
                imageProviders.append(provider)
            } else if provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) {
                attachmentSummary.videoCount += 1
            } else if self.isFileProvider(provider) {
                attachmentSummary.fileCount += 1
            } else {
                // Preservation may load more values than the direct draft can represent.
                // Only providers included in that draft may bypass omission blocking.
                attachmentSummary.recordUnclassifiedProvider(
                    didIncludeContent: providersIncludedInDirectDraft.contains(ObjectIdentifier(provider)))
            }
        }

        let supplementalTitle = SharePayloadNormalizer.distinctAttributedText(
            attributedContentText,
            sharedText: sharedText,
            sharedURL: sharedURL)
        var seenTexts = Set<String>()
        let originalText = originalTexts
            .filter { !$0.isEmpty && seenTexts.insert($0).inserted }
            .joined(separator: "\n\n")
        return ExtractedShareProviderContent(
            originalText: originalText,
            payload: SharedContentPayload(title: title ?? supplementalTitle, url: sharedURL, text: sharedText),
            imageProviders: imageProviders,
            attachmentSummary: attachmentSummary)
    }

    private static func loadURL(from provider: NSItemProvider) async -> URL? {
        if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
           let url = await self.loadURLValue(from: provider)
        {
            return url
        }

        if provider.hasItemConformingToTypeIdentifier(UTType.text.identifier),
           let text = await self.loadTextValue(from: provider, typeIdentifier: UTType.text.identifier),
           let url = SharePayloadNormalizer.webURL(from: text)
        {
            return url
        }

        return nil
    }

    private static func loadText(from provider: NSItemProvider) async -> String? {
        for type in [UTType.plainText, .text] {
            if provider.hasItemConformingToTypeIdentifier(type.identifier),
               let text = await self.loadTextValue(from: provider, typeIdentifier: type.identifier)
            {
                return text
            }
        }

        if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
           let url = await self.loadURLValue(from: provider), !url.isFileURL
        {
            return url.absoluteString
        }

        return nil
    }

    private static func loadURLValue(from provider: NSItemProvider) async -> URL? {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { item, _ in
                continuation.resume(returning: (item as? URL) ?? (item as? String).flatMap(URL.init(string:)))
            }
        }
    }

    private static func loadTextValue(from provider: NSItemProvider, typeIdentifier: String) async -> String? {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: typeIdentifier, options: nil) { item, _ in
                continuation.resume(returning: (item as? String) ?? (item as? NSAttributedString)?.string)
            }
        }
    }
}

extension ShareContentExtractor {
    static func isFileProvider(_ provider: NSItemProvider) -> Bool {
        if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) { return true }
        return provider.registeredTypeIdentifiers.contains { identifier in
            guard let type = UTType(identifier) else { return false }
            return type.conforms(to: .data) && !type.conforms(to: .url) &&
                (!type.conforms(to: .text) ||
                    provider.suggestedName.map { !($0 as NSString).pathExtension.isEmpty } == true)
        }
    }

    /// Copy inside the provider callback: its temporary URL is invalid after return.
    /// One failed/unknown item rejects the whole import rather than dropping it.
    static func preserveFiles(from items: [NSExtensionItem], into directory: URL) async throws -> [URL] {
        let providers = items.flatMap { $0.attachments ?? [] }
        guard providers.count <= SharedDraftInbox.maximumItems else { throw SharedDraftError.full }
        var files: [URL] = []
        var remaining = SharedDraftInbox.maximumBytes
        for provider in providers {
            try Task.checkCancellation()
            if !self.isFileProvider(provider) {
                let text = await self.loadText(from: provider)
                let url = await self.loadURL(from: provider)
                if url?.isFileURL != true {
                    guard text != nil || url != nil else { throw SharedDraftError.unreadable }
                    continue
                }
                // A public.url provider may deliver a file URL without advertising
                // public.file-url. Reload and copy inside that provider's callback.
            }
            let folder = directory.appendingPathComponent(String(files.count), isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let url = try await self.copyFile(from: provider, into: folder, maximumBytes: remaining)
            let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize
            guard let size else { throw SharedDraftError.unreadable }
            remaining -= size
            files.append(url)
        }
        return files
    }

    private static func copyFile(
        from provider: NSItemProvider,
        into directory: URL,
        maximumBytes: Int) async throws -> URL
    {
        let type = provider.registeredTypeIdentifiers.first {
            UTType($0)?.conforms(to: .data) == true && UTType($0)?.conforms(to: .url) != true
        }
        let suggestedName = provider.suggestedName
        return try await withCheckedThrowingContinuation { continuation in
            let copy: @Sendable (URL?, Error?) -> Void = { source, error in
                do {
                    guard let source else { throw error ?? SharedDraftError.unreadable }
                    let scope = source.startAccessingSecurityScopedResource()
                    defer { if scope { source.stopAccessingSecurityScopedResource() } }
                    let values = try source.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
                    guard values.isRegularFile == true else { throw SharedDraftError.unreadable }
                    if let size = values.fileSize, size > maximumBytes { throw SharedDraftError.full }
                    var name = (suggestedName as NSString?)?.lastPathComponent ??
                        (type == nil ? source.lastPathComponent : "shared-item")
                    if (name as NSString).pathExtension.isEmpty {
                        let contentType = type.flatMap(UTType.init)
                        let suffix = contentType?.preferredFilenameExtension ??
                            (contentType?.conforms(to: .image) == true ? "png" : source.pathExtension)
                        if !suffix.isEmpty { name += "." + suffix }
                    }
                    guard !name.isEmpty, name != ".", name != ".." else { throw SharedDraftError.unreadable }
                    let destination = directory.appendingPathComponent(name)
                    let input = try FileHandle(forReadingFrom: source)
                    defer { try? input.close() }
                    guard FileManager.default.createFile(
                        atPath: destination.path,
                        contents: nil,
                        attributes: [.protectionKey: FileProtectionType
                            .completeUntilFirstUserAuthentication])
                    else { throw SharedDraftError.unreadable }
                    let output = try FileHandle(forWritingTo: destination)
                    defer { try? output.close() }
                    var count = 0
                    while let chunk = try input.read(upToCount: min(1024 * 1024, maximumBytes - count + 1)),
                          !chunk.isEmpty
                    {
                        count += chunk.count
                        guard count <= maximumBytes else { throw SharedDraftError.full }
                        try output.write(contentsOf: chunk)
                    }
                    guard count > 0 else { throw SharedDraftError.unreadable }
                    continuation.resume(returning: destination)
                } catch { continuation.resume(throwing: error) }
            }
            if let type {
                provider.loadFileRepresentation(forTypeIdentifier: type, completionHandler: copy)
            } else {
                let urlType = provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier)
                    ? UTType.fileURL.identifier : UTType.url.identifier
                provider.loadItem(forTypeIdentifier: urlType, options: nil) { item, error in
                    copy(item as? URL, error)
                }
            }
        }
    }
}
