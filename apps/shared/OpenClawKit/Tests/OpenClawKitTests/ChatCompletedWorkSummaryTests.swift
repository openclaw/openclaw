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

    @Test func `an activity log names its work in the Control UI's words`() {
        func call(_ name: String, _ state: ChatToolActivityItem.State = .finished) -> ChatToolActivityItem {
            ChatToolActivityItem(
                id: UUID().uuidString, name: name, arguments: nil, details: nil, resultText: "ok", state: state,
                liveDiffStat: nil)
        }
        let cases: [([ChatToolActivityItem], String)] = [
            ([call("read"), call("edit")], "Read and changed files"),
            ([call("read"), call("write")], "Read and changed files"),
            ([call("read", .running), call("edit")], "Reading files, changed files"),
            ([call("read"), call("grep")], "Read files"),
            ([call("grep"), call("skills_search")], "Searched"),
            ([call("read"), call("custom_tool")], "Read files"),
            ([call("custom_tool")], "Used tools"),
            ([call("sessions_send"), call("agents_wait")], "Sent messages, waited for agents"),
            ([call("knowledge_lookup"), call("knowledge_remember")], "Read and updated memory"),
        ]
        for (items, expected) in cases {
            #expect(ChatCompletedWorkSummary.headline(items) == expected)
        }
    }

    private static func decode(_ json: String) throws -> [OpenClawChatMessage] {
        try [JSONDecoder().decode(OpenClawChatMessage.self, from: Data(json.utf8))]
    }

    private static func label(duration: Double?) -> String {
        ChatCompletedWorkSummary.label(work: .init(anchorID: UUID(), messages: [], durationMilliseconds: duration))
    }
}
