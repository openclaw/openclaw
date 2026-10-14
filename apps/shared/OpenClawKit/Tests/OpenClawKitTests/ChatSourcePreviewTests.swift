import Foundation
import OpenClawKit
import Testing
@testable import OpenClawChatUI

@Suite("Chat source previews")
struct ChatSourcePreviewTests {
    private let runID = "source-run"
    private let first = "https://example.com/article"
    private let second = "https://example.org/page"

    @Test func `completed answer uses cited normalized results from its own run`() {
        let answer = self.answer("[First](\(self.first)#section) and [second](\(self.second)).")
        let search = self.search([
            self.row(self.first, title: "**Useful** title", snippet: "Recorded search snippet."),
            self.row(self.second, title: "Second page", snippet: "A second snippet."),
            self.row("https://uncited.example.com/", title: "Uncited", snippet: "Never shown."),
        ])
        let page = String(repeating: "A readable paragraph recorded from the fetched page. ", count: 3)
        var projector = ChatSourcePreviewProjector()
        let result = projector.project([
            self.search([self.row(self.first, title: "Wrong run", snippet: "Wrong run")], run: "other-run"),
            search,
            self.fetch(self.first, final: self.first, title: "Fetched title", text: "# Heading\n\n\(page)"),
            answer,
        ])[answer.id] ?? []
        #expect(result.map(\.title) == ["Fetched title", "Second page"])
        #expect(result.map(\.excerptKind) == [.page, .search])
        #expect(result.first?.excerpt == page.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    @Test func `Markdown code images and uncited text do not become sources`() {
        let answer = self.answer("""
        `[inline](\(self.first))`
        ```markdown
        [fenced](\(self.first))
        ```
        ![image](\(self.first))
        [Actual][ref]

        [ref]: \(self.second)
        """)
        var projector = ChatSourcePreviewProjector()
        let result = projector.project([
            self.search([self.row(self.first), self.row(self.second)]), answer,
        ])[answer.id] ?? []
        #expect(result.map(\.url.absoluteString) == [self.second])
    }

    @Test func `failures mismatched tool identity and unproven payloads are excluded`() throws {
        let answer = self.answer("[source](\(self.first))")
        let payload = self.searchPayload([self.row(self.first)])
        let cases: [[OpenClawChatMessage]] = [
            [self.tool(payload, name: "web_search", error: true)],
            [self.tool(payload, name: "exec")],
            [self.call("web_fetch"), self.tool(payload, name: "web_search")],
            [self.tool(["kind": "results", "results": [self.row(self.first)]], name: "web_search")],
            [self.fetch(self.first, final: self.first, status: 403)],
            [self.tool(payload, name: "web_search", run: "other-run")],
        ]
        for messages in cases {
            var projector = ChatSourcePreviewProjector()
            #expect((projector.project(messages + [answer])[answer.id] ?? []).isEmpty)
        }
        let raw: [String: Any] = [
            "role": "assistant", "__openclaw": ["runId": self.runID],
            "content": [[
                "type": "tool_result",
                "tool_use_id": "call",
                "name": "web_search",
                "runId": "other-run",
                "details": payload,
            ]],
        ]
        let contradictory = try JSONDecoder().decode(
            OpenClawChatMessage.self, from: JSONSerialization.data(withJSONObject: raw))
        var projector = ChatSourcePreviewProjector()
        #expect((projector.project([self.call("web_search"), contradictory, answer])[answer.id] ?? []).isEmpty)
        #expect(contradictory.content.first?.id == "call")
        let roundTrip = try JSONDecoder().decode(
            OpenClawChatMessage.self, from: JSONEncoder().encode(contradictory))
        #expect(roundTrip.content.first?.runId == "other-run")
    }

    @Test func `recorded redirects collapse aliases and later fetches refresh the destination`() {
        let answer = self.answer("[original](\(self.first)) and [destination](\(self.second))")
        let page = String(repeating: "Fresh page paragraph. ", count: 5)
        var projector = ChatSourcePreviewProjector()
        let result = projector.project([
            self.search([self.row(self.first, snippet: "Old search snippet")]),
            self.fetch(self.first, final: self.second, title: "Initial destination"),
            self.fetch(self.second, final: self.second, title: "Refreshed destination", text: page),
            answer,
        ])[answer.id] ?? []
        #expect(result.count == 1)
        #expect(result.first?.url.absoluteString == self.second)
        #expect(result.first?.title == "Refreshed destination")
        #expect(result.first?.excerptKind == .page)
    }

