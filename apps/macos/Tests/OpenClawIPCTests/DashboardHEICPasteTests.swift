import AppKit
import ImageIO
import Testing
import UniformTypeIdentifiers
import WebKit
@testable import OpenClaw

// Only the disposable Apple CI worker runs this fixture. Its clipboard contains synthetic images.
@Suite(.serialized, .testWaitLimit)
@MainActor
struct DashboardHEICPasteTests {
    @Test func `native Paste delivers an HEIC-only image to the web composer as PNG`() async throws {
        _ = AppKitTestSupport.application
        let server = try await DashboardHTTPFixture.start(
            html: """
            <!doctype html><html><body><textarea id="composer"></textarea><script>
            window.pastes = [];
            document.querySelector('textarea').addEventListener('paste', async event => {
              event.preventDefault();
              const files = [...event.clipboardData.files];
              const images = await Promise.all(files.map(async file => ({
                type: file.type,
                data: new Uint8Array(await file.arrayBuffer()).toBase64()
              })));
              window.pastes.push(images);
            });
            </script></body></html>
            """,
            contentSecurityPolicy: "default-src 'none'; script-src 'unsafe-inline'")
        defer { server.stop() }
        let controller = DashboardWindowController(
            url: server.url(), auth: .unauthenticated, websiteDataStore: .nonPersistent(),
            windowAutosaveName: "", requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        controller.show(url: server.url(), auth: .unauthenticated)
        try await DashboardTestWait.document(controller)
        let window = try #require(controller.window)
        try #require(window.makeFirstResponder(controller.webView))
        try #require(try await controller.webView.evaluateJavaScript("""
        document.querySelector('textarea').focus(); document.activeElement.id;
        """) as? String == "composer")

        let pasteboard = NSPasteboard.general
        defer { pasteboard.clearContents() }
        for (index, type) in [UTType.png, .heic].enumerated() {
            let item = NSPasteboardItem()
            let encoded = try Self.image(type: type)
            try #require(item.setData(encoded, forType: NSPasteboard.PasteboardType(type.identifier)))
            pasteboard.clearContents()
            try #require(pasteboard.writeObjects([item]))
            // Declared item types matter: pasteboard-wide types can advertise a TIFF conversion.
            try #require(pasteboard.pasteboardItems?.first?.types == [NSPasteboard.PasteboardType(type.identifier)])
            try #require(NSApp.sendAction(#selector(NSText.paste(_:)), to: controller.webView, from: nil))
            try await TestWait.state("native \(type.identifier) paste event") {
                try await controller.webView.evaluateJavaScript("window.pastes.length") as? Int == index + 1
            }
            let files = try #require(try await controller.webView.evaluateJavaScript(
                "window.pastes[\(index)]") as? [[String: String]])
            try #require(files.count == 1)
            #expect(files[0]["type"] == "image/png")
            let bytes = try #require(files[0]["data"].flatMap { Data(base64Encoded: $0) })
            let source = try #require(CGImageSourceCreateWithData(bytes as CFData, nil))
            #expect(CGImageSourceGetType(source) as String? == UTType.png.identifier)
            let properties = try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
            #expect(properties[kCGImagePropertyPixelWidth] as? Int == 8)
            #expect(properties[kCGImagePropertyPixelHeight] as? Int == 6)
        }
    }

    private static func image(type: UTType) throws -> Data {
        let context = try #require(CGContext(
            data: nil, width: 8, height: 6, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
        context.setFillColor(NSColor.red.cgColor)
        context.fill(CGRect(x: 0, y: 0, width: 8, height: 6))
        let image = try #require(context.makeImage())
        let data = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(
            data, type.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, nil)
        try #require(CGImageDestinationFinalize(destination))
        let source = try #require(CGImageSourceCreateWithData(data, nil))
        try #require(CGImageSourceGetType(source) as String? == type.identifier)
        return data as Data
    }
}
