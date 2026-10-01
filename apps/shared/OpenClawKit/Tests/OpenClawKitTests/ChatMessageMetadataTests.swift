import Foundation
import OpenClawKit
import Testing
@testable import OpenClawChatUI

@Suite("Chat message metadata")
struct ChatMessageMetadataTests {
    @Test
    func `history and final events retain the originating model through cache encoding`() throws {
        let raw = """
        {"role":"assistant","content":"Reply","timestamp":1780000000000,"model":"provider/model-a"}
        """
        let history = try JSONDecoder().decode(OpenClawChatHistoryPayload.self, from: Data("""
        {"sessionKey":"agent:main:main","messages":[\(raw)]}
        """.utf8))
        let event = try JSONDecoder().decode(OpenClawChatEventPayload.self, from: Data("""
        {"state":"final","message":\(raw)}
        """.utf8))
        for payload in try [#require(history.messages?.first), #require(event.message)] {
            let message = try GatewayPayloadDecoding.decode(payload, as: OpenClawChatMessage.self)
            let restored = try JSONDecoder().decode(
                OpenClawChatMessage.self,
                from: JSONEncoder()
                    .encode(#require(OpenClawChatSQLiteTranscriptCache.cacheableMessages([message]).first)))
            #expect(restored.model == "provider/model-a")
            #expect(restored.timestamp == 1_780_000_000_000)
        }
    }

    @Test(arguments: ["null", "42", "\"\"", "\"gateway-injected\""])
    func `unknown and injected models do not label replies`(model: String) throws {
        let message = try self.message(model: model)
        #expect(self.footers([message])[message.id]?.model == nil)
    }

    @Test
    func `one footer uses first time and last recorded model without splitting on model changes`() throws {
        let first = try self.message(timestamp: 1000, model: "\"provider/model-a\"")
        let second = try self.message(timestamp: 2000, model: "\"provider/model-b\"")
        let last = try self.message(timestamp: 3000, model: "\"gateway-injected\"")
        let metadata = self.footers([first, second, last])
        #expect(metadata.count == 1)
        #expect(metadata[last.id] == ChatMessageMetadata(timestamp: 1000, model: "provider/model-b"))
    }

    @Test
    func `a hidden trailing group member cannot take the visible reply footer`() throws {
        let reply = try self.message(fields: #""phase":"final_answer""#)
        var hidden = try self.message(
            timestamp: 2000,
            model: "\"provider/model-b\"",
            fields: #""phase":"final_answer""#)
        hidden.content = []
        let metadata = self.footers([reply, hidden], hiddenIDs: [hidden.id])
        #expect(Set(metadata.keys) == [reply.id])
        #expect(metadata[reply.id] == ChatMessageMetadata(timestamp: 1000, model: "provider/model-b"))
    }

    @Test(arguments: [
        #""__openclaw":{"runId":"other"}"#,
        #""__openclaw":{"turnBoundary":true}"#,
        #""senderLabel":"Another agent""#,
        #""senderSession":{"sessionKey":"agent:other:main","label":"Other"}"#,
        #""phase":"final_answer""#,
    ])
    func `recorded group boundaries retain separate footers after cache round trip`(fields: String) throws {
        let first = try self.message()
        let next = try self.message(fields: fields)
        let cached = try #require(OpenClawChatSQLiteTranscriptCache.cacheableMessages([next]).first)
        let restored = try JSONDecoder().decode(OpenClawChatMessage.self, from: JSONEncoder().encode(cached))
        #expect(self.footers([first, restored]).count == 2)
    }

    @Test
    func `user steers group by execution identity and split on sender or transport`() throws {
        let first = try self.message(role: "user", fields: #""__openclaw":{"steerTargetRunId":"run"}"#)
        let next = try self.message(role: "user", fields: #""__openclaw":{"steerTargetRunId":"run"}"#)
        let otherSender = try self.message(
            role: "user",
            fields: #""__openclaw":{"steerTargetRunId":"run","senderName":"Other"}"#)
        let otherClient = try self.message(
            role: "user",
            fields: #""__openclaw":{"steerTargetRunId":"run","transport":{"clients":[{"id":"openclaw-macos","mode":"ui"}]}}"#)
        #expect(self.footers([first, next]).count == 1)
        #expect(self.footers([first, otherSender]).count == 2)
        #expect(self.footers([first, otherClient]).count == 2)
        #expect(self.footers([first])[first.id]?.model == nil)
    }

    @Test
    func `tool commentary and structural rows break groups without metadata of their own`() throws {
        let first = try self.message()
        let tool = try self.message(role: "toolResult")
        let commentary = try self.message(fields: #""phase":"commentary""#)
        let marker = try self.message(role: "system", fields: #""__openclaw":{"kind":"compaction"}"#)
        let answer = try self.message()
        let metadata = self.footers([first, tool, commentary, marker, answer])
        #expect(Set(metadata.keys) == [first.id, answer.id])
    }

    @Test
    func `active replies have no metadata while previous completed groups keep theirs`() throws {
        let first = try self.message(fields: #""__openclaw":{"runId":"done"}"#)
        let active = try self.message(fields: #""__openclaw":{"runId":"active"}"#)
        let user = try self.message(role: "user")
        let rows = ChatTranscriptRow.build(from: [first, active, user])
        let metadata = ChatTranscriptRow.footerMetadata(
            in: rows, activeRunIDs: ["active"], runWorking: true, isMessageVisible: { _ in true })
        #expect(Set(metadata.keys) == [first.id, user.id])
        let overlapping = ChatTranscriptRow.footerMetadata(
            in: ChatTranscriptRow.build(from: [active, first]), activeRunIDs: ["active"], runWorking: true,
            isMessageVisible: { _ in true })
        #expect(Set(overlapping.keys) == [first.id])
        let uncorrelated = try self.message()
        #expect(ChatTranscriptRow.footerMetadata(
            in: ChatTranscriptRow.build(from: [uncorrelated]), activeRunIDs: ["active"], runWorking: true,
            isMessageVisible: { _ in true }).isEmpty)
        #expect(ChatTranscriptRow.footerMetadata(
            in: ChatTranscriptRow.build(from: [first]), activeRunIDs: [], runWorking: true,
            isMessageVisible: { _ in true }).isEmpty)
    }

    private struct TimestampCase: Sendable {
        let age: Double
        var label: String?
        var relative: DateComponents?
    }

    @Test(arguments: [
        TimestampCase(age: -120, label: "Just now"),
        TimestampCase(age: 59.49, label: "Just now"),
        TimestampCase(age: 59.5, relative: DateComponents(minute: -1)),
        TimestampCase(age: 3599.5, relative: DateComponents(hour: -1)),
        TimestampCase(age: 172_800, relative: DateComponents(day: -2)),
        TimestampCase(age: 604_799, relative: DateComponents(day: -7)),
        TimestampCase(age: 604_800, label: "Sep 19"),
        TimestampCase(age: -121, label: "Sep 26"),
    ])
    private func `relative and absolute date thresholds match web`(testCase: TimestampCase) throws {
        let now = try #require(ISO8601DateFormatter().date(from: "2026-09-26T12:00:00Z"))
        let utc = try #require(TimeZone(secondsFromGMT: 0))
        let locale = Locale(identifier: "en_US")
        let display = try #require(ChatMessageTimestampPresentation.make(
            timestamp: (now.timeIntervalSince1970 - testCase.age) * 1000,
            now: now, locale: locale, timeZone: utc))
        let relative = RelativeDateTimeFormatter()
        relative.locale = locale
        relative.unitsStyle = .abbreviated
        relative.dateTimeStyle = .named
        // Foundation owns locale wording; fixed components independently assert our bucket and rounding.
        let expected = testCase.relative.map(relative.localizedString(from:)) ?? testCase.label
        #expect(display.label == expected)
        #expect(display.exact.contains("2026"))
    }

    @Test
    func `exact date includes seconds and zone and old dates include the year in the user locale`() throws {
        let date = try #require(ISO8601DateFormatter().date(from: "2025-12-31T23:59:42Z"))
        let now = try #require(ISO8601DateFormatter().date(from: "2026-09-26T12:00:00Z"))
        let localZone = try #require(TimeZone(secondsFromGMT: 3600))
        let utc = try #require(TimeZone(secondsFromGMT: 0))
        let display = try #require(ChatMessageTimestampPresentation.make(
            timestamp: date.timeIntervalSince1970 * 1000, now: now,
            locale: Locale(identifier: "de_DE"), timeZone: localZone))
        #expect(display.label.contains("Jan"))
        #expect(!display.label.contains("2026"))
        #expect(display.exact.contains("00:59:42"))
        #expect(display.exact.contains("2026"))
        let previousYear = try #require(ChatMessageTimestampPresentation.make(
            timestamp: date.timeIntervalSince1970 * 1000, now: now,
            locale: Locale(identifier: "en_US"), timeZone: utc))
        #expect(previousYear.label == "Dec 31, 2025")
        let repeated = ChatMessageTimestampPresentation.make(
            timestamp: date.timeIntervalSince1970 * 1000, now: now,
            locale: Locale(identifier: "de_DE"), timeZone: localZone)
        #expect(repeated == display)
        #expect(ChatMessageTimestampPresentation.make(timestamp: nil) == nil)
        #expect(ChatMessageTimestampPresentation.make(timestamp: .infinity) == nil)
    }

    private func footers(
        _ messages: [OpenClawChatMessage],
        hiddenIDs: Set<UUID> = []) -> [UUID: ChatMessageMetadata]
    {
        ChatTranscriptRow.footerMetadata(
            in: ChatTranscriptRow.build(from: messages),
            activeRunIDs: [],
            runWorking: false,
            isMessageVisible: { !hiddenIDs.contains($0.id) })
    }

    private func message(
        role: String = "assistant",
        timestamp: Double = 1000,
        model: String = "\"provider/model-a\"",
        fields: String = "") throws -> OpenClawChatMessage
    {
        try JSONDecoder().decode(OpenClawChatMessage.self, from: Data("""
        {"role":"\(role)","content":"Message","timestamp":\(timestamp),"model":\(model)\(fields.isEmpty ? "" : "," + fields)}
        """.utf8))
    }
}
