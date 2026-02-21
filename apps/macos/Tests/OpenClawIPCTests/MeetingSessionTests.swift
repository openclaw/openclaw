import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct MeetingSessionTests {
    @Test func sessionInitializesWithDefaults() {
        let session = MeetingSession(title: "Standup")
        #expect(session.title == "Standup")
        #expect(session.status == .idle)
        #expect(session.segments.isEmpty)
        #expect(session.endedAt == nil)
        #expect(session.calendarEventId == nil)
        #expect(session.attendees.isEmpty)
    }

    @Test func sessionInitializesWithAllProperties() {
        let date = Date()
        let session = MeetingSession(
            title: "Design Review",
            startedAt: date,
            calendarEventId: "cal-123",
            attendees: ["alice@example.com", "bob@example.com"])
        #expect(session.title == "Design Review")
        #expect(session.startedAt == date)
        #expect(session.calendarEventId == "cal-123")
        #expect(session.attendees.count == 2)
    }

    @Test func startSetsStatusToRecording() {
        let session = MeetingSession(title: "Test")
        session.start()
        #expect(session.status == .recording)
    }

    @Test func stopSetsStatusToEndedAndSetsEndDate() {
        let session = MeetingSession(title: "Test")
        session.start()
        session.stop()
        #expect(session.status == .ended)
        #expect(session.endedAt != nil)
    }

    @Test func appendSegmentAddsToList() {
        let session = MeetingSession(title: "Test")
        let segment = TranscriptSegment(speaker: .me, text: "Hello", isFinal: true)
        session.appendSegment(segment)
        #expect(session.segments.count == 1)
        #expect(session.segments.first?.text == "Hello")
        #expect(session.segments.first?.speaker == .me)
    }

    @Test func appendMultipleSegments() {
        let session = MeetingSession(title: "Test")
        session.appendSegment(TranscriptSegment(speaker: .me, text: "Hello", isFinal: true))
        session.appendSegment(TranscriptSegment(speaker: .other, text: "Hi there", isFinal: true))
        session.appendSegment(TranscriptSegment(speaker: .me, text: "How are you?", isFinal: true))
        #expect(session.segments.count == 3)
    }

    @Test func updateLastSegmentUpdatesExistingNonFinal() {
        let session = MeetingSession(title: "Test")
        session.updateLastSegment(for: .me, text: "Hel", isFinal: false)
        #expect(session.segments.count == 1)
        #expect(session.segments.first?.text == "Hel")
        #expect(session.segments.first?.isFinal == false)

        session.updateLastSegment(for: .me, text: "Hello world", isFinal: false)
        #expect(session.segments.count == 1)
        #expect(session.segments.first?.text == "Hello world")

        session.updateLastSegment(for: .me, text: "Hello world!", isFinal: true)
        #expect(session.segments.count == 1)
        #expect(session.segments.first?.text == "Hello world!")
        #expect(session.segments.first?.isFinal == true)
    }

    @Test func updateLastSegmentCreatesNewAfterFinal() {
        let session = MeetingSession(title: "Test")
        session.updateLastSegment(for: .me, text: "First sentence", isFinal: true)
        #expect(session.segments.count == 1)

        session.updateLastSegment(for: .me, text: "Second", isFinal: false)
        #expect(session.segments.count == 2)
        #expect(session.segments.last?.text == "Second")
    }

    @Test func updateLastSegmentTracksSpeakersSeparately() {
        let session = MeetingSession(title: "Test")
        session.updateLastSegment(for: .me, text: "Me partial", isFinal: false)
        session.updateLastSegment(for: .other, text: "Other partial", isFinal: false)
        #expect(session.segments.count == 2)

        session.updateLastSegment(for: .me, text: "Me updated", isFinal: false)
        #expect(session.segments.count == 2)
        #expect(session.segments.first?.text == "Me updated")
    }

    @Test func durationCalculatesCorrectly() {
        let start = Date(timeIntervalSinceNow: -120) // 2 minutes ago
        let session = MeetingSession(title: "Test", startedAt: start)
        #expect(session.duration >= 119)
        #expect(session.duration <= 121)
    }

    @Test func durationUsesEndDateWhenEnded() {
        let start = Date(timeIntervalSinceNow: -300) // 5 minutes ago
        let session = MeetingSession(title: "Test", startedAt: start)
        session.stop()
        let duration = session.duration
        // Should be approximately 300s, not growing
        #expect(duration >= 299)
        #expect(duration <= 301)
    }

    @Test func formattedDurationShowsMinutesAndSeconds() {
        let start = Date(timeIntervalSinceNow: -90) // 1:30
        let session = MeetingSession(title: "Test", startedAt: start)
        let formatted = session.formattedDuration
        #expect(formatted.contains(":"))
    }

    @Test func formattedDurationShowsHoursWhenNeeded() {
        let start = Date(timeIntervalSinceNow: -3700) // > 1 hour
        let session = MeetingSession(title: "Test", startedAt: start)
        let formatted = session.formattedDuration
        // Should have format like "1:01:40"
        let colonCount = formatted.filter { $0 == ":" }.count
        #expect(colonCount == 2)
    }
}

@Suite
struct TranscriptSegmentTests {
    @Test func segmentHasUniqueId() {
        let seg1 = TranscriptSegment(speaker: .me, text: "Hello")
        let seg2 = TranscriptSegment(speaker: .me, text: "Hello")
        #expect(seg1.id != seg2.id)
    }

    @Test func segmentDefaultsToCurrentTimestamp() {
        let before = Date()
        let segment = TranscriptSegment(speaker: .other, text: "Test")
        let after = Date()
        #expect(segment.timestamp >= before)
        #expect(segment.timestamp <= after)
    }

    @Test func segmentDefaultsToNotFinal() {
        let segment = TranscriptSegment(speaker: .me, text: "Test")
        #expect(segment.isFinal == false)
    }

    @Test func speakerCodableRoundTrip() throws {
        let cases: [Speaker] = [.me, .other, .unknown]
        for speaker in cases {
            let data = try JSONEncoder().encode(speaker)
            let decoded = try JSONDecoder().decode(Speaker.self, from: data)
            #expect(decoded == speaker)
        }
    }

    @Test func segmentCodableRoundTrip() throws {
        let segment = TranscriptSegment(speaker: .me, text: "Hello world", timestamp: Date(), isFinal: true)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let data = try encoder.encode(segment)
        let decoded = try decoder.decode(TranscriptSegment.self, from: data)
        #expect(decoded.id == segment.id)
        #expect(decoded.speaker == segment.speaker)
        #expect(decoded.text == segment.text)
        #expect(decoded.isFinal == segment.isFinal)
    }
}
