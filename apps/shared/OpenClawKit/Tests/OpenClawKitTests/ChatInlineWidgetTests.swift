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
}
