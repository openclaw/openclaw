import Foundation
import OpenClawKit
import SwiftUI
import Testing
import UIKit
@testable import OpenClawChatUI

/// An image in the transcript holds one box from the first frame: the bytes arriving never change
/// the row's height, and an image seen once draws again without a second download.
@MainActor
struct ChatMediaImageBoxTests {
    @MainActor private final class Counter {
        var loads = 0
    }

    /// A 1x1 PNG; the Gateway's size, not the decoded pixels, decides the box.
    private static let png = Data(base64Encoded:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC")!

    private static func height(of controller: UIHostingController<some View>) -> CGFloat {
        controller.safeAreaRegions = []
        controller.view.setNeedsLayout()
        controller.view.layoutIfNeeded()
        return controller.sizeThatFits(in: CGSize(width: 361, height: CGFloat.greatestFiniteMagnitude)).height
    }

    @Test func `box follows the Control UI preview rule`() {
        let tall = ChatImageBox(pixelSize: CGSize(width: 1179, height: 2556)).size
        #expect(abs(tall.width - 166.06) < 0.01)
        #expect(abs(tall.height - 360) < 0.01)
        #expect(ChatImageBox(pixelSize: nil).size == CGSize(width: 400, height: 400 / 1.5))
        #expect(ChatImageBox(pixelSize: CGSize(width: 100, height: 50)).size == CGSize(width: 160, height: 80))
        #expect(ChatImageBox(pixelSize: CGSize(width: 4000, height: 1000)).size == CGSize(width: 400, height: 100))
    }

    @Test func `a sent photo is never wider than the text bubble can be`() {
        // A 393 pt iPhone: a 361 pt column, a 296 pt bubble.
        let column = ChatColumnLayout(paneWidth: 393)
        let cap = column.bubbleAndMediaMaxWidth
        let landscape = ChatImageBox(pixelSize: CGSize(width: 1600, height: 1200), maxWidth: cap).size
        #expect(landscape.width == cap)
        #expect(abs(landscape.width / landscape.height - 4.0 / 3.0) < 0.001)
        let unknown = ChatImageBox(pixelSize: nil, maxWidth: cap).size
        #expect(unknown.width == cap)
        #expect(abs(unknown.width / unknown.height - 1.5) < 0.001)
        // A narrow photo keeps its own box.
        let tall = ChatImageBox(pixelSize: CGSize(width: 1179, height: 2556), maxWidth: cap).size
        #expect(abs(tall.width - 166.06) < 0.01)
        // Three tiles and two gaps fit the same measure.
        #expect(3 * column.userImageTileSide + 2 * 4 <= cap)
    }

    @Test(arguments: ["assistant", "user"], [393, 667, 1024])
    func `landscape photos leave the same room opposite their speaker`(role: String, paneWidth: Int) throws {
        let column = ChatColumnLayout(paneWidth: CGFloat(paneWidth))
        let expectedWidth: CGFloat = paneWidth == 393 ? 296.02 : 400
        let isUser = role == "user"
        let id = (isUser ? "media://inbound/" : "artifact_managed_image_") + UUID().uuidString
        let attachment = OpenClawChatMessageContent(
            type: "image", artifactId: isUser ? nil : id, url: isUser ? id : nil, width: 1600, height: 900)
        try ChatMediaImageMemory.store(#require(UIImage(data: Self.png)), for: id)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: paneWidth, height: 852))
        let row = ChatMessageBubble(
            message: .init(role: role, content: [attachment], timestamp: nil),
            style: .standard, markdownVariant: .standard, displayOptions: [], showsAssistantAvatar: false,
            contextWindowTokens: nil, userMessageExpanded: false, onToggleUserMessageExpanded: {},
            inlineWidgetScope: .init(
                modelID: ObjectIdentifier(window),
                sessionTarget: .init(
                    sessionKey: "main",
                    agentID: nil),
                sessionGeneration: 0), mediaPlaybackAllowed: { true })
            .environment(\.openClawChatColumn, column)
            .frame(width: column.columnWidth)
        let host = UIHostingController(rootView: row)
        host.safeAreaRegions = []
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        host.view.layoutIfNeeded()
        let thumbnail = try #require(ChatImageViewerSources.view(for: id))
        let frame = thumbnail.convert(thumbnail.bounds, to: host.view)
        let columnStart = (host.view.bounds.width - column.columnWidth) / 2
        let oppositeInset = column.columnWidth - expectedWidth
        #expect(abs(frame.width - expectedWidth) < 0.5)
        #expect(abs(frame.minX - columnStart - (isUser ? oppositeInset : 0)) < 0.5)
    }

    @Test func `a sent photo reads from the Control UI's inbound media route`() throws {
        let source = "media://inbound/photo-63DF6636---5553a37d.jpg"
        #expect(OpenClawChatInboundMedia.canonicalSource(" \(source) ") == source)
        #expect(OpenClawChatInboundMedia.canonicalSource("media://inbound/a/b.jpg") == nil)
        #expect(OpenClawChatInboundMedia.canonicalSource("media://inbound/..") == nil)
        #expect(OpenClawChatInboundMedia.canonicalSource("/api/chat/media/outgoing/main/x/full") == nil)

        let context = try OpenClawChatSourceContext(
            gatewayURL: #require(URL(string: "https://gateway.example:8443")),
            basePath: "/control")
        let url = try #require(OpenClawChatInboundMedia.thumbnailURL(
            source: source, context: context, sessionKey: "agent:main:ios-1", agentID: "main"))
        #expect(url.absoluteString == "https://gateway.example:8443/control/__openclaw__/assistant-media"
            + "?source=media%3A%2F%2Finbound%2Fphoto-63DF6636---5553a37d.jpg"
            + "&sessionKey=agent%3Amain%3Aios-1&agentId=main&variant=thumbnail&width=1920&v=4")
        // The viewer reads the upload as is: the same URL without the rendition.
        let original = try #require(OpenClawChatInboundMedia.originalURL(
            source: source, context: context, sessionKey: "agent:main:ios-1", agentID: "main"))
        #expect(original.absoluteString == "https://gateway.example:8443/control/__openclaw__/assistant-media"
            + "?source=media%3A%2F%2Finbound%2Fphoto-63DF6636---5553a37d.jpg"
            + "&sessionKey=agent%3Amain%3Aios-1&agentId=main")
    }

    @Test func `a user's sent photos page together in the viewer and read as Photo`() {
        // Two names the app made up at pick time, and one the person chose.
        let names = [
            OpenClawChatGeneratedAttachmentName.picked(.photo) + ".jpg",
            OpenClawChatGeneratedAttachmentName.pasted(index: 0) + ".png",
            "photo-beach.jpg",
        ]
        let photos = names.enumerated().map { index, name in
            OpenClawChatMessageContent(
                type: "image",
                mimeType: "image/jpeg",
                fileName: name,
                url: "media://inbound/photo-\(index + 1)---a1.jpg")
        }
        let file = OpenClawChatMessageContent(type: "file", mimeType: "application/pdf", fileName: "notes.pdf")
        let gallery = ChatImageViewerItem.gallery(in: photos + [file], sentPhotos: true)
        #expect(gallery.map(\.artifactId) == photos.compactMap(\.url))
        #expect(gallery.allSatisfy { $0.label == "Photo" })
        #expect(gallery.map(\.title) == [nil, nil, "photo-beach.jpg"])
        // Processing sends a HEIC pick as JPEG; the made-up base name still counts.
        #expect(OpenClawChatGeneratedAttachmentName.isGenerated("photo-1A2B3C4D.heic"))
        #expect(!OpenClawChatGeneratedAttachmentName.isGenerated("photo-1a2b3c4d.jpg"))
        #expect(ChatImageViewerItem.viewerItems(gallery, opening: "media://inbound/photo-2---a1.jpg", label: "x")
            .count == 3)
        // An agent's message keeps the managed-artifact rule.
        #expect(ChatImageViewerItem.gallery(in: photos).isEmpty)
    }

    private static func viewer(count: Int, thumbnails: [String: UIImage] = [:]) -> ChatImageViewerController {
        let items = (0..<count).map {
            ChatImageViewerItem(artifactId: "draft-attachment:\($0)", label: "Photo", title: nil, pixelSize: nil)
        }
        let viewer = ChatImageViewerController(
            items: items,
            index: 0,
            thumbnail: UIImage(data: Self.png)!,
            thumbnails: thumbnails,
            load: { _ in nil })
        viewer.loadViewIfNeeded()
        return viewer
    }

    @Test func `the viewer's thumbnail row shows only for several images`() {
        #expect(!ChatImageViewerFilmstrip.isShown(count: 1))
        #expect(ChatImageViewerFilmstrip.isShown(count: 2))
        #expect(Self.viewer(count: 1).chrome.strip.isEmpty)
        #expect(Self.viewer(count: 5).chrome.strip.count == 5)
        #expect(ChatImageViewerFilmstrip.accessibilityLabel(index: 1, count: 5) == "Image 2 of 5")
    }

    @Test func `the row's selection follows a tap and a swipe`() throws {
        let viewer = Self.viewer(count: 5)
        viewer.showPage(3)
        #expect(viewer.currentIndex == 3)
        #expect(viewer.chrome.stripIndex == 3)

        // A swipe to the next page settles through the pager's delegate.
        let current = try #require(viewer.pager.viewControllers?.first)
        let next = try #require(viewer.pageViewController(viewer.pager, viewControllerAfter: current))
        viewer.pager.setViewControllers([next], direction: .forward, animated: false)
        viewer.pageViewController(
            viewer.pager, didFinishAnimating: true, previousViewControllers: [current], transitionCompleted: true)
        #expect(viewer.currentIndex == 4)
        #expect(viewer.chrome.stripIndex == 4)
    }

    @Test func `a draft's photos fill the row from the pictures the composer holds`() throws {
        let picture = try #require(UIImage(data: Self.png))
        let viewer = Self.viewer(count: 3, thumbnails: [
            "draft-attachment:1": picture,
            "draft-attachment:2": picture,
        ])
        // The opened photo, then the two staged ones: no thumbnail waits on a request.
        #expect(viewer.chrome.strip.allSatisfy { $0 != nil })
    }

    @Test func `arriving bytes keep the row height and a second appearance does not load again`() async throws {
        let artifactId = "artifact_managed_image_\(UUID().uuidString.lowercased())"
        let release = AsyncStream<Void>.makeStream()
        let counter = Counter()
        let view = ChatMediaImageAttachment(
            artifactId: artifactId,
            label: "Preview",
            width: 1179,
            height: 2556,
            resolverReady: true,
            load: { _ in
                counter.loads += 1
                var iterator = release.stream.makeAsyncIterator()
                _ = await iterator.next()
                return .data(OpenClawChatMediaData(data: Self.png, mimeType: "image/png"))
            })
        let controller = UIHostingController(rootView: view)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { window.isHidden = true }

        let waiting = Self.height(of: controller)
        release.continuation.yield()
        for _ in 0..<200 where ChatMediaImageMemory.image(for: artifactId) == nil {
            try await Task.sleep(for: .milliseconds(25))
        }
        #expect(ChatMediaImageMemory.image(for: artifactId) != nil)
        try await Task.sleep(for: .milliseconds(300))
        let loaded = Self.height(of: controller)
        #expect(abs(waiting - 360) < 0.5)
        #expect(waiting == loaded)

        let again = UIHostingController(rootView: ChatMediaImageAttachment(
            artifactId: artifactId,
            label: "Preview",
            width: 1179,
            height: 2556,
            resolverReady: true,
            load: { _ in
                counter.loads += 1
                return nil
            }))
        window.rootViewController = again
        _ = Self.height(of: again)
        try await Task.sleep(for: .milliseconds(300))
        #expect(counter.loads == 1)
        release.continuation.finish()
    }
}
