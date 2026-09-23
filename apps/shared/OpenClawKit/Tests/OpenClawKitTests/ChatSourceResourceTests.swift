import Foundation
import Testing
@testable import OpenClawChatUI

@Suite("Chat source resources", .timeLimit(.minutes(1)))
struct ChatSourceResourceTests {
    @Test func `accepted runtime config owns mount origin and preference without HTTP bootstrap`() async throws {
        let fixture = SourceResourceFixture(config: #"""
        {"runtimeConfig":{"gateway":{
            "publicOrigin":"https://public.example.com",
            "controlUi":{"basePath":"/control","automaticallyFetchFavicons":true}
        }}}
        """#)
        let loader = try self.loader(fixture)
        let context = await loader.loadContext()
        #expect(context?.gatewayURL.absoluteString == "https://gateway.example.com/socket")
        #expect(context?.basePath == "/control")
        #expect(context?.publicOrigin?.absoluteString == "https://public.example.com")
        #expect(context?.automaticallyFetchFavicons == true)
        _ = await loader.loadContext()
        #expect(await fixture.configReads == 1)
        #expect(await fixture.requests.isEmpty)
    }

    @Test func `accepted default config keeps resources root mounted despite socket path`() async throws {
        let fixture = SourceResourceFixture(config: #"{"runtimeConfig":{}}"#)
        let context = try await (self.loader(fixture)).loadContext()
        #expect(context?.basePath.isEmpty == true)
        #expect(context?.automaticallyFetchFavicons == true)
        #expect(await fixture.requests.isEmpty)
    }

    @Test(arguments: ["/team", "/team%2Fa/"])
    func `empty UI base path uses the explicitly supplied native control page mount`(mount: String) async throws {
        let fixture = SourceResourceFixture(config: #"{"runtimeConfig":{}}"#)
        let loader = try self.loader(fixture, nativeControlPage: "https://gateway.example.com" + mount)
        _ = await loader.loadFavicon(host: "docs.example.com")
        let expectedMount = mount.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        #expect(await fixture.requests.first?.url.absoluteString ==
            "https://gateway.example.com/" + expectedMount + "/__openclaw__/link-favicon/docs.example.com")
    }

    @Test func `explicit UI base path overrides the native control page mount`() async throws {
        let fixture = SourceResourceFixture(config: Self.enabledConfig)
        let loader = try self.loader(fixture, nativeControlPage: "https://gateway.example.com/socket")
        #expect(await loader.loadContext()?.basePath == "/control")
        _ = await loader.loadFavicon(host: "docs.example.com")
        #expect(await fixture.requests.first?.url.absoluteString ==
            "https://gateway.example.com/control/__openclaw__/link-favicon/docs.example.com")
    }

    @Test func `bootstrap with an empty UI base path preserves the native mount`() async throws {
        let fixture = SourceResourceFixture(config: nil, response: .json(
            #"{"basePath":"","automaticallyFetchFavicons":true}"#))
        let loader = try self.loader(fixture, nativeControlPage: "https://gateway.example.com/team/")
        #expect(await loader.loadContext()?.basePath == "/team")
        _ = await loader.loadFavicon(host: "docs.example.com")
        #expect(await fixture.requests.map(\.url.absoluteString) == [
            "https://gateway.example.com/team/control-ui-config.json",
            "https://gateway.example.com/team/__openclaw__/link-favicon/docs.example.com",
        ])
    }

    @Test func `limited config access uses bootstrap at the connection mount`() async throws {
        let fixture = SourceResourceFixture(config: nil, response: .json(
            #"{"basePath":"/control","automaticallyFetchFavicons":true,"publicOrigin":"https://untrusted.example"}"#))
        let context = try await (self.loader(fixture)).loadContext()
        #expect(context?.basePath == "/control")
        #expect(context?.automaticallyFetchFavicons == true)
        #expect(context?.publicOrigin == nil)
        #expect(await fixture.requests.map(\.url.absoluteString) == [
            "https://gateway.example.com/socket/control-ui-config.json",
        ])
    }

    @Test(arguments: [
        SourceResourceFixture.Response.json("broken json"),
        .json(#"{"basePath":"/control"}"#),
        .json(#"{"basePath":"/../other","automaticallyFetchFavicons":true}"#),
        .init(data: Data(), statusCode: 403, mimeType: "application/json"),
        .init(
            data: Data(#"{"basePath":"","automaticallyFetchFavicons":true}"#.utf8),
            statusCode: 200,
            mimeType: "text/html"),
    ])
    fileprivate func `unreadable bootstrap never enables favicon fetching`(
        response: SourceResourceFixture.Response) async throws
    {
        let fixture = SourceResourceFixture(config: "broken config", response: response)
        let loader = try self.loader(fixture)
        #expect(await loader.loadContext()?.automaticallyFetchFavicons == false)
        #expect(await loader.loadFavicon(host: "docs.example.com") == nil)
        #expect(await fixture.requests.count == 1)
    }

    @Test func `disabled preference prevents a favicon request`() async throws {
        let fixture = SourceResourceFixture(config: Self.disabledConfig)
        let loader = try self.loader(fixture)
        #expect(await loader.loadFavicon(host: "docs.example.com") == nil)
        #expect(await fixture.requests.isEmpty)
    }

    @Test(arguments: [
        SourceResourceFixture.Response(data: Data([1, 2, 3]), statusCode: 200, mimeType: "image/png"),
        .init(data: Data([1]), statusCode: 200, mimeType: "image/x-icon"),
        .init(data: Data([1]), statusCode: 200, mimeType: "text/html"),
        .init(data: Data([1]), statusCode: 302, mimeType: "image/png"),
        .init(data: Data([1]), statusCode: 401, mimeType: "image/png"),
        .init(data: Data(), statusCode: 200, mimeType: "image/png"),
        .init(data: Data(repeating: 1, count: 65536), statusCode: 200, mimeType: "image/png"),
        .init(data: Data(repeating: 1, count: 65537), statusCode: 200, mimeType: "image/png"),
    ])
    fileprivate func `favicon downloads stay mounted bounded and image typed`(
        response: SourceResourceFixture.Response) async throws
    {
        let fixture = SourceResourceFixture(config: Self.enabledConfig, response: response)
        let result = try await (self.loader(fixture)).loadFavicon(host: "DOCS.example.com")
        let accepted = response.statusCode == 200 && response.mimeType.hasPrefix("image/") &&
            !response.data.isEmpty && response.data.count <= 65536
        #expect(result == (accepted ? response.data : nil))
        let request = try #require(await fixture.requests.first)
        #expect(request.url.absoluteString ==
            "https://gateway.example.com/control/__openclaw__/link-favicon/docs.example.com")
        #expect(request.maximumBytes == 65536)
    }

    @Test(arguments: ["example.com/path", "example.com?token=x", "user@example.com", "example.com:443"])
    func `favicon hosts cannot change the request destination`(host: String) async throws {
        let fixture = SourceResourceFixture(config: Self.enabledConfig)
        #expect(try await (self.loader(fixture)).loadFavicon(host: host) == nil)
        #expect(await fixture.requests.isEmpty)
    }

    @Test(arguments: [true, false])
    func `concurrent and repeated hosts share successful and missing favicon results`(available: Bool) async throws {
        let fixture = SourceResourceFixture(
            config: Self.enabledConfig,
            response: .init(data: Data([1]), statusCode: available ? 200 : 404, mimeType: "image/png"),
            blocksRequest: true)
        let loader = try self.loader(fixture)
        let downloads = Task {
            await withTaskGroup(of: Data?.self, returning: [Data?].self) { group in
                for _ in 0..<12 {
                    group.addTask { await loader.loadFavicon(host: "docs.example.com") }
                }
                var results: [Data?] = []
                for await result in group {
                    results.append(result)
                }
                return results
            }
        }
        await fixture.waitUntilBlocked()
        await fixture.finishRequest()
        let expected = available ? Data([1]) : nil
        #expect(await downloads.value == Array(repeating: expected, count: 12))
        #expect(await loader.loadFavicon(host: "DOCS.example.com") == expected)
        #expect(await fixture.requests.count == 1)
    }

    @Test func `route retirement drops bytes already in flight`() async throws {
        let fixture = SourceResourceFixture(config: Self.enabledConfig, blocksRequest: true)
        let loader = try self.loader(fixture)
        let download = Task { await loader.loadFavicon(host: "docs.example.com") }
        await fixture.waitUntilBlocked()
        await fixture.retireRoute()
        await fixture.finishRequest()
        #expect(await download.value == nil)
        #expect(await loader.loadContext() == nil)
    }

    @Test func `config invalidation drops old bytes and refreshes the disabled preference`() async throws {
        let fixture = SourceResourceFixture(config: Self.enabledConfig, blocksRequest: true)
        let loader = try self.loader(fixture)
        let download = Task { await loader.loadFavicon(host: "docs.example.com") }
        await fixture.waitUntilBlocked()
        await fixture.setConfig(Self.disabledConfig)
        await loader.invalidate()
        await fixture.finishRequest()
        #expect(await download.value == nil)
        #expect(await loader.loadContext()?.automaticallyFetchFavicons == false)
        #expect(await loader.loadFavicon(host: "docs.example.com") == nil)
        #expect(await fixture.requests.count == 1)
    }

    @Test func `config invalidation rejects context loaded before the change`() async throws {
        let fixture = SourceResourceFixture(config: Self.enabledConfig, blocksConfig: true)
        let loader = try self.loader(fixture)
        let loading = Task { await loader.loadContext() }
        await fixture.waitUntilBlocked()
        await fixture.setConfig(Self.disabledConfig)
        await loader.invalidate()
        await fixture.finishRequest()
        #expect(await loading.value == nil)
        #expect(await loader.loadContext()?.automaticallyFetchFavicons == false)
        #expect(await fixture.configReads == 2)
    }

    @Test(arguments: [200, 401, 403, 404])
    func `proxy authorization is preserved and only authentication failures try the Gateway bearer`(
        firstStatus: Int) async throws
    {
        let fixture = SourceAuthorizationFixture(statuses: [firstStatus, 200])
        var request = try URLRequest(url: #require(URL(string: "https://gateway.example.com/control/resource")))
        request.setValue("Basic synthetic-proxy", forHTTPHeaderField: "Authorization")
        request.setValue("synthetic-edge", forHTTPHeaderField: "CF-Access-Token")
        let (_, response) = try await OpenClawChatSourceResources.performAuthenticatedRequest(
            request, bearer: "synthetic-gateway", send: { try await fixture.send($0) })
        let retries = firstStatus == 401 || firstStatus == 403
        #expect((response as? HTTPURLResponse)?.statusCode == (retries ? 200 : firstStatus))
        let requests = await fixture.requests
        #expect(requests.map { $0.value(forHTTPHeaderField: "Authorization") } ==
            (retries ? ["Basic synthetic-proxy", "Bearer synthetic-gateway"] : ["Basic synthetic-proxy"]))
        #expect(requests.allSatisfy { $0.value(forHTTPHeaderField: "CF-Access-Token") == "synthetic-edge" })
    }

    @Test func `auth fallback cannot dispatch after route retirement`() async throws {
        let fixture = SourceAuthorizationFixture(statuses: [401, 200], retiresAfterFirst: true)
        var request = try URLRequest(url: #require(URL(string: "https://gateway.example.com/resource")))
        request.setValue("Basic synthetic-proxy", forHTTPHeaderField: "Authorization")
        await #expect(throws: CancellationError.self) {
            try await OpenClawChatSourceResources.performAuthenticatedRequest(
                request, bearer: "synthetic-gateway", send: { try await fixture.send($0) })
        }
        #expect(await fixture.requests.count == 1)
    }

    @Test func `Gateway bearer without proxy authorization is sent once`() async throws {
        let fixture = SourceAuthorizationFixture(statuses: [401, 200])
        let request = try URLRequest(url: #require(URL(string: "https://gateway.example.com/resource")))
        _ = try await OpenClawChatSourceResources.performAuthenticatedRequest(
            request, bearer: "synthetic-gateway", send: { try await fixture.send($0) })
        #expect(await fixture.requests.map { $0.value(forHTTPHeaderField: "Authorization") } ==
            ["Bearer synthetic-gateway"])
    }

    @Test func `proxy-only auth never invents a Gateway credential`() async throws {
        let fixture = SourceAuthorizationFixture(statuses: [403, 200])
        var request = try URLRequest(url: #require(URL(string: "https://gateway.example.com/resource")))
        request.setValue("Basic synthetic-proxy", forHTTPHeaderField: "Authorization")
        _ = try await OpenClawChatSourceResources.performAuthenticatedRequest(
            request, bearer: nil, send: { try await fixture.send($0) })
        #expect(await fixture.requests.map { $0.value(forHTTPHeaderField: "Authorization") } ==
            ["Basic synthetic-proxy"])
    }

    private static let enabledConfig = #"""
    {"runtimeConfig":{"gateway":{"controlUi":{
        "basePath":"/control","automaticallyFetchFavicons":true
    }}}}
    """#
    private static let disabledConfig = #"""
    {"runtimeConfig":{"gateway":{"controlUi":{
        "basePath":"/control","automaticallyFetchFavicons":false
    }}}}
    """#

    private func loader(
        _ fixture: SourceResourceFixture,
        nativeControlPage: String? = nil) throws -> OpenClawChatSourceResources
    {
        try OpenClawChatSourceResources(
            gatewayURL: #require(URL(string: "wss://gateway.example.com/socket")),
            nativeControlPageURL: nativeControlPage.flatMap(URL.init(string:)),
            request: { try await fixture.request(url: $0, maximumBytes: $1) },
            loadConfig: { await fixture.loadConfig() },
            isCurrent: { await fixture.isCurrent })
    }
}

private actor SourceResourceFixture {
    struct Response: Sendable {
        let data: Data
        let statusCode: Int
        let mimeType: String

        static func json(_ body: String) -> Self {
            Self(data: Data(body.utf8), statusCode: 200, mimeType: "application/json")
        }
    }

    struct Request: Sendable {
        let url: URL
        let maximumBytes: Int
    }

    private var config: String?
    private let response: Response
    private let blocksRequest: Bool
    private let blocksConfig: Bool
    private var blockedRequest: CheckedContinuation<Void, Never>?
    private var blockedWaiter: CheckedContinuation<Void, Never>?
    private(set) var isCurrent = true
    private(set) var configReads = 0
    private(set) var requests: [Request] = []

    init(
        config: String?,
        response: Response = .init(data: Data([1]), statusCode: 200, mimeType: "image/png"),
        blocksRequest: Bool = false,
        blocksConfig: Bool = false)
    {
        self.config = config
        self.response = response
        self.blocksRequest = blocksRequest
        self.blocksConfig = blocksConfig
    }

    func loadConfig() async -> Data? {
        self.configReads += 1
        let data = self.config.map { Data($0.utf8) }
        if self.blocksConfig, self.configReads == 1 {
            await self.block()
        }
        return data
    }

    func setConfig(_ config: String) {
        self.config = config
    }

    func retireRoute() {
        self.isCurrent = false
    }

    func request(url: URL, maximumBytes: Int) async throws -> (Data, URLResponse) {
        self.requests.append(Request(url: url, maximumBytes: maximumBytes))
        if self.blocksRequest {
            await self.block()
        }
        let response = try #require(HTTPURLResponse(
            url: url,
            statusCode: self.response.statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": self.response.mimeType]))
        return (self.response.data, response)
    }

    private func block() async {
        await withCheckedContinuation { continuation in
            self.blockedRequest = continuation
            self.blockedWaiter?.resume()
            self.blockedWaiter = nil
        }
    }

    func waitUntilBlocked() async {
        guard self.blockedRequest == nil else { return }
        await withCheckedContinuation { self.blockedWaiter = $0 }
    }

    func finishRequest() {
        self.blockedRequest?.resume()
        self.blockedRequest = nil
    }
}

private actor SourceAuthorizationFixture {
    private var statuses: [Int]
    private let retiresAfterFirst: Bool
    private var isCurrent = true
    private(set) var requests: [URLRequest] = []

    init(statuses: [Int], retiresAfterFirst: Bool = false) {
        self.statuses = statuses
        self.retiresAfterFirst = retiresAfterFirst
    }

    func send(_ request: URLRequest) throws -> (Data, URLResponse) {
        guard self.isCurrent else { throw CancellationError() }
        self.requests.append(request)
        let url = try #require(request.url)
        let response = try #require(HTTPURLResponse(
            url: url,
            statusCode: self.statuses.removeFirst(),
            httpVersion: "HTTP/1.1",
            headerFields: [:]))
        if self.retiresAfterFirst { self.isCurrent = false }
        return (Data([1]), response)
    }
}
