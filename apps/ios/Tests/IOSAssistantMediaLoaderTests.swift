import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

struct IOSAssistantMediaLoaderTests {
    private static let managedImagePath =
        "/api/chat/media/outgoing/agent%3Amain%3Amain/00000000-0000-4000-8000-000000000001/full"

    private actor RequestRecorder {
        private(set) var requests: [URLRequest] = []
        private(set) var tlsParameters: [GatewayTLSParams] = []

        func record(_ request: URLRequest, tls: GatewayTLSParams? = nil) {
            self.requests.append(request)
            if let tls {
                self.tlsParameters.append(tls)
            }
        }
    }

    @Test func `loads managed image from authenticated gateway route`() async throws {
        let recorder = RequestRecorder()
        let loader = self.makeLoader(token: "shared-token") { request in
            await recorder.record(request)
            return self.response(for: request, mimeType: "image/png", data: Data([1, 2, 3]))
        }

        let data = try await loader.load(path: Self.managedImagePath)
        let request = await recorder.requests.first

        #expect(data == Data([1, 2, 3]))
        #expect(request?.url?.absoluteString == "http://gateway.example\(Self.managedImagePath)")
        #expect(request?.url?.query == nil)
        #expect(request?.value(forHTTPHeaderField: "Authorization") == "Bearer shared-token")
        #expect(request?.value(forHTTPHeaderField: "Accept") == "image/*")
    }

    @Test func `loads legacy media path through authenticated preview route`() async throws {
        let recorder = RequestRecorder()
        let loader = self.makeLoader(token: "shared-token") { request in
            await recorder.record(request)
            return self.response(for: request, mimeType: "image/png", data: Data([9]))
        }

        _ = try await loader.load(path: "/tmp/QR code #1.png")
        let requests = await recorder.requests
        let request = try #require(requests.first)
        let requestURL = try #require(request.url)
        let components = try #require(URLComponents(url: requestURL, resolvingAgainstBaseURL: false))

        #expect(request.url?.path == "/openclaw/__openclaw__/assistant-media")
        #expect(components.queryItems?.first(where: { $0.name == "source" })?.value == "/tmp/QR code #1.png")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer shared-token")
    }

    @Test func `accepts canonically encoded slash in managed session key`() async throws {
        let recorder = RequestRecorder()
        let loader = self.makeLoader(token: nil) { request in
            await recorder.record(request)
            return self.response(for: request, mimeType: "image/png", data: Data([10]))
        }
        let source =
            "/api/chat/media/outgoing/session%2Fwith%2Fslash/00000000-0000-4000-8000-000000000001/full"

        _ = try await loader.load(path: source)

        let requests = await recorder.requests
        let requestURL = try #require(requests.first?.url)
        let components = try #require(URLComponents(url: requestURL, resolvingAgainstBaseURL: false))

        #expect(components.percentEncodedPath == source)
    }

    @Test func `uses stored operator token before password`() async throws {
        let recorder = RequestRecorder()
        let loader = self.makeLoader(
            token: nil,
            password: "gateway-password",
            storedOperatorToken: "device-token")
        { request in
            await recorder.record(request)
            return self.response(for: request, mimeType: "image/jpeg", data: Data([4]))
        }

        _ = try await loader.load(path: Self.managedImagePath)

        #expect(await recorder.requests.first?.value(forHTTPHeaderField: "Authorization") == "Bearer device-token")
    }

    @Test func `uses password when no token is available`() async throws {
        let recorder = RequestRecorder()
        let loader = self.makeLoader(token: nil, password: "gateway-password") { request in
            await recorder.record(request)
            return self.response(for: request, mimeType: "image/png", data: Data([5]))
        }

        _ = try await loader.load(path: Self.managedImagePath)

        #expect(await recorder.requests.first?.value(forHTTPHeaderField: "Authorization") == "Bearer gateway-password")
    }