    @Test func `page headings and provider answers never masquerade as recorded excerpts`() {
        let answer = self.answer("[source](\(self.first))")
        var projector = ChatSourcePreviewProjector()
        let result = projector.project([
            self.tool([
                "kind": "answer", "externalContent": self.external("web_search"),
                "answer": self.wrap("Combined answer", name: "web_search"),
                "citations": [self.row(self.first)],
            ], name: "web_search"),
            self.fetch(self.first, final: self.first, text: "# Heading\n\n- Navigation\n- More navigation"),
            answer,
        ])[answer.id] ?? []
        #expect(result.count == 1)
        #expect(result.first?.excerpt == nil)
    }

    @Test func `credentials unsafe schemes and dedicated GitHub items are excluded before card limit`() {
        let excluded = (1...9).map { "https://github.com/example/project/issues/\($0)" }
            + ["https://user:password@example.com/private", "javascript:alert(1)"]
        let valid = ["https://github.com/example/project", "https://docs.example.com/chat/guide"]
        let links = excluded + valid + [self.first]
        let answer = self.answer(links.map { "[link](\($0))" }.joined(separator: " "))
        var projector = ChatSourcePreviewProjector()
        let result = projector.project([
            self.search(links.map { self.row($0) }),
            self.fetch(self.first, final: "https://github.com/example/project/pull/42"),
            answer,
        ])[answer.id] ?? []
        #expect(result.map(\.url.absoluteString) == valid)
    }

    @Test func `session links and redirect targets are excluded only at the configured origins before the limit`() throws {
        let context = try OpenClawChatSourceContext(
            gatewayURL: #require(URL(string: "https://gateway.example.com/control/")),
            basePath: "/control",
            publicOrigin: URL(string: "https://public.example.com"))
        let sessions = (1...9).map { "https://gateway.example.com/control/chat/main/session-\($0)" }
        let links = sessions + [
            "https://public.example.com/control/dashboard/main",
            self.first,
            "https://external.example.com/control/chat/main",
            "https://gateway.example.com/control/chat",
            "https://gateway.example.com/docs/chat/guide",
        ]
        let answer = self.answer(links.map { "[link](\($0))" }.joined(separator: " "))
        var projector = ChatSourcePreviewProjector()
        let result = projector.project([
            self.search(links.map { self.row($0) }),
            self.fetch(self.first, final: "https://gateway.example.com/control/chat/main/redirect"), answer,
        ], context: context)[answer.id] ?? []
        #expect(result.map(\.url.absoluteString) == Array(links.suffix(3)))
    }

    @Test(arguments: [
        (native: "/team%20a", configured: "", encoded: "/team%20a", distinct: "/team%2520a"),
        (native: "/%E7%A0%94%E7%A9%B6", configured: "", encoded: "/%E7%A0%94%E7%A9%B6", distinct: "/research"),
        (native: "/team%2Fa", configured: "", encoded: "/team%2Fa", distinct: "/team/a"),
        (native: "/socket", configured: "/team a", encoded: "/team%20a", distinct: "/team%2520a"),
        (native: "/socket", configured: "/研究", encoded: "/%E7%A0%94%E7%A9%B6", distinct: "/research"),
    ])
    func `loaded context excludes encoded mounted sessions without collapsing distinct paths`(
        mount: (native: String, configured: String, encoded: String, distinct: String)) async throws
    {
        let origin = "https://gateway.example.com"
        let publicOrigin = "https://public.example.com"
        let config = try JSONSerialization.data(withJSONObject: [
            "runtimeConfig": ["gateway": [
                "controlUi": ["basePath": mount.configured],
                "publicOrigin": publicOrigin,
            ]],
        ])
        let gatewayURL = try #require(URL(string: "wss://gateway.example.com/socket"))
        let controlPageURL = try #require(URL(string: origin + mount.native))
        let resources = OpenClawChatSourceResources(
            gatewayURL: gatewayURL,
            nativeControlPageURL: controlPageURL,
            request: { _, _ in
                Issue.record("Accepted configuration should not require an HTTP bootstrap request")
                throw URLError(.unsupportedURL)
            },
            loadConfig: { config },
            isCurrent: { true })
        let loadedContext = await resources.loadContext()
        let context = try #require(loadedContext)
        let session = origin + mount.encoded + "/chat/main/~key/session"
        let dashboard = publicOrigin + mount.encoded + "/dashboard/main/session"
        let distinct = origin + mount.distinct + "/chat/main/session"
        let external = "https://external.example.com" + mount.encoded + "/chat/main/session"
        let links = [session, dashboard, self.first, distinct, external, self.second]
        let answer = self.answer(links.map { "[link](\($0))" }.joined(separator: " "))
        var projector = ChatSourcePreviewProjector()
        let result = projector.project([
            self.search(links.map { self.row($0) }),
            self.fetch(self.first, final: session),
            answer,
        ], context: context)[answer.id] ?? []
        #expect(context.basePath == mount.encoded)
        #expect(result.map(\.url.absoluteString) == [distinct, external, self.second])
    }

