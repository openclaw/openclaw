import Foundation
import OpenClawKit
import Testing
import UniformTypeIdentifiers

struct ShareContentExtractorTests {
    @Test @MainActor func `URL-only provider composes one URL`() async throws {
        let url = try #require(URL(string: "https://example.com/article"))
        let extracted = await ShareContentExtractor.extract(from: [
            self.extensionItem(providers: [self.itemProvider(url as NSURL, type: .url)]),
        ])

        #expect(extracted.payload.url == url)
        #expect(extracted.payload.text == nil)
        #expect(ShareDraftComposer.compose(from: extracted.payload) == url.absoluteString)
        #expect(extracted.attachmentSummary == ShareAttachmentSummary())
    }

    @Test @MainActor func `mirrored URL yields to later provider summary`() async throws {
        let url = try #require(URL(string: "https://example.com/article"))
        let extracted = await ShareContentExtractor.extract(from: [
            self.extensionItem(providers: [
                self.itemProvider(url as NSURL, type: .url),
                self.itemProvider(url.absoluteString as NSString, type: .plainText),
                self.itemProvider("Article summary" as NSString, type: .plainText),
            ]),
        ])

        #expect(extracted.payload.url == url)
        #expect(extracted.payload.text == "Article summary")
        #expect(ShareDraftComposer.compose(from: extracted.payload) ==
            "Article summary\n\nhttps://example.com/article")
        #expect(extracted.attachmentSummary == ShareAttachmentSummary())
    }

    @Test @MainActor func `provider extraction preserves attachment accounting`() async throws {
        let url = try #require(URL(string: "https://example.com/article"))
        let image = self.dataProvider(type: .image)
        let extracted = await ShareContentExtractor.extract(from: [
            self.extensionItem(providers: [
                self.itemProvider(url as NSURL, type: .url),
                self.itemProvider("Article summary" as NSString, type: .plainText),
                image,
                self.dataProvider(type: .movie),
                self.dataProvider(type: .fileURL),
                self.dataProvider(type: UTType(exportedAs: "ai.openclaw.tests.unknown")),
            ]),
        ])

        #expect(extracted.imageProviders.count == 1)
        #expect(extracted.imageProviders.first === image)
        #expect(extracted.attachmentSummary == ShareAttachmentSummary(
            selectedImageCount: 1,
            acceptedImageCount: 0,
            videoCount: 1,
            fileCount: 1,
            unknownCount: 1))
    }

    @MainActor
    private func extensionItem(providers: [NSItemProvider]) -> NSExtensionItem {
        let item = NSExtensionItem()
        item.attachments = providers
        return item
    }

    private func dataProvider(type: UTType) -> NSItemProvider {
        let provider = NSItemProvider()
        provider.registerDataRepresentation(forTypeIdentifier: type.identifier, visibility: .all) { completion in
            completion(Data([0x01]), nil)
            return nil
        }
        return provider
    }

    private func itemProvider(_ item: NSSecureCoding, type: UTType) -> NSItemProvider {
        NSItemProvider(item: item, typeIdentifier: type.identifier)
    }
}

extension ShareContentExtractorTests {
    @Test @MainActor func preservesAllTextAndMixedProviderBytesForNativeImport() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let types: [UTType] = [.pdf, .quickTimeMovie, .jpeg, .jpeg, .jpeg, .jpeg]
        let providers = types.enumerated().map { index, type in
            let provider = NSItemProvider()
            provider.suggestedName = "item-\(index)"
            provider.registerDataRepresentation(forTypeIdentifier: type.identifier, visibility: .all) { completion in
                completion(Data([UInt8(index), 0, 255]), nil)
                return nil
            }
            return provider
        }
        let first = NSExtensionItem()
        first.attributedContentText = NSAttributedString(string: "Original first paragraph")
        first.attachments = providers + [NSItemProvider(item: "Second paragraph" as NSString, typeIdentifier: UTType.plainText.identifier)]
        let second = NSExtensionItem()
        second.attributedContentText = NSAttributedString(string: "Third paragraph")
        let extracted = await ShareContentExtractor.extract(from: [first, second])
        #expect(extracted.originalText == "Original first paragraph\n\nThird paragraph\n\nSecond paragraph")
        let files = try await ShareContentExtractor.preserveFiles(from: [first, second], into: directory)
        #expect(files.count == 6)
        for (index, file) in files.enumerated() {
            #expect(try Data(contentsOf: file) == Data([UInt8(index), 0, 255]))
        }
        #expect(extracted.attachmentSummary.fileCount == 1)
        #expect(extracted.attachmentSummary.videoCount == 1)
        #expect(extracted.attachmentSummary.selectedImageCount == 4)
        let unknown = NSExtensionItem()
        unknown.attachments = [NSItemProvider()]
        do {
            _ = try await ShareContentExtractor.preserveFiles(from: [first, unknown], into: directory.appendingPathComponent("retry"))
            Issue.record("Unknown provider was silently omitted")
        } catch {}
    }
}

extension ShareContentExtractorTests {
    @Test @MainActor func copiesFileURLAdvertisedOnlyAsPublicURLRatherThanOmittingIt() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let original = directory.appendingPathComponent("original.pdf")
        try Data([0, 255, 42]).write(to: original)
        let provider = NSItemProvider(item: original as NSURL, typeIdentifier: UTType.url.identifier)
        let item = NSExtensionItem()
        item.attributedContentText = NSAttributedString(string: "Caption")
        item.attachments = [provider]
        let extracted = await ShareContentExtractor.extract(from: [item])
        #expect(extracted.originalText == "Caption")
        let files = try await ShareContentExtractor.preserveFiles(from: [item], into: directory.appendingPathComponent("copies"))
        #expect(files.count == 1)
        #expect(try Data(contentsOf: #require(files.first)) == Data([0, 255, 42]))
    }
}

extension ShareContentExtractorTests {
    @Test(arguments: [
        ["First paragraph", "Second paragraph"],
        ["https://example.com/one", "https://example.com/two", "https://example.com/three"],
        ["Paragraph", "https://example.com/one", "https://example.com/two"],
    ])
    @MainActor func directSendNeverOmitsAdditionalTextOrURLProviders(_ values: [String]) async throws {
        let providers = try values.map { value in
            if value.hasPrefix("https://") {
                return self.itemProvider(try #require(URL(string: value)) as NSURL, type: .url)
            }
            return self.itemProvider(value as NSString, type: .plainText)
        }
        let extracted = await ShareContentExtractor.extract(from: [self.extensionItem(providers: providers)])
        let directDraft = ShareDraftComposer.compose(from: extracted.payload)
        let includesEveryValue = values.allSatisfy { directDraft.contains($0) }
        let reason = ShareAttachmentBlockReason.resolve(
            hasImageProcessingError: false, summary: extracted.attachmentSummary)
        #expect(includesEveryValue || reason != nil)
        for value in values { #expect(extracted.originalText.contains(value)) }
        if !includesEveryValue {
            let blocked = try #require(reason)
            let controls = ShareComposeControlState.resolve(
                status: .blocked(blocked.message(recovery: .save)), hasDraftText: !directDraft.isEmpty)
            #expect(!controls.isSendEnabled)
        }
    }
}
