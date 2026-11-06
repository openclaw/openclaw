#if os(macOS)
import AppKit
import SwiftUI
import Testing
@testable import OpenClawChatUI

@MainActor
struct ChatLinkPreviewRenderingTests {
    @Test(arguments: [false, true])
    func `retained preview hides the prior URL before the container loads its replacement`(dark: Bool) async throws {
        _ = NSApplication.shared
        let first = try #require(URL(string: "https://first.preview.test/story"))
        let second = try #require(URL(string: "https://second.preview.test/story"))
        let imageURL = try #require(URL(string: "https://first.preview.test/cover.png"))
        let metadata = ChatLinkPreviewMetadata(
            url: first,
            title: "First synthetic page",
            description: "This title and image belong only to the first URL.",
            imageURL: imageURL)
        let thumbnail = try ChatLinkPreviewThumbnail(image: Self.thumbnail())
        let model = ChatLinkPreviewModel(
            metadataFetch: { url in url == first ? .loaded(metadata) : .failed },
            imageFetch: { _ in .loaded(thumbnail) })
        model.expanded = true
        await model.loadMetadata(first)
        await model.loadImage()

        func content(url: URL, model: ChatLinkPreviewModel) -> some View {
            ChatLinkPreviewContent(url: url, model: model)
                .padding(20)
                .frame(width: 420, height: 240, alignment: .topLeading)
                .background(dark ? Color.black : Color.white)
                .environment(\.colorScheme, dark ? .dark : .light)
        }
        let host = NSHostingView(rootView: content(url: first, model: model))
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 240),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        window.contentView = host
        defer {
            window.contentView = nil
            window.close()
        }
        let original = try Self.capture(host)

        // Render retained content before the container invokes its loader.
        // The URL projection must hide A while its payload remains in the model.
        host.rootView = content(url: second, model: model)
        let transition = try Self.capture(host)
        #expect(model.expanded)
        #expect(model.result == .loaded(metadata))
        #expect(model.imageURL == imageURL)

        let emptyModel = ChatLinkPreviewModel(metadataFetch: { _ in .failed }, imageFetch: { _ in .failed })
        emptyModel.expanded = true
        let reference = NSHostingView(rootView: content(url: second, model: emptyModel))
        window.contentView = reference
        let loading = try Self.capture(reference)

        // The fresh B model independently supplies the expected loading state;
        // the populated A capture proves this comparison distinguishes stale content.
        #expect(original != loading)
        #expect(transition == loading)
    }

    private static func capture(_ view: NSView) throws -> Data {
        view.frame = NSRect(x: 0, y: 0, width: 420, height: 240)
        view.layoutSubtreeIfNeeded()
        view.displayIfNeeded()
        let bitmap = try #require(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: bitmap)
        return try #require(bitmap.representation(using: .png, properties: [:]))
    }

    private static func thumbnail() throws -> CGImage {
        let context = try #require(CGContext(
            data: nil, width: 64, height: 32, bitsPerComponent: 8, bytesPerRow: 256,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.setFillColor(red: 0.15, green: 0.65, blue: 0.85, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: 64, height: 32))
        context.setFillColor(red: 0.95, green: 0.35, blue: 0.2, alpha: 1)
        context.fill(CGRect(x: 0, y: 16, width: 64, height: 16))
        return try #require(context.makeImage())
    }
}
#endif
