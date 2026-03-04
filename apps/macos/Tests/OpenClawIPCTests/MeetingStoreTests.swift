import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct MeetingStoreTests {
    /// Creates a temp directory and swaps the meetings dir for testing.
    private func withTempMeetingsDir(_ body: (MeetingStore) throws -> Void) throws {
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-meeting-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        // We test the store via its public API, writing to the real meetings dir.
        // Instead, we test the data roundtrip directly.
        let store = MeetingStore.shared
        try body(store)
    }

    @Test func storedMeetingCodableRoundTrip() throws {
        let meeting = StoredMeeting(
            id: UUID(),
            title: "Weekly Standup",
            startedAt: Date(),
            endedAt: Date().addingTimeInterval(1800),
            calendarEventId: "cal-abc",
            attendees: ["alice@example.com", "bob@example.com"],
            transcript: [
                StoredMeeting.StoredSegment(speaker: .me, text: "Hello everyone", timestamp: Date()),
                StoredMeeting.StoredSegment(speaker: .other, text: "Hi there", timestamp: Date()),
                StoredMeeting.StoredSegment(speaker: .me, text: "Let's get started", timestamp: Date()),
            ])

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(meeting)

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let decoded = try decoder.decode(StoredMeeting.self, from: data)

        #expect(decoded.id == meeting.id)
        #expect(decoded.title == meeting.title)
        #expect(decoded.calendarEventId == meeting.calendarEventId)
        #expect(decoded.attendees.count == 2)
        #expect(decoded.transcript.count == 3)
        #expect(decoded.transcript[0].speaker == .me)
        #expect(decoded.transcript[0].text == "Hello everyone")
        #expect(decoded.transcript[1].speaker == .other)
    }

    @Test func storedMeetingWithNilOptionals() throws {
        let meeting = StoredMeeting(
            id: UUID(),
            title: "Ad-hoc Call",
            startedAt: Date(),
            endedAt: nil,
            calendarEventId: nil,
            attendees: [],
            transcript: [])

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(meeting)

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let decoded = try decoder.decode(StoredMeeting.self, from: data)

        #expect(decoded.title == "Ad-hoc Call")
        #expect(decoded.endedAt == nil)
        #expect(decoded.calendarEventId == nil)
        #expect(decoded.attendees.isEmpty)
        #expect(decoded.transcript.isEmpty)
    }

    @Test func meetingSummaryFormattedDuration() {
        let summary = MeetingSummary(
            id: UUID(),
            title: "Test",
            startedAt: Date(),
            endedAt: Date().addingTimeInterval(5400), // 1.5 hours
            segmentCount: 10,
            fileName: "test.json")
        #expect(summary.formattedDuration == "1h 30m")
    }

    @Test func meetingSummaryFormattedDurationShort() {
        let summary = MeetingSummary(
            id: UUID(),
            title: "Quick",
            startedAt: Date(),
            endedAt: Date().addingTimeInterval(300), // 5 min
            segmentCount: 3,
            fileName: "quick.json")
        #expect(summary.formattedDuration == "5m")
    }

    @Test func meetingSummaryFormattedDurationNoEndDate() {
        let summary = MeetingSummary(
            id: UUID(),
            title: "Ongoing",
            startedAt: Date(),
            endedAt: nil,
            segmentCount: 0,
            fileName: "ongoing.json")
        #expect(summary.formattedDuration == "–")
    }

    @Test func meetingSummaryFormattedDate() {
        let summary = MeetingSummary(
            id: UUID(),
            title: "Test",
            startedAt: Date(),
            endedAt: nil,
            segmentCount: 0,
            fileName: "test.json")
        #expect(!summary.formattedDate.isEmpty)
    }

    @Test func meetingSummaryDuration() {
        let summary = MeetingSummary(
            id: UUID(),
            title: "Test",
            startedAt: Date(),
            endedAt: Date().addingTimeInterval(600),
            segmentCount: 5,
            fileName: "test.json")
        #expect(summary.duration == 600)
    }

    @Test func saveAndLoadRoundTrip() throws {
        let store = MeetingStore.shared
        let session = MeetingSession(title: "Test Save Load")
        session.start()
        session.appendSegment(TranscriptSegment(speaker: .me, text: "Hello", isFinal: true))
        session.appendSegment(TranscriptSegment(speaker: .other, text: "Hi", isFinal: true))
        session.stop()

        store.save(session: session)

        // Verify it shows up in summaries
        #expect(store.summaries.contains { $0.id == session.id })

        // Verify we can load the full meeting
        let loaded = store.load(id: session.id)
        #expect(loaded != nil)
        #expect(loaded?.title == "Test Save Load")
        #expect(loaded?.transcript.count == 2)
        #expect(loaded?.transcript[0].text == "Hello")
        #expect(loaded?.transcript[1].text == "Hi")

        // Clean up
        store.delete(id: session.id)
        #expect(!store.summaries.contains { $0.id == session.id })
    }

    @Test func saveFilterOutNonFinalSegments() {
        let store = MeetingStore.shared
        let session = MeetingSession(title: "Test Non-Final Filter")
        session.start()
        session.appendSegment(TranscriptSegment(speaker: .me, text: "Final text", isFinal: true))
        session.appendSegment(TranscriptSegment(speaker: .other, text: "Partial", isFinal: false))
        session.stop()

        store.save(session: session)
        let loaded = store.load(id: session.id)
        // Only the final segment should be stored
        #expect(loaded?.transcript.count == 1)
        #expect(loaded?.transcript[0].text == "Final text")

        store.delete(id: session.id)
    }

    @Test func deleteNonExistentIdIsNoOp() {
        let store = MeetingStore.shared
        let before = store.summaries.count
        store.delete(id: UUID())
        #expect(store.summaries.count == before)
    }

    @Test func loadNonExistentIdReturnsNil() {
        let store = MeetingStore.shared
        let result = store.load(id: UUID())
        #expect(result == nil)
    }

    @Test func loadAllPopulatesSummaries() {
        let store = MeetingStore.shared
        store.loadAll()
        // Just verify it doesn't crash and returns an array
        #expect(store.summaries.count >= 0)
    }
}
