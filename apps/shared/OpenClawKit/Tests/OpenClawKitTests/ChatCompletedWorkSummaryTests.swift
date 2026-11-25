import Foundation
import Testing
@testable import OpenClawChatUI

@Suite("Completed work summary")
struct ChatCompletedWorkSummaryTests {
    @Test func `names only the elapsed time, in milliseconds below a second and none for zero`() {
        #expect(Self.label(duration: nil) == "Worked")
        #expect(Self.label(duration: 400) == "Worked for 400ms")
        #expect(Self.label(duration: 0) == "Worked")
    }

    @Test func `malformed activity preserves message text`() throws {
        let messages = try Self.decode("""
        {"role":"assistant","content":[{"type":"text","text":"Still visible."}],
         "activity":[{"itemId":42}]}
        """)
        let message = try #require(messages.first)
        #expect(message.content.first?.text == "Still visible.")
        #expect(message.activity == nil)
    }

    private static func decode(_ json: String) throws -> [OpenClawChatMessage] {
        try [JSONDecoder().decode(OpenClawChatMessage.self, from: Data(json.utf8))]
    }

    private static func label(duration: Double?) -> String {
        ChatCompletedWorkSummary.label(work: .init(anchorID: UUID(), messages: [], durationMilliseconds: duration))
    }
}
