import Foundation
import Testing
@testable import Clawdis

@Suite(.serialized)
struct WebChatServerTests {
    private func waitForBaseURL(server: WebChatServer, timeoutSeconds: TimeInterval = 2.0) async throws -> URL {
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        while Date() < deadline {
            if let url = server.baseURL() { return url }
            try await Task.sleep(nanoseconds: 25_000_000) // 25ms
        }
        throw NSError(domain: "WebChatServerTests", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "server did not become ready",
        ])
    }

    private func request(_ method: String, url: URL) async throws -> (status: Int, data: Data, headers: [AnyHashable: Any]) {
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: 2)
        req.httpMethod = method
        let config = URLSessionConfiguration.ephemeral
        config.waitsForConnectivity = false
        let session = URLSession(configuration: config)
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw NSError(domain: "WebChatServerTests", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "expected HTTPURLResponse",
            ])
        }
        return (status: http.statusCode, data: data, headers: http.allHeaderFields)
    }

    @Test func servesIndexAtWebChatRoot() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("clawdis-webchat-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        try Data("<html>ok</html>".utf8).write(to: root.appendingPathComponent("index.html"))

        let server = WebChatServer()
        server.start(root: root, preferredPort: nil)
        defer { server.stop() }

        let base = try await waitForBaseURL(server: server)
        let res = try await request("GET", url: base)
        #expect(res.status == 200)
        #expect(String(data: res.data, encoding: .utf8)?.contains("ok") == true)
    }

    @Test func headOmitsBody() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("clawdis-webchat-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        try Data("hello".utf8).write(to: root.appendingPathComponent("asset.txt"))

        let server = WebChatServer()
        server.start(root: root, preferredPort: nil)
        defer { server.stop() }

        let base = try await waitForBaseURL(server: server)
        let url = URL(string: "asset.txt", relativeTo: base)!
        let head = try await request("HEAD", url: url)
        #expect(head.status == 200)
        #expect(head.data.isEmpty == true)
        #expect((head.headers["Content-Length"] as? String) == "5")
    }

    @Test func returns404ForMissing() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("clawdis-webchat-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        try Data("<html>ok</html>".utf8).write(to: root.appendingPathComponent("index.html"))

        let server = WebChatServer()
        server.start(root: root, preferredPort: nil)
        defer { server.stop() }

        let base = try await waitForBaseURL(server: server)
        let url = URL(string: "missing.txt", relativeTo: base)!
        let res = try await request("GET", url: url)
        #expect(res.status == 404)
    }

    @Test func forbidsTraversalOutsideRoot() async throws {
        let tmp = FileManager.default.temporaryDirectory
        let root = tmp.appendingPathComponent("clawdis-webchat-test-root-\(UUID().uuidString)")
        let outside = tmp.appendingPathComponent("clawdis-webchat-test-outside-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.removeItem(at: root)
            try? FileManager.default.removeItem(at: outside)
        }

        try Data("<html>ok</html>".utf8).write(to: root.appendingPathComponent("index.html"))
        try Data("secret".utf8).write(to: outside.appendingPathComponent("secret.txt"))

        let server = WebChatServer()
        server.start(root: root, preferredPort: nil)
        defer { server.stop() }

        let base = try await waitForBaseURL(server: server)
        // Avoid `URL` normalizing away the `/webchat/../` segment by setting the encoded path directly.
        var comps = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        comps.percentEncodedPath = "/webchat/../\(outside.lastPathComponent)/secret.txt"
        let url = comps.url!
        let res = try await request("GET", url: url)
        #expect(res.status == 403)
    }
}
