#if os(iOS) && canImport(WebKit)
import Foundation
import Testing
@testable import OpenClawChatUI

@MainActor
struct ChatMermaidRendererTests {
    private let theme = ChatMermaidTheme(
        background: "#ffffff", foreground: "#111111", muted: "#666666",
        border: "#aaaaaa", accent: "#cc3333", fontFamily: "system-ui", darkMode: false)

    @Test func `canceling a coalesced subscriber leaves the other render alive`() async throws {
        let renderer = ChatMermaidRenderer()
        let request = self.request("flowchart LR\nA-->B")
        var canceledCompletionRan = false
        let token = try #require(renderer.render(request) { _ in canceledCompletionRan = true })
        let second = await withCheckedContinuation { continuation in
            renderer.render(request) { continuation.resume(returning: $0) }
            renderer.cancel(token)
        }
        let image = try second.get()
        #expect(!canceledCompletionRan)
        #expect(image.image.cgImage != nil)
        #expect(image.size.width == 320)
        #expect(image.size.height > 1)
    }

    @Test func `canceling the active document cannot publish into its replacement`() async throws {
        let renderer = ChatMermaidRenderer()
        var canceledCompletionRan = false
        let first = try #require(renderer.render(self.request("flowchart LR\nOld-->Gone")) { _ in
            canceledCompletionRan = true
        })
        renderer.cancel(first)

        let result = await self.render(self.request("flowchart LR\nCurrent-->Diagram"), using: renderer)
        let image = try result.get()
        #expect(!canceledCompletionRan)
        #expect(image.svg.contains("Current"))
        #expect(!image.svg.contains("Gone"))
    }

    @Test func `canceling a queued subscriber preserves the active and following requests`() async throws {
        let renderer = ChatMermaidRenderer()
        var firstResult: Result<ChatMermaidRenderedImage, ChatMermaidFailure>?
        var canceledCompletionRan = false
        _ = try #require(renderer.render(self.request("flowchart LR\nFirst-->Active")) { firstResult = $0 })
        let canceled = try #require(renderer.render(self.request("flowchart LR\nCanceled-->Queued")) { _ in
            canceledCompletionRan = true
        })
        let lastResult = await withCheckedContinuation { continuation in
            renderer.render(self.request("flowchart LR\nLast-->Retained")) { continuation.resume(returning: $0) }
            renderer.cancel(canceled)
        }
        let firstImage = try #require(firstResult).get()
        let lastImage = try lastResult.get()
        #expect(!canceledCompletionRan)
        #expect(firstImage.svg.contains("First"))
        #expect(lastImage.svg.contains("Retained"))
    }

    @Test func `a failed diagram cannot poison the next native render or its cache`() async throws {
        let renderer = ChatMermaidRenderer()
        let invalid = await self.render(self.request("flowchart LR\nA[unterminated"), using: renderer)
        guard case .failure = invalid else {
            Issue.record("Invalid Mermaid unexpectedly rendered")
            return
        }
        let request = self.request("flowchart LR\nRecovered-->Ready")
        let successful = await self.render(request, using: renderer)
        let image = try successful.get()
        var cacheImage: ChatMermaidRenderedImage?
        let pending = renderer.render(request) { result in cacheImage = try? result.get() }
        #expect(pending == nil)
        #expect(cacheImage?.image === image.image)
    }

    @Test func `entry pressure evicts only the least recently used diagram`() async throws {
        let renderer = ChatMermaidRenderer()
        let requests = (0..<33).map {
            self.request("flowchart LR\nA-->B\n%% diagram \($0)", width: 80, scale: 1)
        }
        var images: [ChatMermaidRenderedImage] = []
        for request in requests.prefix(32) {
            let result = await self.render(request, using: renderer)
            images.append(try result.get())
        }
        #expect(self.cachedImage(requests[0], using: renderer)?.image === images[0].image)
        let result = await self.render(requests[32], using: renderer)
        images.append(try result.get())
        // Keep this a count-limit regression, independent of WebKit's bitmap stride.
        try #require(images.reduce(0) { $0 + $1.byteCount } < 12 * 1024 * 1024)
        for index in requests.indices where index != 1 {
            #expect(self.cachedImage(requests[index], using: renderer)?.image === images[index].image)
        }
        #expect(self.cachedImage(requests[1], using: renderer) == nil)
    }

    @Test func `byte pressure evicts enough old diagrams without dropping recent or oversized results`() async throws {
        let source = "flowchart LR\nA-->B"
        let probe = await self.render(self.request(source, scale: 1), using: ChatMermaidRenderer())
        let size = try probe.get().size
        // Choose scales from the real layout, then check actual bitmap + SVG + source costs.
        let bytesAtScaleOne = Double(size.width * size.height) * 4
        let renderer = ChatMermaidRenderer()
        let requests = (0..<3).map {
            self.request("\(source)\n%% diagram \($0)", scale: sqrt(3 * 1024 * 1024 / bytesAtScaleOne))
        }
        var images: [ChatMermaidRenderedImage] = []
        for request in requests {
            let result = await self.render(request, using: renderer)
            images.append(try result.get())
        }
        let limit = 12 * 1024 * 1024
        try #require(images.reduce(0) { $0 + $1.byteCount } < limit)
        #expect(self.cachedImage(requests[0], using: renderer)?.image === images[0].image)

        let large = self.request(source, scale: sqrt(8 * 1024 * 1024 / bytesAtScaleOne))
        let largeResult = await self.render(large, using: renderer)
        let largeImage = try largeResult.get()
        try #require(images[0].byteCount + largeImage.byteCount <= limit)
        for image in images.dropFirst() {
            try #require(images[0].byteCount + image.byteCount + largeImage.byteCount > limit)
        }
        // Both untouched entries must leave, but the touched entry and new result still fit.
        #expect(self.cachedImage(requests[0], using: renderer)?.image === images[0].image)
        #expect(self.cachedImage(large, using: renderer)?.image === largeImage.image)
        for request in requests.dropFirst() {
            #expect(self.cachedImage(request, using: renderer) == nil)
        }

        let oversized = self.request(source, scale: sqrt(14 * 1024 * 1024 / bytesAtScaleOne))
        let oversizedResult = await self.render(oversized, using: renderer)
        let oversizedImage = try oversizedResult.get()
        try #require(oversizedImage.byteCount > limit)
        #expect(self.cachedImage(oversized, using: renderer) == nil)
        #expect(self.cachedImage(requests[0], using: renderer)?.image === images[0].image)
        #expect(self.cachedImage(large, using: renderer)?.image === largeImage.image)
    }

    private func request(_ source: String, width: Int = 320, scale: Double = 2) -> ChatMermaidRequest {
        ChatMermaidRequest(source: source, width: width, displayScale: scale, theme: self.theme)
    }

    private func cachedImage(
        _ request: ChatMermaidRequest,
        using renderer: ChatMermaidRenderer) -> ChatMermaidRenderedImage?
    {
        var image: ChatMermaidRenderedImage?
        if let token = renderer.render(request, completion: { image = try? $0.get() }) {
            renderer.cancel(token)
        }
        return image
    }

    private func render(
        _ request: ChatMermaidRequest,
        using renderer: ChatMermaidRenderer) async -> Result<ChatMermaidRenderedImage, ChatMermaidFailure>
    {
        await withCheckedContinuation { continuation in
            renderer.render(request) { continuation.resume(returning: $0) }
        }
    }
}
#endif