    @Test func `sends sanitized proxy headers only over TLS`() async throws {
        let tlsRecorder = RequestRecorder()
        let tlsLoader = try makeLoader(
            url: #require(URL(string: "wss://gateway.example/openclaw")),
            token: nil,
            customHeaders: ["CF-Access-Client-Id": "client", "Host": "blocked"])
        { request in
            await tlsRecorder.record(request)
            return self.response(for: request, mimeType: "image/png", data: Data([6]))
        }
        _ = try await tlsLoader.load(path: Self.managedImagePath)

        let cleartextRecorder = RequestRecorder()
        let cleartextLoader = self.makeLoader(
            token: nil,
            customHeaders: ["CF-Access-Client-Id": "client"])
        { request in
            await cleartextRecorder.record(request)
            return self.response(for: request, mimeType: "image/png", data: Data([7]))
        }
        _ = try await cleartextLoader.load(path: Self.managedImagePath)

        #expect(await tlsRecorder.requests.first?.value(forHTTPHeaderField: "CF-Access-Client-Id") == "client")
        #expect(await tlsRecorder.requests.first?.value(forHTTPHeaderField: "Host") == nil)
        #expect(await cleartextRecorder.requests.first?.value(forHTTPHeaderField: "CF-Access-Client-Id") == nil)
    }

