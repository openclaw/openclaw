import Foundation
import Testing
@testable import OpenClawChatUI

struct ChatLinkPreviewExtractionTests {
    @Test func `extracts first bare web URL`() {
        #expect(chatFirstPreviewURL(in: "See https://example.com/first, then https://example.org/second")?
            .absoluteString ==
            "https://example.com/first")
    }

    @Test func `extracts markdown link destination`() {
        #expect(chatFirstPreviewURL(in: "Read [the article](https://example.com/story)")?.absoluteString ==
            "https://example.com/story")
    }

    @Test func `skips inline and block code`() {
        let markdown = """
        `https://inline.example`

        ```text
        https://fenced.example
        ```

            https://indented.example

        https://public.example
        """
        #expect(chatFirstPreviewURL(in: markdown)?.absoluteString == "https://public.example")
    }

    @Test func `filters schemes and does not inspect unsafe markdown link labels`() {
        let markdown = "[https://label.example](javascript:alert(1)) ftp://files.example https://safe.example"
        #expect(chatFirstPreviewURL(in: markdown)?.absoluteString == "https://safe.example")
        #expect(chatFirstPreviewURL(in: "mailto:test@example.com ftp://files.example") == nil)
    }
}

struct ChatLinkPreviewParserTests {
    @Test func `parses OpenGraph attributes in any order and resolves image`() throws {
        let baseURL = try #require(URL(string: "https://example.com/articles/page"))
        let html = """
        <html><head>
          <meta content='A &amp; B' data-extra='ignored' property='og:title'>
          <meta content="  First\n\tsecond &#x2603;  " name="og:description">
          <meta content="../cover.png?x=1&amp;y=2" property="og:image:url">
        </head></html>
        """
        let result = parseChatOpenGraph(html: html, baseURL: baseURL)
        let metadata = try #require(result.metadata)
        #expect(metadata.title == "A & B")
        #expect(metadata.description == "Firstsecond ☃")
        #expect(metadata.imageURL?.absoluteString == "https://example.com/cover.png?x=1&y=2")
    }

    @Test func `uses title fallback and decodes named and numeric entities`() throws {
        let baseURL = try #require(URL(string: "https://example.com"))
        let html = "<title>Tom &amp; Jerry &#35;1 &quot;Now&quot;</title>"
        let metadata = try #require(parseChatOpenGraph(html: html, baseURL: baseURL).metadata)
        #expect(metadata.title == "Tom & Jerry #1 \"Now\"")
    }

    @Test func `caps text and strips controls`() throws {
        let baseURL = try #require(URL(string: "https://example.com"))
        let title = String(repeating: "t", count: chatLinkPreviewTitleMaxCharacters + 20)
        let description = "start\u{0000}\u{0007}  " +
            String(repeating: "d", count: chatLinkPreviewDescriptionMaxCharacters + 20)
        let html = "<meta property='og:title' content='\(title)'>" +
            "<meta content='\(description)' property='og:description'>"
        let metadata = try #require(parseChatOpenGraph(html: html, baseURL: baseURL).metadata)
        #expect(metadata.title?.count == chatLinkPreviewTitleMaxCharacters)
        #expect(metadata.description?.count == chatLinkPreviewDescriptionMaxCharacters)
        #expect(metadata.description?.contains("\u{0000}") == false)
        #expect(metadata.description?.contains("\u{0007}") == false)
    }

    @Test func `fails without usable metadata`() throws {
        let baseURL = try #require(URL(string: "https://example.com"))
        #expect(parseChatOpenGraph(html: "<html><body>Nothing</body></html>", baseURL: baseURL) == .failed)
    }
}

struct ChatLinkPreviewHostPolicyTests {
    @Test(arguments: [
        "http://0.0.0.0",
        "http://10.0.0.1",
        "http://100.64.0.1",
        "http://100.127.255.254",
        "http://127.0.0.1",
        "http://127.1",
        "http://2130706433",
        "http://169.254.1.1",
        "http://172.16.0.1",
        "http://192.168.1.1",
        "http://224.0.0.1",
        "http://255.255.255.255",
        "http://[::]",
        "http://[::1]",
        "http://[fe80::1]",
        "http://[fc00::1]",
        "http://[fdff::1]",
        "http://[ff02::1]",
        "http://localhost",
        "http://subdomain.localhost",
        "http://host.local",
        "http://sub.host.local.",
    ])
    func `rejects non-public hosts`(_ value: String) throws {
        #expect(try !chatLinkPreviewAllowsHost(#require(URL(string: value))))
    }

    @Test(arguments: [
        "https://example.com",
        "http://1.1.1.1",
        "https://8.8.8.8",
        "https://[2606:4700:4700::1111]",
    ])
    func `accepts public hosts`(_ value: String) throws {
        #expect(try chatLinkPreviewAllowsHost(#require(URL(string: value))))
    }
}

