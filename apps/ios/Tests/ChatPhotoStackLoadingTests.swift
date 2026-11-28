import OpenClawKit
import SwiftUI
import UIKit
import XCTest
@testable import OpenClawChatUI

@MainActor
final class ChatPhotoStackLoadingTests: XCTestCase {
    func testTranscriptDecodesOnlyTheFirstThreePhotosAtThumbnailSize() async throws {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 900, height: 900))
        let bytes = renderer.pngData { context in
            UIColor.systemBlue.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 900, height: 900))
        }
        let encoded = bytes.base64EncodedString()
        let prefix = UUID().uuidString
        let photos = (1...9).map { index in
            OpenClawChatMessageContent(
                type: "image",
                mimeType: "image/png",
                fileName: "\(prefix)-\(index).png",
                sizeBytes: bytes.count,
                content: .init(encoded))
        }
        let ids = photos.compactMap(ChatUserImageSource.pageID)
        XCTAssertEqual(ids.count, 9)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        let row = ChatMessageBubble(
            message: .init(role: "user", content: photos, timestamp: nil),
            style: .standard,
            markdownVariant: .standard,
            displayOptions: [],
            showsAssistantAvatar: false,
            contextWindowTokens: nil,
            userMessageExpanded: false,
            onToggleUserMessageExpanded: {},
            inlineWidgetScope: .init(
                modelID: ObjectIdentifier(window),
                sessionTarget: .init(sessionKey: "main", agentID: nil),
                sessionGeneration: 0),
            mediaPlaybackAllowed: { true })
        window.rootViewController = UIHostingController(rootView: row)
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        window.rootViewController?.view.layoutIfNeeded()
        let decoded = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            MainActor.assumeIsolated { ids.prefix(3).allSatisfy { ChatImageViewerSources.view(for: $0)?.image != nil } }
        }, object: nil)
        await self.fulfillment(of: [decoded], timeout: 5)
        for id in ids.prefix(3) {
            let image = try XCTUnwrap(ChatImageViewerSources.view(for: id)?.image)
            XCTAssertLessThanOrEqual(max(image.size.width, image.size.height) * image.scale, 480)
        }
        for id in ids.dropFirst(3) {
            XCTAssertNil(ChatImageViewerSources.view(for: id))
            // The local source reads the header when it acquires the base64 bytes, before decoding pixels.
            XCTAssertNil(ChatMediaImageMemory.size(for: id))
        }
    }
}
