import Testing
@testable import OpenClawChatUI

struct ChatStreamingCodeFenceTests {
    @Test(arguments: [
        ("1. Diagram\n\n   ", "   "),
        ("- Diagram\n\n  ", "  "),
        ("- Outer\n  - Diagram\n\n    ", "    "),
        ("- ", "  "),
        ("- Diagram\n\t", "\t"),
    ])
    func `list fences stay incomplete until closure or message completion`(_ layout: (String, String)) throws {
        let (prefix, indent) = layout
        for language in ["mermaid", "swift"] {
            let open = prefix + "```" + language + "\n" + indent + "graph TD\n" + indent + "  A["
            let streaming = try self.listCode(in: open, isComplete: false)
            #expect(streaming.language == language)
            #expect(!streaming.isComplete)
            #expect(streaming.code.contains("A["))

            let closed = try self.listCode(in: open + "]\n" + indent + "```", isComplete: false)
            #expect(closed.isComplete)
            #expect(closed.code.contains("A[]"))
            #expect(!closed.code.contains("```"))
            #expect(try self.listCode(in: open, isComplete: true).isComplete)
        }
    }

    @Test(arguments: [
        "- Diagram\n  ````swift\n  value\n  ```",
        "- Diagram\n  ```swift\n  value\n  ~~~",
        "- Diagram\n  ```swift\n  value\n  ``` trailing",
        "- Diagram\n    ```swift\n  value\n      ```",
        "- Diagram\n  ```swift\n  value\n```",
        "- Diagram\n\n      value",
    ])
    func `unclosed list code does not treat content or outside fences as closure`(_ source: String) throws {
        let streaming = try self.listCode(in: source, isComplete: false)
        #expect(!streaming.isComplete)
        #expect(try self.listCode(in: source, isComplete: true).isComplete)
    }

    private func listCode(in source: String, isComplete: Bool) throws -> ChatCodeBlock {
        let blocks = ChatMarkdownBlockSegmenter.segments(markdown: source, isComplete: isComplete)
        guard case let .list(list) = try #require(blocks.first) else {
            throw MissingListCode()
        }
        return try #require(self.firstCode(in: list))
    }

    private func firstCode(in list: ChatMarkdownList) -> ChatCodeBlock? {
        for item in list.items {
            for content in item.content {
                switch content {
                case let .code(code): return code
                case let .list(nested):
                    if let code = self.firstCode(in: nested) { return code }
                case .markdown: break
                }
            }
        }
        return nil
    }

    private struct MissingListCode: Error {}
}