    @Test @MainActor func `resolves current connection inputs for every request`() async throws {
        let recorder = RequestRecorder()
        var connection = try makeConnection(
            url: #require(URL(string: "wss://first.example/base")),
            token: "first-token",
            tls: GatewayTLSParams(
                required: true,
                expectedFingerprint: "AA",
                allowTOFU: false,
                storeKey: "first"),
            customHeaders: ["X-Gateway": "first"])
        let loader = IOSAssistantMediaLoader(
            connectionProvider: { connection },
            requestFactory: { tls, _ in
                { request in
                    await recorder.record(request, tls: tls)
                    return self.response(for: request, mimeType: "image/png", data: Data([8]))
                }
            })

        _ = try await loader.load(path: Self.managedImagePath)
        connection = try self.makeConnection(
            url: #require(URL(string: "wss://second.example/next")),
            token: "second-token",
            tls: GatewayTLSParams(
                required: true,
                expectedFingerprint: "BB",
                allowTOFU: false,
                storeKey: "second"),
            customHeaders: ["X-Gateway": "second"])
        _ = try await loader.load(path: Self.managedImagePath)

        let requests = await recorder.requests
        let tlsParameters = await recorder.tlsParameters
        #expect(requests.map { $0.url?.host } == ["first.example", "second.example"])
        #expect(requests.map { $0.value(forHTTPHeaderField: "Authorization") } == [
            "Bearer first-token",
            "Bearer second-token",
        ])
        #expect(requests.map { $0.value(forHTTPHeaderField: "X-Gateway") } == ["first", "second"])
        #expect(tlsParameters.map(\.expectedFingerprint) == ["AA", "BB"])
    }

    @Test func `rejects non-success status`() async {
        let loader = self.makeLoader(token: nil) { request in
            self.response(for: request, statusCode: 404, mimeType: "text/plain", data: Data())
        }

        await #expect(throws: IOSAssistantMediaLoader.LoadError.requestFailed(statusCode: 404)) {
            try await loader.load(path: Self.managedImagePath)
        }
    }

    @Test func `rejects non-image response`() async {
        let loader = self.makeLoader(token: nil) { request in
            self.response(for: request, mimeType: "text/html", data: Data("error".utf8))
        }

        await #expect(throws: IOSAssistantMediaLoader.LoadError.unsupportedMediaType) {
            try await loader.load(path: Self.managedImagePath)
        }
    }

    @Test func `accepts managed image at gateway byte limit`() async throws {
        let loader = self.makeLoader(token: nil) { request in
            self.response(
                for: request,
                mimeType: "image/png",
                data: Data(repeating: 0, count: IOSAssistantMediaLoader.maximumManagedImageBytes))
        }

        let data = try await loader.load(path: Self.managedImagePath)

        #expect(data.count == IOSAssistantMediaLoader.maximumManagedImageBytes)
    }

    @Test func `rejects managed image above gateway byte limit`() async {
        let loader = self.makeLoader(token: nil) { request in
            self.response(
                for: request,
                mimeType: "image/png",
                data: Data(repeating: 0, count: IOSAssistantMediaLoader.maximumManagedImageBytes + 1))
        }

        await #expect(throws: IOSAssistantMediaLoader.LoadError.payloadTooLarge) {
            try await loader.load(path: Self.managedImagePath)
        }
    }

    @Test func `keeps legacy preview byte limit separate`() async {
        let loader = self.makeLoader(token: nil) { request in
            self.response(
                for: request,
                mimeType: "image/png",
                data: Data(repeating: 0, count: IOSAssistantMediaLoader.maximumLegacyImageBytes + 1))
        }

        await #expect(throws: IOSAssistantMediaLoader.LoadError.payloadTooLarge) {
            try await loader.load(path: "/tmp/legacy.png")
        }
    }

    @Test(arguments: [
        "  ",
        "https://attacker.example/image.png",
        "data:image/png;base64,AAAA",
        "\(managedImagePath)?download=1",
        "\(managedImagePath)#fragment",
        "/api/chat/media/outgoing/session/not-a-uuid/full",
        "/api/chat/media/outgoing/session/00000000-0000-4000-8000-000000000001/full/extra",
        "/api/chat/media/outgoing/../../admin/00000000-0000-4000-8000-000000000001/full",
        "/api/chat/media/outgoing/../00000000-0000-4000-8000-000000000001/full",
        "/api/chat/media/outgoing/%2E%2E/00000000-0000-4000-8000-000000000001/full",
        "/api/chat/media/outgoing/session%2fslash/00000000-0000-4000-8000-000000000001/full",
        "/api/chat/media/outgoing/session%5Cbackslash/00000000-0000-4000-8000-000000000001/full",
    ])
    func `rejects unsupported source before network request`(source: String) async {
        let recorder = RequestRecorder()
        let loader = self.makeLoader(token: nil) { request in
            await recorder.record(request)
            return self.response(for: request, mimeType: "image/png", data: Data())
        }

        await #expect(throws: IOSAssistantMediaLoader.LoadError.invalidSource) {
            try await loader.load(path: source)
        }
        #expect(await recorder.requests.isEmpty)
    }

    private func makeLoader(
        url: URL = URL(string: "ws://gateway.example/openclaw")!,
        token: String?,
        password: String? = nil,
        storedOperatorToken: String? = nil,
        customHeaders: [String: String] = [:],
        request: @escaping IOSAssistantMediaLoader.Request) -> IOSAssistantMediaLoader
    {
        let connection = self.makeConnection(
            url: url,
            token: token,
            password: password,
            storedOperatorToken: storedOperatorToken,
            customHeaders: customHeaders)
        return IOSAssistantMediaLoader(
            connectionProvider: { connection },
            requestFactory: { _, _ in request })
    }

    private func makeConnection(
        url: URL,
        token: String?,
        password: String? = nil,
        storedOperatorToken: String? = nil,
        tls: GatewayTLSParams? = nil,
        customHeaders: [String: String] = [:]) -> IOSAssistantMediaLoader.Connection
    {
        IOSAssistantMediaLoader.Connection(
            config: self.makeConfig(url: url, token: token, password: password, tls: tls),
            storedOperatorToken: storedOperatorToken,
            customHeaders: customHeaders)
    }

    private func makeConfig(
        url: URL,
        token: String?,
        password: String?,
        tls: GatewayTLSParams? = nil) -> GatewayConnectConfig
    {
        GatewayConnectConfig(
            url: url,
            stableID: "gateway-1",
            tls: tls,
            token: token,
            bootstrapToken: nil,
            password: password,
            nodeOptions: GatewayConnectOptions(
                role: "node",
                scopes: [],
                caps: [],
                commands: [],
                permissions: [:],
                clientId: "test",
                clientMode: "node",
                clientDisplayName: "Test"))
    }

    private func response(
        for request: URLRequest,
        statusCode: Int = 200,
        mimeType: String,
        data: Data) -> (Data, URLResponse)
    {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: statusCode,
            httpVersion: nil,
            headerFields: ["Content-Type": mimeType])!
        return (data, response)
    }
}
