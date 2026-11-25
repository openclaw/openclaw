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
