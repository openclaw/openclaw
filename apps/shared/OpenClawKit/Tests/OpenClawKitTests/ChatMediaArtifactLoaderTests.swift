import Foundation
import OpenClawChatUI
import OpenClawProtocol
import Testing

struct ChatMediaArtifactLoaderTests {
    @Test func `inline media does not resolve A network source`() async throws {
        let loaded = try await OpenClawChatMediaArtifactLoader.load(
            response: self.artifact(data: Data([1, 2, 3])), kind: .video, playback: .native)
        { _ in
            Issue.record("Inline media must not request a network route")
            throw CancellationError()
        }
        guard case let .data(media) = loaded else {
            Issue.record("Expected inline bytes")
            return
        }
        #expect(media.data == Data([1, 2, 3]))
        #expect(media.mimeType == "video/mp4")
    }

    @Test(arguments: [false, true])
    func `video uses direct stream or bounded download`(allowsStreaming: Bool) async throws {
        let url = try #require(URL(string: "https://gateway.example/media"))
        let loaded = try await OpenClawChatMediaArtifactLoader.load(
            response: self.artifact(), kind: .video, playback: .native)
        { path in
            #expect(path == "/media")
            return (url, allowsStreaming, { request in
                #expect(!allowsStreaming)
                #expect(request.value(forHTTPHeaderField: "Accept") == "video/*")
                #expect(request.value(forHTTPHeaderField: "Range") == nil)
                return try self.response(url: url, status: 200)
            })
        }
        switch loaded {
        case let .stream(stream):
            #expect(allowsStreaming)
            #expect(stream.url == url)
            #expect(stream.mimeType == "video/mp4")
            #expect(stream.sizeBytes == 3)
        case let .data(media):
            #expect(!allowsStreaming)
            #expect(media.data == Data([4, 5, 6]))
            #expect(media.mimeType == "video/mp4")
        case .preparing:
            Issue.record("Native playback must not be preparing")
        }
    }

    @Test(arguments: [200, 202, 403])
    func `transcode bypasses inline bytes and probes the rendition`(status: Int) async throws {
        let url = try #require(URL(string: "https://gateway.example/media?playback=1"))
        do {
            let loaded = try await OpenClawChatMediaArtifactLoader.load(
                response: self.artifact(data: Data([1, 2, 3])), kind: .video, playback: .transcode)
            { _ in
                (url, true, { request in
                    #expect(request.value(forHTTPHeaderField: "Range") == "bytes=0-0")
                    return try self.response(url: url, status: status)
                })
            }
            switch loaded {
            case let .stream(stream):
                #expect(status == 200)
                #expect(stream.url == url)
            case .preparing:
                #expect(status == 202)
            case .data:
                Issue.record("An unrestricted video rendition should stream")
            }
        } catch let error as OpenClawChatMediaArtifactLoader.LoadError {
            #expect(status == 403)
            #expect(error == .requestFailed(statusCode: 403))
        }
    }

    private func artifact(data: Data? = nil) -> ArtifactsDownloadResult {
        ArtifactsDownloadResult(
            artifact: ArtifactSummary(
                id: "synthetic", type: "media", title: "Video", mimetype: "video/mp4",
                sizebytes: 3, download: [:]),
            encoding: data == nil ? nil : "base64", data: data?.base64EncodedString(), url: "/media")
    }

    private func response(url: URL, status: Int) throws -> (Data, HTTPURLResponse) {
        let http = try #require(HTTPURLResponse(
            url: url, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "video/mp4"]))
        return (Data([4, 5, 6]), http)
    }
}
