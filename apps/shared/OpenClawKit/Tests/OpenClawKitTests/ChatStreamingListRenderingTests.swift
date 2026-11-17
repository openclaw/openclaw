import SwiftUI
import Testing
@testable import OpenClawChatUI

struct ChatStreamingListRenderingTests {
    @Test @MainActor func `reader anchors distinguish repeated block prefixes through finalization`() throws {
        let first = "Deployment checks passed for the staging environment. Region: us-east-1."
        let second = "Deployment checks passed for the staging environment. Region: eu-west-1."
        let text = "# " + first + "\n\n# " + second
        let live = ChatMarkdownRenderSnapshot(text: text, isComplete: false)
        let final = ChatMarkdownRenderSnapshot(text: text, isComplete: true)
        try #require(live.blocks.count == 2)
        try #require(final.blocks.count == 2)
        let firstKey = try #require(ChatMarkdownRenderer.readerBlockKey(live.blocks[0], index: 0))
        let secondKey = try #require(ChatMarkdownRenderer.readerBlockKey(live.blocks[1], index: 1))
        #expect(firstKey != secondKey)
        #expect(firstKey == ChatMarkdownRenderer.readerBlockKey(final.blocks[0], index: 0))
        #expect(secondKey == ChatMarkdownRenderer.readerBlockKey(final.blocks[1], index: 1))
        let repeated = ChatMarkdownRenderSnapshot(text: "# " + first + "\n\n# " + first, isComplete: true)
        try #require(repeated.blocks.count == 2)
        #expect(ChatMarkdownRenderer.readerBlockKey(repeated.blocks[0], index: 0) !=
            ChatMarkdownRenderer.readerBlockKey(repeated.blocks[1], index: 1))
    }
}
