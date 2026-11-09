import Foundation
import OpenClawChatUI
import OpenClawProtocol
import Testing
@testable import OpenClaw

@Suite("Session artifacts")
@MainActor
struct IOSSessionArtifactsModelTests {
    @Test func `catalog deduplicates identities but preserves homonyms without downloading their bytes`() async {
        let gateway = ArtifactGatewayFixture()
        let model = IOSSessionArtifactsModel(acquire: { await gateway.access() })
        await model.refresh()
        #expect(model.artifacts.map(\.id) == ["first", "second", "image"])
        #expect(model.artifacts[1].canDownload == false)
        #expect(await gateway.downloads == 0)
    }

    @Test func `refresh failure preserves prior catalog and reports error rather than an empty collection`() async {
        let gateway = ArtifactGatewayFixture()
        let model = IOSSessionArtifactsModel(acquire: { await gateway.access() })
        await model.refresh()
        await gateway.failNextList()
        await model.refresh()
        #expect(model.artifacts.count == 3)
        #expect(model.errorMessage != nil)
        #expect(model.hasLoaded)
        #expect(!model.isLoading)
    }

    @Test func `canceled presentation never publishes a late catalog`() async {
        let gate = ArtifactListGate()
        let model = IOSSessionArtifactsModel(acquire: {
            IOSSessionArtifactAccess(list: { await gate.list() }, download: { _ in throw CancellationError() })
        })
        let load = Task { await model.refresh() }
        await gate.waitUntilRequested()
        load.cancel()
        await gate.complete()
        await load.value
        #expect(model.artifacts.isEmpty)
        #expect(!model.hasLoaded)
        #expect(model.errorMessage == nil)
    }

    @Test func `explicit selection downloads its identity and unsupported selection cannot fetch`() async throws {
        let gateway = ArtifactGatewayFixture()
        let model = IOSSessionArtifactsModel(acquire: { await gateway.access() })
        await model.refresh()
        let file = try await model.download(model.artifacts[0])
        #expect(file.data == Data("first".utf8))
        await #expect(throws: IOSSessionArtifactsModel.ArtifactError.self) {
            try await model.download(model.artifacts[1])
        }
        #expect(await gateway.downloads == 1)
    }

    @Test func `retry reacquires a retired connection within the same presentation`() async {
        let gateway = RetiredArtifactConnection()
        let model = IOSSessionArtifactsModel(acquire: { await gateway.access() })
        await model.refresh()
        #expect(model.errorMessage != nil)
        #expect(!model.hasLoaded)
        await model.refresh()
        #expect(model.errorMessage == nil)
        #expect(model.artifacts.map(\.id) == ["image-without-mime"])
        #expect(model.artifacts[0].category == .images)
    }

    @Test(arguments: ["text/html", "image/svg+xml", "application/xml"])
    func `active document types have only literal text preview`(mime: String) {
        #expect(SessionArtifactDetail.previewKind(mimeType: mime) == .text)
    }

    @Test func `unknown formats never select a renderer`() {
        #expect(SessionArtifactDetail.previewKind(mimeType: "application/octet-stream") == .none)
        #expect(SessionArtifactDetail.previewKind(mimeType: "application/zip") == .none)
    }
}

private actor ArtifactGatewayFixture {
    private(set) var downloads = 0
    private var shouldFail = false

    func failNextList() {
        self.shouldFail = true
    }

    func access() -> IOSSessionArtifactAccess {
        IOSSessionArtifactAccess(list: { try await self.list() }, download: { await self.download($0) })
    }

    private func list() throws -> ArtifactsListResult {
        if self.shouldFail { throw URLError(.notConnectedToInternet) }
        return ArtifactsListResult(artifacts: [
            ArtifactSummary(
                id: "first",
                type: "file",
                title: "Report.pdf",
                mimetype: "application/pdf",
                download: ["mode": AnyCodable("bytes")]),
            ArtifactSummary(
                id: "second",
                type: "file",
                title: "Report.pdf",
                mimetype: "application/pdf",
                download: ["mode": AnyCodable("unsupported")]),
            ArtifactSummary(
                id: "image",
                type: "image",
                title: "Diagram.png",
                mimetype: "image/png",
                download: ["mode": AnyCodable("url")]),
            // The same managed artifact may appear in more than one transcript message.
            ArtifactSummary(
                id: "first",
                type: "file",
                title: "Report.pdf",
                mimetype: "application/pdf",
                download: ["mode": AnyCodable("bytes")]),
        ])
    }

    private func download(_ id: String) -> OpenClawChatMediaData {
        self.downloads += 1
        return OpenClawChatMediaData(data: Data(id.utf8), mimeType: "application/pdf")
    }
}

private actor ArtifactListGate {
    private var response: CheckedContinuation<ArtifactsListResult, Never>?
    private var started: CheckedContinuation<Void, Never>?

    func list() async -> ArtifactsListResult {
        await withCheckedContinuation { continuation in
            self.response = continuation
            self.started?.resume()
            self.started = nil
        }
    }

    func waitUntilRequested() async {
        if self.response != nil { return }
        await withCheckedContinuation { self.started = $0 }
    }

    func complete() {
        self.response?.resume(returning: ArtifactsListResult(artifacts: [
            ArtifactSummary(
                id: "late",
                type: "file",
                title: "Old conversation.txt",
                download: ["mode": AnyCodable("bytes")]),
        ]))
        self.response = nil
    }
}

private actor RetiredArtifactConnection {
    private var count = 0

    func access() -> IOSSessionArtifactAccess {
        self.count += 1
        let first = self.count == 1
        return IOSSessionArtifactAccess(list: {
            if first { throw CancellationError() }
            return ArtifactsListResult(artifacts: [
                ArtifactSummary(
                    id: "image-without-mime",
                    type: "image",
                    title: "Picture",
                    download: ["mode": AnyCodable("url")]),
            ])
        }, download: { _ in throw CancellationError() })
    }
}
