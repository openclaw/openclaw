import Foundation
import Testing
@testable import Clawdbot

@Suite(.serialized)
struct SessionMenuPreviewTests {
    @Test func loaderReturnsCachedItems() async {
        await SessionPreviewCache.shared._testReset()
        let items = [SessionPreviewItem(id: "1", role: .user, text: "Hi")]
        await SessionPreviewCache.shared._testSet(items: items, for: "main")

        let snapshot = await SessionMenuPreviewLoader.load(sessionKey: "main", maxItems: 10)
        #expect(snapshot.status == .ready)
        #expect(snapshot.items.count == 1)
        #expect(snapshot.items.first?.text == "Hi")
    }

    @Test func loaderReturnsEmptyWhenCachedEmpty() async {
        await SessionPreviewCache.shared._testReset()
        await SessionPreviewCache.shared._testSet(items: [], for: "main")

        let snapshot = await SessionMenuPreviewLoader.load(sessionKey: "main", maxItems: 10)
        #expect(snapshot.status == .empty)
        #expect(snapshot.items.isEmpty)
    }
}
