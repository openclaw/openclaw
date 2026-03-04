import Foundation
import Observation

enum Speaker: String, Codable, Sendable {
    case me
    case other
    case unknown
}

enum SessionStatus: String, Sendable {
    case idle
    case recording
    case paused
    case ended
}

struct TranscriptSegment: Codable, Identifiable, Sendable {
    let id: UUID
    let speaker: Speaker
    var text: String
    let timestamp: Date
    var isFinal: Bool

    init(speaker: Speaker, text: String, timestamp: Date = Date(), isFinal: Bool = false) {
        self.id = UUID()
        self.speaker = speaker
        self.text = text
        self.timestamp = timestamp
        self.isFinal = isFinal
    }
}

@MainActor
@Observable
final class MeetingSession: Identifiable {
    let id: UUID
    var title: String
    let startedAt: Date
    var endedAt: Date?
    var calendarEventId: String?
    var attendees: [String]
    private(set) var segments: [TranscriptSegment] = []
    var status: SessionStatus = .idle

    init(
        id: UUID = UUID(),
        title: String,
        startedAt: Date = Date(),
        calendarEventId: String? = nil,
        attendees: [String] = [])
    {
        self.id = id
        self.title = title
        self.startedAt = startedAt
        self.calendarEventId = calendarEventId
        self.attendees = attendees
    }

    var duration: TimeInterval {
        let end = self.endedAt ?? Date()
        return end.timeIntervalSince(self.startedAt)
    }

    var formattedDuration: String {
        let total = Int(self.duration)
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let seconds = total % 60
        if hours > 0 {
            return String(format: "%d:%02d:%02d", hours, minutes, seconds)
        }
        return String(format: "%d:%02d", minutes, seconds)
    }

    func start() {
        self.status = .recording
    }

    func stop() {
        self.status = .ended
        self.endedAt = Date()
        // Mark all remaining non-final segments as final so they get saved
        for i in self.segments.indices where !self.segments[i].isFinal {
            self.segments[i].isFinal = true
        }
    }

    func appendSegment(_ segment: TranscriptSegment) {
        self.segments.append(segment)
    }

    func updateLastSegment(for speaker: Speaker, text: String, isFinal: Bool) {
        // Apple's SFSpeechRecognizer sends one cumulative stream of partial results.
        // Update the last non-final segment regardless of speaker, since it's all
        // part of the same recognition stream.
        if let lastIndex = self.segments.lastIndex(where: { !$0.isFinal }) {
            self.segments[lastIndex].text = text
            self.segments[lastIndex].isFinal = isFinal
        } else {
            self.appendSegment(TranscriptSegment(speaker: speaker, text: text, isFinal: isFinal))
        }
    }
}
