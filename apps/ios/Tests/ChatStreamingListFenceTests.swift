import XCTest
@testable import OpenClawChatUI

final class ChatStreamingListFenceTests: XCTestCase {
    private func nestedCode(_ markdown: String, isComplete: Bool) throws -> ChatCodeBlock {
        let blocks = ChatMarkdownBlockSegmenter.segments(markdown: markdown, isComplete: isComplete)
        guard case let .list(list) = try XCTUnwrap(blocks.first) else {
            XCTFail("Expected a list block")
            throw CancellationError()
        }
        for case let .code(code) in try XCTUnwrap(list.items.first).content {
            return code
        }
        XCTFail("Expected a nested code block")
        throw CancellationError()
    }

    func testUnfinishedNestedFenceStaysIncompleteWhileStreaming() throws {
        let code = try self.nestedCode("- Diagram:\n\n  ```mermaid\n  graph TD\n  A -->", isComplete: false)
        XCTAssertFalse(code.isComplete)
    }

    func testClosedNestedFenceIsCompleteWhileStreaming() throws {
        let code = try self.nestedCode(
            "- Diagram:\n\n  ```mermaid\n  graph TD\n  A --> B\n  ```\n- next",
            isComplete: false)
        XCTAssertTrue(code.isComplete)
    }

    func testFinishedMessageCompletesAnUnclosedNestedFence() throws {
        let code = try self.nestedCode("- Diagram:\n\n  ```mermaid\n  graph TD\n  A -->", isComplete: true)
        XCTAssertTrue(code.isComplete)
    }
}
