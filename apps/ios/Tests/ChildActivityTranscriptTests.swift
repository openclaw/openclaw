import Foundation
import OpenClawKit
import Testing
@testable import OpenClawChatUI

struct ChildActivityTranscriptTests {
    /// chat.history presents a parent’s sessions_send message as assistant while preserving its provenance.
    @Test @MainActor func `forwarded instruction is not the childs reply`() async throws {
        let data = Data(#"""
        [{"role":"user","content":"Compare early trains"},
         {"role":"assistant","content":[{"type":"text","text":"The first train leaves at 8."}]},
         {"role":"assistant","content":"Include the return trip",
          "senderSession":{"sessionKey":"agent:main:parent"},
          "provenance":{"kind":"inter_session","sourceTool":"sessions_send","sourceSessionKey":"agent:main:parent"}},
         {"role":"user","content":"Resume after restart","provenance":{"kind":"internal_system"}}]
        """#.utf8)
        let rows = try JSONDecoder().decode([OpenClawKit.AnyCodable].self, from: data)
        let messages = await OpenClawChatViewModel.decodeMessages(rows)
        let detail = ChatActivityChildTranscript(messages: messages)
        #expect(detail.order == "Include the return trip")
        #expect(detail.latestReply == "The first train leaves at 8.")
        let tail = ChatActivityChildTranscript(messages: Array(messages.suffix(2)))
        #expect(tail.order == "Include the return trip")
        #expect(tail.latestReply == nil)
    }

    @Test @MainActor func `failure without authored text is not A reply`() async throws {
        let data = Data(#"""
        [{"role":"user","content":"Check ticket availability"},
         {"role":"assistant","content":[],"stopReason":"error","errorMessage":"Timed out"}]
        """#.utf8)
        let rows = try JSONDecoder().decode([OpenClawKit.AnyCodable].self, from: data)
        let detail = await ChatActivityChildTranscript(messages: OpenClawChatViewModel.decodeMessages(rows))
        #expect(detail.order == "Check ticket availability")
        #expect(detail.latestReply == nil)
    }
}
