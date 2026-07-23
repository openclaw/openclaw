import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

struct IOSAssistantMediaLoaderTests {
    private actor RequestRecorder {
        private(set) var request: URLRequest?

        func record(_ request: URLRequest) {
            self.request = request
        }
    }

    @Test func `loads image through encoded gateway media route`() async throws {
        let recorder = RequestRecorder()
        let loader = self.makeLoader(token: "shared-token") { request in
            await recorder.record(request)
            return self.response(for: request, mimeType: "image/png", data: Data([1, 2, 3]))
        }

        let data = try await loader.load(path: "/tmp/QR code #1.png")
        let request = await recorder.request

        #expect(data == Data([1, 2, 3]))
        #expect(request?.url?.path == "/openclaw/__openclaw__/assistant-media")
        #expect(try URLComponents(url: #require(request?.url), resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "source" })?.value == "/tmp/QR code #1.png")
        #expect(request?.value(forHTTPHeaderField: "Authorization") == "Bearer shared-token")
        #expect(request?.value(forHTTPHeaderField: "Accept") == "image/*")
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

        _ = try await loader.load(path: "media/inbound/photo.jpg")

        #expect(await recorder.request?.value(forHTTPHeaderField: "Authorization") == "Bearer device-token")
    }

    @Test func `uses password when no token is available`() async throws {
        let recorder = RequestRecorder()
        let loader = self.makeLoader(token: nil, password: "gateway-password") { request in
            await recorder.record(request)
            return self.response(for: request, mimeType: "image/png", data: Data([5]))
        }

        _ = try await loader.load(path: "/tmp/image.png")

        #expect(await recorder.request?.value(forHTTPHeaderField: "Authorization") == "Bearer gateway-password")
    }

    @Test func `sends sanitized proxy headers only over TLS`() async throws {
        let tlsRecorder = RequestRecorder()
        let tlsLoader = try self.makeLoader(
            url: #require(URL(string: "wss://gateway.example/openclaw")),
            token: nil,
            customHeaders: ["CF-Access-Client-Id": "client", "Host": "blocked"])
        { request in
            await tlsRecorder.record(request)
            return self.response(for: request, mimeType: "image/png", data: Data([6]))
        }
        _ = try await tlsLoader.load(path: "/tmp/image.png")

        let cleartextRecorder = RequestRecorder()
        let cleartextLoader = self.makeLoader(
            token: nil,
            customHeaders: ["CF-Access-Client-Id": "client"])
        { request in
            await cleartextRecorder.record(request)
            return self.response(for: request, mimeType: "image/png", data: Data([7]))
        }
        _ = try await cleartextLoader.load(path: "/tmp/image.png")

        #expect(await tlsRecorder.request?.value(forHTTPHeaderField: "CF-Access-Client-Id") == "client")
        #expect(await tlsRecorder.request?.value(forHTTPHeaderField: "Host") == nil)
        #expect(await cleartextRecorder.request?.value(forHTTPHeaderField: "CF-Access-Client-Id") == nil)
    }

    @Test func `rejects non-success status`() async {
        let loader = self.makeLoader(token: nil) { request in
            self.response(for: request, statusCode: 404, mimeType: "text/plain", data: Data())
        }

        await #expect(throws: IOSAssistantMediaLoader.LoadError.requestFailed(statusCode: 404)) {
            try await loader.load(path: "/tmp/missing.png")
        }
    }

    @Test func `rejects non-image response`() async {
        let loader = self.makeLoader(token: nil) { request in
            self.response(for: request, mimeType: "text/html", data: Data("error".utf8))
        }

        await #expect(throws: IOSAssistantMediaLoader.LoadError.unsupportedMediaType) {
            try await loader.load(path: "/tmp/image.png")
        }
    }

    @Test func `rejects oversized image response`() async {
        let loader = self.makeLoader(token: nil) { request in
            self.response(
                for: request,
                mimeType: "image/png",
                data: Data(repeating: 0, count: IOSAssistantMediaLoader.maximumImageBytes + 1))
        }

        await #expect(throws: IOSAssistantMediaLoader.LoadError.payloadTooLarge) {
            try await loader.load(path: "/tmp/image.png")
        }
    }

    @Test func `rejects blank source before network request`() async {
        let recorder = RequestRecorder()
        let loader = self.makeLoader(token: nil) { request in
            await recorder.record(request)
            return self.response(for: request, mimeType: "image/png", data: Data())
        }

        await #expect(throws: IOSAssistantMediaLoader.LoadError.invalidSource) {
            try await loader.load(path: "  ")
        }
        #expect(await recorder.request == nil)
    }

    private func makeLoader(
        url: URL = URL(string: "ws://gateway.example/openclaw")!,
        token: String?,
        password: String? = nil,
        storedOperatorToken: String? = nil,
        customHeaders: [String: String] = [:],
        request: @escaping IOSAssistantMediaLoader.Request) -> IOSAssistantMediaLoader
    {
        IOSAssistantMediaLoader(
            config: self.makeConfig(url: url, token: token, password: password),
            storedOperatorToken: storedOperatorToken,
            customHeaders: customHeaders,
            request: request)
    }

    private func makeConfig(url: URL, token: String?, password: String?) -> GatewayConnectConfig {
        GatewayConnectConfig(
            url: url,
            stableID: "gateway-1",
            tls: nil,
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
