import Foundation
import OpenClawKit
import Testing

struct ShareDraftComposerTests {
    @Test(arguments: [
        "  sHaReD fRoM iOs.\t",
        "\ttExT:  ",
        "sHaReD aTtAcHmEnT(s):",
        "pLeAsE hElP mE wItH tHiS.",
    ])
    func `removes exact legacy scaffold lines case insensitively`(_ marker: String) {
        let payload = SharedContentPayload(title: nil, url: nil, text: marker)
        #expect(ShareDraftComposer.compose(from: payload).isEmpty)
    }

    @Test(arguments: [
        "Shared from iOS.",
        "Text:",
        "Shared attachment(s):",
        "Please help me with this.",
    ])
    func `preserves content that starts with a legacy scaffold marker`(_ marker: String) {
        let text = "\(marker) legitimate content"
        let payload = SharedContentPayload(title: nil, url: nil, text: text)
        #expect(ShareDraftComposer.compose(from: payload) == text)
    }

    @Test func `removes only exact scaffold lines from multiline content`() {
        let payload = SharedContentPayload(
            title: nil,
            url: nil,
            text: "Text: keep this\nShared from iOS.\nsecond line")

        #expect(ShareDraftComposer.compose(from: payload) == "Text: keep this\nsecond line")
    }

    @Test func `preserves whitespace around non scaffold content and between lines`() {
        let text = "  Text: keep this  \n\n\tsecond line\t\n  \nthird line  "
        let payload = SharedContentPayload(title: nil, url: nil, text: text)

        #expect(ShareDraftComposer.compose(from: payload) == text)
    }

    @Test(arguments: ["\n", "\r\n", "\r"])
    func `removing scaffold lines retains adjacent blank lines and indentation`(_ newline: String) {
        let payload = SharedContentPayload(
            title: nil,
            url: nil,
            text: [
                "Text:",
                "first line",
                "",
                "  Shared from iOS.\t",
                "\tsecond line",
                "",
                "Please help me with this.",
            ].joined(separator: newline))

        #expect(ShareDraftComposer
            .compose(from: payload) == "first line\(newline)\(newline)\tsecond line\(newline)\(newline)")
    }

    @Test func `composes sanitized title text and URL into the final draft`() throws {
        let url = try #require(URL(string: "https://example.com/article"))
        let payload = SharedContentPayload(
            title: "Text: title",
            url: url,
            text: "Shared attachment(s):\nText: body")

        #expect(ShareDraftComposer.compose(from: payload) ==
            "Text: title\n\nText: body\n\nhttps://example.com/article")
    }

    @Test func `omits nil and blank fragments`() {
        let payload = SharedContentPayload(title: nil, url: nil, text: "  \n")
        #expect(ShareDraftComposer.compose(from: payload).isEmpty)
    }

    @Test(arguments: [
        "Text: the quick brown fox",
        "tExT:",
        "mailto:hello@example.com",
        "https:",
    ])
    func `does not reinterpret ordinary shared text as a web URL`(_ text: String) {
        #expect(SharePayloadNormalizer.webURL(from: text) == nil)
    }

    @Test(arguments: [
        "https://example.com/article",
        " HTTP://example.com/path ",
    ])
    func `accepts web URLs supplied as plain text`(_ text: String) {
        #expect(SharePayloadNormalizer.webURL(from: text) != nil)
    }

    @Test func `URL mirror does not consume provider text admission`() throws {
        let url = try #require(URL(string: "https://example.com/article"))
        let mirrorOnly = SharePayloadNormalizer.distinctProviderText(
            "  https://example.com/article\n",
            sharedURL: url)
        #expect(mirrorOnly == nil)
        #expect(ShareDraftComposer.compose(from: SharedContentPayload(
            title: nil,
            url: url,
            text: mirrorOnly)) == "https://example.com/article")

        let text = mirrorOnly ?? SharePayloadNormalizer.distinctProviderText(
            "Article summary",
            sharedURL: url)

        #expect(text == "Article summary")
        #expect(ShareDraftComposer.compose(from: SharedContentPayload(
            title: nil,
            url: url,
            text: text)) == "Article summary\n\nhttps://example.com/article")
    }

    @Test func `first distinct provider text remains authoritative`() throws {
        let url = try #require(URL(string: "https://example.com/article"))

        let first = SharePayloadNormalizer.distinctProviderText("First provider text", sharedURL: url)
        let retained = first ?? SharePayloadNormalizer.distinctProviderText("Later provider text", sharedURL: url)

        #expect(retained == "First provider text")
    }

    @Test func `deduplicates attributed content that mirrors provider text or URL`() throws {
        let url = try #require(URL(string: "https://example.com/article"))
        #expect(SharePayloadNormalizer.distinctAttributedText(
            " Text: the quick brown fox ",
            sharedText: "\tText: the quick brown fox\n",
            sharedURL: nil) == nil)
        #expect(SharePayloadNormalizer.distinctAttributedText(
            "https://example.com/article",
            sharedText: nil,
            sharedURL: url) == nil)
    }

    @Test func `preserves attributed content that differs from provider data`() throws {
        let url = try #require(URL(string: "https://example.com/article"))
        #expect(SharePayloadNormalizer.distinctAttributedText(
            "  Article summary\n",
            sharedText: "Article body",
            sharedURL: url) == "  Article summary\n")
    }
}
