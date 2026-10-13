import AppKit
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers
import WebKit
@testable import OpenClaw

/// The WebKit fixture is compiled locally and executed only in the disposable macOS runner.
@Suite(.serialized, .testWaitLimit)
@MainActor
struct DashboardImagePasteTests {
    @Test func `an HEIC-only clipboard item becomes a PNG for the page`() throws {
        let images = try #require(DashboardPastedImages.unreadableImages(in: [Self.item([.heic: Self.heic])]))
        #expect(images == [Self.heic])
        let png = try #require(DashboardPastedImages.pngData(from: Self.heic))
        #expect(try Self.imageFacts(png) == ImageFacts(type: UTType.png.identifier, width: 8, height: 6))
        let pair = [Self.item([.heic: Self.heic]), Self.item([.heic: Self.heic])]
        #expect(DashboardPastedImages.unreadableImages(in: pair) == [Self.heic, Self.heic])
    }

    @Test(arguments: [
        UTType.png, .tiff, .jpeg, .gif, .svg, .utf8PlainText, .html, .rtf, .rtfd, .flatRTFD, .webArchive, .url,
        .fileURL,
    ])
    func `clipboard content WebKit can paste stays with WebKit`(_ type: UTType) {
        let readable = Data("fixture".utf8)
        #expect(DashboardPastedImages.unreadableImages(in: [Self.item([type: readable])]) == nil)
        #expect(DashboardPastedImages.unreadableImages(in: [Self.item([.heic: Self.heic, type: readable])]) == nil)
        #expect(DashboardPastedImages.unreadableImages(in: [
            Self.item([.heic: Self.heic]),
            Self.item([type: readable]),
        ]) == nil)
    }

    @Test func `a clipboard without image data stays with WebKit`() {
        #expect(DashboardPastedImages.unreadableImages(in: []) == nil)
        #expect(DashboardPastedImages.unreadableImages(in: [Self.item([.data: Data("fixture".utf8)])]) == nil)
    }

    @Test func `conversion applies the image orientation`() throws {
        let rotated = try Self.jpeg(width: 40, height: 20, orientation: .right)
        let png = try #require(DashboardPastedImages.pngData(from: rotated))
        #expect(try Self.imageFacts(png) == ImageFacts(type: UTType.png.identifier, width: 20, height: 40))
        #expect(DashboardPastedImages.pngData(from: Data("not an image".utf8)) == nil)
    }

    @Test func `paste gives the focused composer an HEIC screenshot as PNG and leaves other pastes to WebKit`()
        async throws
    {
        try await Self.withFocusedComposer { document, pasteboard in
            // Content WebKit can paste keeps WebKit's own paste, which the page sees as a trusted event.
            try Self.paste([.utf8PlainText: Data("fixture".utf8)], from: pasteboard, into: document.webView)
            try await TestWait.state("WebKit paste") {
                try await document.webView.evaluateJavaScript("window.pastes.length") as? Int == 1
            }
            #expect(try await document.webView.evaluateJavaScript("window.pastes[0].trusted") as? Bool == true)

            try Self.paste([.heic: Self.heic], from: pasteboard, into: document.webView)
            try await TestWait.state("converted paste") {
                try await document.webView.evaluateJavaScript("typeof window.pastes[1]?.png") as? String == "string"
            }
            let pasted = try #require(
                try await document.webView.evaluateJavaScript("window.pastes[1]") as? [String: Any])
            #expect(pasted["trusted"] as? Bool == false)
            #expect(pasted["target"] as? String == "composer")
            #expect(pasted["files"] as? [String] == ["image.png image/png"])
            let png = try #require((pasted["png"] as? String).flatMap { Data(base64Encoded: $0) })
            #expect(try Self.imageFacts(png) == ImageFacts(type: UTType.png.identifier, width: 8, height: 6))

            // Opening the WebKit context menu and choosing Paste delivers an HEIC screenshot through the same path.
            let menu = NSMenu()
            let reload = NSMenuItem(title: "Reload", action: nil, keyEquivalent: "")
            reload.identifier = NSUserInterfaceItemIdentifier("WKMenuItemIdentifierReload")
            let pasteItem = NSMenuItem(title: "Paste", action: nil, keyEquivalent: "")
            pasteItem.identifier = NSUserInterfaceItemIdentifier("WKMenuItemIdentifierPaste")
            menu.items = [reload, pasteItem]
            let event = try #require(NSEvent.mouseEvent(
                with: .rightMouseDown,
                location: .zero,
                modifierFlags: [],
                timestamp: 0,
                windowNumber: 0,
                context: nil,
                eventNumber: 0,
                clickCount: 1,
                pressure: 1))
            document.webView.willOpenMenu(menu, with: event)
            #expect(menu.items.map(\.identifier?.rawValue) == ["WKMenuItemIdentifierPaste"])

            pasteboard.clearContents()
            try #require(pasteboard.writeObjects([Self.item([.heic: Self.heic])]))
            menu.performActionForItem(at: 0)
            try await TestWait.state("context menu converted paste") {
                try await document.webView.evaluateJavaScript("typeof window.pastes[2]?.png") as? String == "string"
            }
            let menuPasted = try #require(
                try await document.webView.evaluateJavaScript("window.pastes[2]") as? [String: Any])
            #expect(menuPasted["trusted"] as? Bool == false)
            #expect(menuPasted["target"] as? String == "composer")
            #expect(menuPasted["files"] as? [String] == ["image.png image/png"])
        }
    }

    @Test func `a converted paste stays with the composer and route it was made in`() async throws {
        try await Self.withFocusedComposer { document, pasteboard in
            // Scripts reach the page in order: the paste's record, this route change, then delivery.
            // The focused composer stays in place, as when the app switches conversations.
            try Self.paste([.heic: Self.heic], from: pasteboard, into: document.webView)
            _ = try await document.webView.evaluateJavaScript("history.pushState({}, '', '/control/chat/other'); true")
            await document.imagePasteDelivery?.value
            #expect(try await document.webView.evaluateJavaScript("window.pastes.length") as? Int == 0)

            // Focus moving within the same route leaves the paste with the composer that received it.
            try Self.paste([.heic: Self.heic], from: pasteboard, into: document.webView)
            try #require(try await document.webView.evaluateJavaScript("window.focusField('other')") as? Bool == true)
            await document.imagePasteDelivery?.value
            let pasted = try #require(
                try await document.webView.evaluateJavaScript("window.pastes") as? [[String: Any]])
            #expect(pasted.count == 1)
            #expect(pasted.first?["target"] as? String == "composer")
            #expect(pasted.first?["files"] as? [String] == ["image.png image/png"])
        }
    }

    private struct ImageFacts: Equatable {
        let type: String
        let width: Int
        let height: Int
    }

    /// An 8x6 HEIC image. macOS copies HDR screenshots to the clipboard as a single HEIC item.
    private static let heic = Data(base64Encoded: """
    AAAAJGZ0eXBoZWljAAAAAG1pZjFNaVBybWlhZk1pSEJoZWljAAABhm1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAA\
    AAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAADnBpdG0AAAAAAAEAAAAjaWluZgAAAAAAAQAAABVp\
    bmZlAgAAAAABAABodmMxAAAAAOZpcHJwAAAAxWlwY28AAAATY29scm5jbHgAAgACAAaAAAAADGNsbGkAywBAAAAAFGlzcGUAAAAA\
    AAAACAAAAAYAAAAJaXJvdAAAAAAQcGl4aQAAAAADCAgIAAAAcWh2Y0MBA3AAAACwAAAAAAAe8AD8/fj4AAALA6AAAQAXQAEMAf//\
    A3AAAAMAsAAAAwAAAwAecCShAAEAI0IBAQNwAAADALAAAAMAAAMAHqAUIEHAmw9iHuRZVNwICBgCogABAAlEAcBhcshEU2QAAAAZ\
    aXBtYQAAAAAAAAABAAEGgQIDBYaEAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAAboAAAA+AAAAAW1kYXQAAAAAAAAATgAAADooAa+i\
    +kaBfP/8ZIf/+I77L8d3vVf/gIfI+t/i/5ZI90yyZ/og+cI5xu1DrAW/1T0IvYV+CtwhJsiu
    """)!

    /// The composer sits in a shadow root, as custom elements can place it. WebKit's own paste
    /// reads the runner's clipboard, so the page records that trusted event without reading it.
    /// Pastes are recorded when dispatched; the PNG bytes arrive later.
    private static let composerHTML = """
    <!doctype html><html><body><composer-fixture></composer-fixture><script>
    window.pastes = [];
    customElements.define('composer-fixture', class extends HTMLElement {
      constructor() {
        super();
        this.attachShadow({mode: 'open'}).innerHTML = '<textarea id="composer"></textarea><textarea id="other"></textarea>';
        this.shadowRoot.addEventListener('paste', event => {
          if (event.isTrusted) {
            event.preventDefault();
            window.pastes.push({trusted: true});
            return;
          }
          const files = Array.from(event.clipboardData.items, item => item.getAsFile()).filter(Boolean);
          const paste = {trusted: false, target: event.composedPath()[0].id, files: files.map(file => `${file.name} ${file.type}`)};
          window.pastes.push(paste);
          files[0]?.arrayBuffer().then(buffer => { paste.png = new Uint8Array(buffer).toBase64(); });
        });
      }
    });
    window.focusField = id => {
      const field = document.querySelector('composer-fixture').shadowRoot.getElementById(id);
      field.focus();
      return field.getRootNode().activeElement === field;
    };
    </script></body></html>
    """

    /// Runs `body` with the composer page loaded and its composer focused; the web view's
    /// image check reads the given private pasteboard.
    private static func withFocusedComposer(
        _ body: @MainActor (ControlUIDocumentHost, NSPasteboard) async throws -> Void) async throws
    {
        let server = try await DashboardHTTPFixture.start(
            html: self.composerHTML, contentSecurityPolicy: "default-src 'self' 'unsafe-inline'")
        defer { server.stop() }
        let document = ControlUIDocumentHost(
            url: server.url("/control/"), auth: .unauthenticated, websiteDataStore: .nonPersistent())
        { _ in }
        defer { document.webView.stopLoading() }
        let pasteboard = NSPasteboard.withUniqueName()
        defer { pasteboard.releaseGlobally() }
        document.webView.imagePasteboard = pasteboard

        document.load(server.url("/control/chat"))
        try await TestWait.state("composer document") {
            await (try? document.webView.evaluateJavaScript("typeof window.focusField")) as? String == "function"
        }
        try #require(try await document.webView.evaluateJavaScript("window.focusField('composer')") as? Bool == true)
        try await body(document, pasteboard)
    }

    private static func item(_ representations: KeyValuePairs<UTType, Data>) -> NSPasteboardItem {
        let item = NSPasteboardItem()
        for (type, data) in representations {
            item.setData(data, forType: NSPasteboard.PasteboardType(type.identifier))
        }
        return item
    }

    private static func paste(
        _ representations: KeyValuePairs<UTType, Data>,
        from pasteboard: NSPasteboard,
        into webView: DashboardWebView) throws
    {
        pasteboard.clearContents()
        try #require(pasteboard.writeObjects([self.item(representations)]))
        // AppKit's Paste command reaches the override through the selector, not Swift dispatch.
        try #require(AppKitTestSupport.application.sendAction(#selector(NSText.paste(_:)), to: webView, from: nil))
    }

    private static func jpeg(width: Int, height: Int, orientation: CGImagePropertyOrientation) throws -> Data {
        let context = try #require(CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        let image = try #require(context.makeImage())
        let output = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(
            output, UTType.jpeg.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(
            destination, image, [kCGImagePropertyOrientation: orientation.rawValue] as CFDictionary)
        try #require(CGImageDestinationFinalize(destination))
        return output as Data
    }

    private static func imageFacts(_ data: Data) throws -> ImageFacts {
        let source = try #require(CGImageSourceCreateWithData(data as CFData, nil))
        let properties = try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        return try ImageFacts(
            type: #require(CGImageSourceGetType(source) as String?),
            width: #require(properties[kCGImagePropertyPixelWidth] as? Int),
            height: #require(properties[kCGImagePropertyPixelHeight] as? Int))
    }
}