struct ChatLinkPreviewFetcherDecisionTests {
    @Test func `redirect decision enforces hop limit and host policy`() throws {
        let originalURL = try #require(URL(string: "https://example.com/start"))
        let response = try #require(HTTPURLResponse(
            url: originalURL,
            statusCode: 302,
            httpVersion: nil,
            headerFields: ["Location": "https://example.org/next"]))
        let publicRequest = try URLRequest(url: #require(URL(string: "https://example.org/next")))
        let privateRequest = try URLRequest(url: #require(URL(string: "http://127.0.0.1/next")))

        #expect(chatLinkPreviewRedirectURL(
            response: response,
            request: publicRequest,
            redirectCount: 2) == publicRequest.url)
        #expect(chatLinkPreviewRedirectURL(
            response: response,
            request: publicRequest,
            redirectCount: 3) == nil)
        #expect(chatLinkPreviewRedirectURL(
            response: response,
            request: privateRequest,
            redirectCount: 0) == nil)
    }

    @Test func `body accumulator keeps only the prefix`() {
        var accumulator = ChatLinkPreviewBodyAccumulator()
        let firstReachedCap = accumulator.append(Data(repeating: 1, count: 64))
        let secondReachedCap = accumulator.append(Data(repeating: 2, count: chatLinkPreviewBodyMaxBytes))
        #expect(!firstReachedCap)
        #expect(secondReachedCap)
        #expect(accumulator.data.count == chatLinkPreviewBodyMaxBytes)
        #expect(accumulator.data.prefix(64) == Data(repeating: 1, count: 64))
    }
}

@Suite(.serialized)
struct ChatLinkPreviewFetcherTests {
    @Test func `fetches HTML only after an explicit call`() async throws {
        ChatLinkPreviewStubURLProtocol.set(.response(
            headers: ["Content-Type": "text/html; charset=utf-8"],
            data: Data("<meta property='og:title' content='Fetched title'>".utf8)))
        let fetcher = self.fetcher(timeout: 1)
        let url = try #require(URL(string: "https://preview.test/story"))

        #expect(ChatLinkPreviewStubURLProtocol.requestCount == 0)
        let metadata = try #require(await fetcher.fetch(url).metadata)
        #expect(metadata.title == "Fetched title")
        #expect(ChatLinkPreviewStubURLProtocol.requestCount == 1)
        #expect(ChatLinkPreviewStubURLProtocol.lastAcceptHeader == "text/html")
    }

    @Test func `total deadline can fire before the session starts`() async throws {
        ChatLinkPreviewStubURLProtocol.set(.hanging)
        let fetcher = self.fetcher(timeout: 0)
        let url = try #require(URL(string: "https://preview.test/slow"))
        let clock = ContinuousClock()
        let start = clock.now

        #expect(await fetcher.fetch(url) == .failed)
        #expect(start.duration(to: clock.now) < .seconds(1))
    }

    private func fetcher(timeout: TimeInterval) -> ChatLinkPreviewFetcher {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ChatLinkPreviewStubURLProtocol.self]
        return ChatLinkPreviewFetcher(
            configuration: configuration,
            timeout: timeout,
            hostPolicy: { _ in true },
            connectionPolicy: { _ in true })
    }
}

@MainActor
struct ChatLinkPreviewStoreTests {
    @Test func `cache hit avoids second fetch including negative results`() async throws {
        let counter = ChatLinkPreviewFetchCounter()
        let store = ChatLinkPreviewStore(maxEntries: 64) { _ in
            await counter.increment()
            return .failed
        }
        let url = try #require(URL(string: "https://example.com"))

        #expect(await store.get(url) == .failed)
        #expect(await store.get(url) == .failed)
        #expect(await counter.value == 1)
    }
}

private actor ChatLinkPreviewFetchCounter {
    private(set) var value = 0

    func increment() {
        self.value += 1
    }
}

private final class ChatLinkPreviewStubURLProtocol: URLProtocol, @unchecked Sendable {
    enum Stub {
        case response(headers: [String: String], data: Data)
        case hanging
    }

    private static let lock = NSLock()
    private nonisolated(unsafe) static var stub: Stub = .hanging
    private nonisolated(unsafe) static var requests = 0
    private nonisolated(unsafe) static var acceptHeader: String?

    static var requestCount: Int {
        self.lock.withLock { self.requests }
    }

    static var lastAcceptHeader: String? {
        self.lock.withLock { self.acceptHeader }
    }

    static func set(_ stub: Stub) {
        self.lock.withLock {
            self.stub = stub
            self.requests = 0
            self.acceptHeader = nil
        }
    }

    override class func canInit(with _: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        let stub = Self.lock.withLock { () -> Stub in
            Self.requests += 1
            Self.acceptHeader = self.request.value(forHTTPHeaderField: "Accept")
            return Self.stub
        }
        switch stub {
        case let .response(headers, data):
            guard let url = self.request.url,
                  let response = HTTPURLResponse(
                      url: url,
                      statusCode: 200,
                      httpVersion: nil,
                      headerFields: headers)
            else {
                self.client?.urlProtocol(self, didFailWithError: URLError(.badURL))
                return
            }
            self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            self.client?.urlProtocol(self, didLoad: data)
            self.client?.urlProtocolDidFinishLoading(self)
        case .hanging:
            break
        }
    }

    override func stopLoading() {}
}

extension ChatLinkPreviewResult {
    fileprivate var metadata: ChatLinkPreviewMetadata? {
        if case let .loaded(metadata) = self { return metadata }
        return nil
    }
}
