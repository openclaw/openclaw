import Foundation
import Testing
import UniformTypeIdentifiers

struct ShareContentExtractorTests {
    @Test(arguments: [
        "def greet(name):\n    message = f\"Hello, {name}\"\n\n    return message",
        "def greet(name):\n\tmessage = f\"Hello, {name}\"\n\n\treturn message",
        "def greet(name):\r\n    message = f\"Hello, {name}\"\r\n\r\n    return message",
        "def greet(name):\r    message = f\"Hello, {name}\"\r\r    return message",
        "    first line starts indented\n\tsecond line uses a tab\n\nText: ordinary prose stays.\nhttps://example.com/guide\n\nEnd of sample.",
        "\r\n    first line\r\n\tsecond line\r\n\r\n",
    ])
    @MainActor func `shared text retains indentation and blank lines`(_ text: String) async {
        let extracted = await ShareContentExtractor.extract(from: [
            self.extensionItem(providers: [self.itemProvider(text as NSString, type: .plainText)]),
        ])

        #expect(extracted.payload.text == text)
        #expect(ShareDraftComposer.compose(from: extracted.payload) == text)
        #expect(extracted.attachmentSummary == ShareAttachmentSummary())
    }

    @Test @MainActor func `attributed fallback retains boundary whitespace`() async {
        let text = "\n    first line\n\tsecond line\n\n"
        let item = self.extensionItem(providers: [])
        item.attributedContentText = NSAttributedString(string: text)
        #expect(item.attributedContentText?.string == text)

        let extracted = await ShareContentExtractor.extract(from: [item])

        #expect(extracted.payload.title == text)
        #expect(ShareDraftComposer.compose(from: extracted.payload) == text)
        #expect(extracted.attachmentSummary == ShareAttachmentSummary())
    }

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
                self.itemProvider("Article summary" as NSString, type: .plainText),
            ]),
        ])

        #expect(extracted.payload.url == url)
        #expect(extracted.payload.text == "Article summary")
        #expect(ShareDraftComposer.compose(from: extracted.payload) ==
            "Article summary\n\nhttps://example.com/article")
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
