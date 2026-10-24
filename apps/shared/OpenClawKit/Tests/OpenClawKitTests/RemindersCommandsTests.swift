import Foundation
import OpenClawKit
import Testing

struct RemindersCommandsTests {
    @Test func `reminder payload decodes shapes without notes`() throws {
        let data = try #require(
            """
            {"identifier":"r1","title":"Buy milk","completed":false,"listName":"Inbox"}
            """.data(using: .utf8))
        let payload = try JSONDecoder().decode(OpenClawReminderPayload.self, from: data)
        #expect(payload.identifier == "r1")
        #expect(payload.listName == "Inbox")
        #expect(payload.notes == nil)
    }

    @Test func `reminder payload round-trips notes`() throws {
        let payload = OpenClawReminderPayload(
            identifier: "r2",
            title: "Call dentist",
            completed: true,
            notes: "Ask about Friday")
        let data = try JSONEncoder().encode(payload)
        let json = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(json["notes"] as? String == "Ask about Friday")
        #expect(try JSONDecoder().decode(OpenClawReminderPayload.self, from: data) == payload)
    }
}