    @Test func `caps cards in citation order while keeping observed aliases for generic link suppression`() throws {
        let links = (1...10).map { "https://example.com/article-\($0)" }
        let answer = self.answer(links.map { "[link](\($0))" }.joined(separator: " "))
        var projector = ChatSourcePreviewProjector()
        let result = projector.project([
            self.search(links.map { self.row($0) }),
            self.fetch(links[0], final: self.second), answer,
        ])[answer.id] ?? []
        #expect(result.count == 8)
        #expect(result.first?.url.absoluteString == self.second)
        #expect(result.first?.represents(URL(string: links[0] + "#section")!) == true)
        #expect(try result.first?
            .represents(#require(URL(string: "https://github.com/example/project/issues/1"))) == false)
    }

    @Test(arguments: [
        "https://example.com",
        "https://EXAMPLE.com/",
        "https://example.com:443",
        "https://EXAMPLE.com:443/#section",
        "http://EXAMPLE.com:80",
    ])
    func `generic preview aliases match the projected source`(citation: String) throws {
        let markdown = "[Source](\(citation))"
        let answer = self.answer(markdown)
        var projector = ChatSourcePreviewProjector()
        let sources = projector.project([self.search([self.row(citation)]), answer])[answer.id] ?? []
        let source = try #require(sources.first)
        let genericPreview = try #require(chatFirstPreviewURL(in: markdown))
        #expect(source.represents(genericPreview))
        #expect(try !source.represents(#require(URL(string: "https://example.com:8443/"))))
        #expect(try !source.represents(#require(URL(string: "https://user:password@example.com/"))))
    }

    @Test func `refresh invalidates only changed transcript inputs and removes deleted sources`() {
        let answer = self.answer("[source](\(self.first))")
        let resultID = UUID()
        var projector = ChatSourcePreviewProjector()
        let original = self.tool(
            self.searchPayload([self.row(self.first, title: "Original")]),
            name: "web_search",
            id: resultID)
        #expect(projector.project([original, answer])[answer.id]?.first?.title == "Original")
        #expect(projector.project([original, answer])[answer.id]?.first?.title == "Original")
        let refreshed = self.tool(
            self.searchPayload([self.row(self.first, title: "Refreshed")]),
            name: "web_search",
            id: resultID)
        #expect(projector.project([refreshed, answer])[answer.id]?.first?.title == "Refreshed")
        #expect((projector.project([answer])[answer.id] ?? []).isEmpty)
    }

    @Test func `inline results and JSON result text retain invocation and canonical run ownership`() throws {
        let payload = self.searchPayload([self.row(self.first, snippet: "The <think> tag is literal source content.")])
        let answer = self.answer("[source](\(self.first))")
        let raw: [String: Any] = [
            "role": "assistant", "runId": "ignored-transport-run", "__openclaw": ["runId": self.runID],
            "content": [
                ["type": "toolCall", "id": "call", "name": "web_search", "arguments": [:]],
                ["type": "tool_result", "tool_use_id": "call", "details": payload],
            ],
        ]
        let inline = try JSONDecoder().decode(
            OpenClawChatMessage.self, from: JSONSerialization.data(withJSONObject: raw))
        let jsonText = try String(decoding: JSONSerialization.data(withJSONObject: payload), as: UTF8.self)
        let textResult = OpenClawChatMessage(
            role: "toolResult",
            content: [.init(type: "text", text: jsonText, mimeType: nil, fileName: nil, content: nil)],
            timestamp: 2, transcriptRunID: self.runID, toolName: "web_search")
        var projector = ChatSourcePreviewProjector()
        #expect(projector.project([inline, answer])[answer.id]?.first?.title == "Source title")
        #expect(projector.project([textResult, answer])[answer.id]?.first?.title == "Source title")
        #expect((projector.project([answer, inline])[answer.id] ?? []).isEmpty)
    }

    @Test func `unfinished replies and unwrapped source prose never become completed previews`() {
        let commentary = OpenClawChatMessage(
            role: "assistant",
            content: [.init(type: "text", text: "[source](\(self.first))", mimeType: nil, fileName: nil, content: nil)],
            timestamp: 3, transcriptRunID: self.runID, phase: "commentary")
        let answer = self.answer("[source](\(self.first))")
        let result = self.search([["url": self.first, "title": "Unwrapped title", "snippet": "Unwrapped snippet"]])
        var projector = ChatSourcePreviewProjector()
        let previews = projector.project([result, commentary, answer])
        #expect(previews[commentary.id] == nil)
        #expect(previews[answer.id]?.first?.title == "example.com")
        #expect(previews[answer.id]?.first?.excerpt == nil)
    }

    @Test func `bare cited URLs retain reading order without using URLs inside code`() {
        let answer = self.answer("""
        `https://code.example.com/inline`
        ```text
        https://code.example.com/fenced
        ```
        Read \(self.second), followed by \(self.first)#section.
        """)
        var projector = ChatSourcePreviewProjector()
        let result = projector.project([
            self.search([
                self.row("https://code.example.com/inline"),
                self.row("https://code.example.com/fenced"),
                self.row(self.first), self.row(self.second),
            ]), answer,
        ])[answer.id] ?? []
        #expect(result.map(\.url.absoluteString) == [self.second, self.first])
    }

    private func answer(_ text: String) -> OpenClawChatMessage {
        OpenClawChatMessage(
            role: "assistant", content: [.init(type: "text", text: text, mimeType: nil, fileName: nil, content: nil)],
            timestamp: 3, transcriptRunID: self.runID, stopReason: "stop", phase: "final_answer")
    }

    private func call(_ name: String) -> OpenClawChatMessage {
        OpenClawChatMessage(
            role: "assistant", content: [.init(
                type: "toolCall", text: nil, mimeType: nil, fileName: nil, content: nil,
                id: "call", name: name, arguments: AnyCodable([:]))],
            timestamp: 1, transcriptRunID: self.runID)
    }

    private func tool(
        _ payload: [String: Any], name: String, error: Bool = false,
        run: String? = nil, id: UUID = UUID()) -> OpenClawChatMessage
    {
        OpenClawChatMessage(
            id: id, role: "toolResult", content: [], timestamp: 2, transcriptRunID: run ?? self.runID,
            toolCallId: "call", toolName: name, details: AnyCodable(payload), isError: error)
    }

    private func search(_ rows: [[String: Any]], run: String? = nil) -> OpenClawChatMessage {
        self.tool(self.searchPayload(rows), name: "web_search", run: run)
    }

    private func searchPayload(_ rows: [[String: Any]]) -> [String: Any] {
        ["kind": "results", "results": rows, "externalContent": self.external("web_search")]
    }

    private func row(
        _ url: String,
        title: String = "Source title",
        snippet: String = "Recorded snippet") -> [String: Any]
    {
        ["url": url, "title": self.wrap(title, name: "web_search"), "snippet": self.wrap(snippet, name: "web_search")]
    }

    private func fetch(
        _ url: String, final: String, status: Int = 200, title: String = "Page title",
        text: String = "") -> OpenClawChatMessage
    {
        self.tool([
            "url": url, "finalUrl": final, "status": status, "externalContent": self.external("web_fetch"),
            "title": self.wrap(title, name: "web_fetch"), "text": self.wrap(text, name: "web_fetch"),
        ], name: "web_fetch")
    }

    private func external(_ name: String) -> [String: Any] {
        ["source": name, "untrusted": true, "wrapped": true]
    }

    private func wrap(_ text: String, name: String) -> String {
        """
        <<<EXTERNAL_UNTRUSTED_CONTENT id="0123456789abcdef">>>
        Source: \(name == "web_search" ? "Web Search" : "Web Fetch")
        ---
        \(text)
        <<<END_EXTERNAL_UNTRUSTED_CONTENT id="0123456789abcdef">>>
        """
    }
}
