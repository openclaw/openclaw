import Foundation
import Testing
@testable import OpenClawChatUI

struct ChatInlineWidgetTests {
    @Test func `decodes projected canvas widget block`() throws {
        let data = Data(
            #"{"role":"assistant","content":[{"type":"text","text":"Done"},{"type":"canvas","preview":{"kind":"canvas","surface":"assistant_message","render":"url","title":"Status","preferredHeight":240,"url":"/__openclaw__/canvas/documents/widget-1/index.html","sandbox":"scripts"}}]}"#
                .utf8)

        let message = try JSONDecoder().decode(OpenClawChatMessage.self, from: data)
        let preview = try #require(message.content.last?.preview)
        #expect(preview.inlineWidgetPath == "/__openclaw__/canvas/documents/widget-1/index.html")
        #expect(preview.inlineWidgetHeight == 240)

        let unsafe = OpenClawChatCanvasPreview(
            kind: "canvas",
            surface: "assistant_message",
            render: "url",
            title: nil,
            preferredHeight: nil,
            url: "https://attacker.example/widget.html",
            viewId: nil,
            sandbox: "scripts")
        #expect(unsafe.inlineWidgetPath == nil)
    }

    @Test func `resolves only capability scoped widget documents`() {
        let surface = "https://gateway.example/__openclaw__/cap/token"
        let target = "/__openclaw__/canvas/documents/widget-1/index.html"

        #expect(OpenClawChatWidgetURLResolver.resolve(
            surfaceURL: surface,
            target: target)?.absoluteString ==
            "https://gateway.example/__openclaw__/cap/token/__openclaw__/canvas/documents/widget-1/index.html")
        #expect(OpenClawChatWidgetURLResolver.resolve(surfaceURL: "https://gateway.example", target: target) == nil)
        #expect(OpenClawChatWidgetURLResolver.resolve(
            surfaceURL: surface,
            target: "https://attacker.example/widget.html") == nil)
        #expect(OpenClawChatWidgetURLResolver.resolve(
            surfaceURL: surface,
            target: "/__openclaw__/a2ui/index.html") == nil)
        #expect(OpenClawChatWidgetURLResolver.resolve(
            surfaceURL: surface,
            target: "/__openclaw__/canvas/documents/%252e%252e/index.html") == nil)
        #expect(OpenClawChatWidgetURLResolver.resolve(
            surfaceURL: surface,
            target: "/__openclaw__/canvas/documents/%2525252525252525252525252525252525/index.html") == nil)
    }

    @Test func `uses replacement route after capability refresh loses its lease`() async throws {
        let target = "/__openclaw__/canvas/documents/widget-1/index.html"
        let oldSurface = "https://gateway.example/__openclaw__/cap/old"
        let newSurface = "https://gateway.example/__openclaw__/cap/new"
        let failedURL = try #require(OpenClawChatWidgetURLResolver.resolve(
            surfaceURL: oldSurface,
            target: target))
        let probe = ChatWidgetReconnectProbe(surfaceURL: oldSurface, replacementURL: newSurface)

        let resolved = await OpenClawChatWidgetURLResolver.resolve(
            target: target,
            replacing: failedURL,
            currentSurfaceURLs: { await probe.current() },
            refreshNodeSurfaceURL: { observed in await probe.reconnect(observed: observed) })

        #expect(resolved == OpenClawChatWidgetURLResolver.resolve(surfaceURL: newSurface, target: target))
        #expect(await probe.refreshCount == 1)
    }

    #if canImport(WebKit) && (os(iOS) || os(macOS))
    @Test func `bounds WebKit content process recovery per document`() {
        var recovery = ChatInlineWidgetContentProcessRecovery()

        #expect(recovery.nextAction() == .reload)
        #expect(recovery.nextAction() == .fail)
        #expect(recovery.nextAction() == .fail)

        recovery.reset()
        #expect(recovery.nextAction() == .reload)
    }
    #endif
}

private actor ChatWidgetReconnectProbe {
    private var surfaceURL: String?
    private let replacementURL: String
    private(set) var refreshCount = 0

    init(surfaceURL: String, replacementURL: String) {
        self.surfaceURL = surfaceURL
        self.replacementURL = replacementURL
    }

    func current() -> (node: String?, operatorSurface: String?) {
        (node: self.surfaceURL, operatorSurface: nil)
    }

    func reconnect(observed _: String?) -> String? {
        self.refreshCount += 1
        self.surfaceURL = self.replacementURL
        return nil
    }
}
