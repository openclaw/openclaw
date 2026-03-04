import Foundation
import Observation
import OSLog

struct MeetingSummary: Identifiable, Codable {
    let id: UUID
    let title: String
    let startedAt: Date
    let endedAt: Date?
    let segmentCount: Int
    let fileName: String

    var duration: TimeInterval? {
        guard let endedAt else { return nil }
        return endedAt.timeIntervalSince(self.startedAt)
    }

    var formattedDuration: String {
        guard let duration else { return "–" }
        let total = Int(duration)
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        if hours > 0 {
            return "\(hours)h \(minutes)m"
        }
        return "\(minutes)m"
    }

    var formattedDate: String {
        Self.dateFormatter.string(from: self.startedAt)
    }

    private static let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .short
        return f
    }()
}

struct StoredMeeting: Codable {
    let id: UUID
    let title: String
    let startedAt: Date
    let endedAt: Date?
    let calendarEventId: String?
    let attendees: [String]
    let transcript: [StoredSegment]

    struct StoredSegment: Codable {
        let speaker: Speaker
        let text: String
        let timestamp: Date
    }
}

enum SyncStatus: Sendable {
    case syncing
    case synced
    case failed(String)
}

@MainActor
@Observable
final class MeetingStore {
    static let shared = MeetingStore()
    private let logger = Logger(subsystem: "ai.openclaw", category: "meeting.store")
    private(set) var summaries: [MeetingSummary] = []
    private(set) var gogAvailable = false
    var syncStatuses: [UUID: SyncStatus] = [:]

    private var meetingsDir: URL {
        OpenClawPaths.workspaceURL.appendingPathComponent("meetings", isDirectory: true)
    }

    private var legacyMeetingsDir: URL {
        OpenClawPaths.stateDirURL.appendingPathComponent("meetings", isDirectory: true)
    }

    init() {
        self.ensureDirectory()
        self.checkGogAvailability()
    }

    private func ensureDirectory() {
        let fm = FileManager.default
        if !fm.fileExists(atPath: self.meetingsDir.path) {
            do {
                try fm.createDirectory(at: self.meetingsDir, withIntermediateDirectories: true)
            } catch {
                self.logger.error("failed to create meetings dir: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    // MARK: - Save / Load / Delete

    func save(session: MeetingSession) {
        self.ensureDirectory()
        let stored = StoredMeeting(
            id: session.id,
            title: session.title,
            startedAt: session.startedAt,
            endedAt: session.endedAt,
            calendarEventId: session.calendarEventId,
            attendees: session.attendees,
            transcript: session.segments.filter(\.isFinal).map {
                StoredMeeting.StoredSegment(speaker: $0.speaker, text: $0.text, timestamp: $0.timestamp)
            })

        do {
            let markdown = Self.renderMarkdown(from: stored)
            let fileName = self.fileName(for: session)
            let fileURL = self.meetingsDir.appendingPathComponent(fileName)
            try markdown.write(to: fileURL, atomically: true, encoding: .utf8)
            self.logger.info("saved meeting \(session.id) to \(fileName, privacy: .public)")
            self.loadAll()
            self.syncToGoogleDrive(fileURL: fileURL, meetingId: session.id)
        } catch {
            self.logger.error("failed to save meeting: \(error.localizedDescription, privacy: .public)")
        }
    }

    func loadAll() {
        self.migrateJsonIfNeeded()
        self.ensureDirectory()
        let fm = FileManager.default

        do {
            let files = try fm.contentsOfDirectory(at: self.meetingsDir, includingPropertiesForKeys: [.contentModificationDateKey])
                .filter { $0.pathExtension == "md" }
                .sorted { $0.lastPathComponent > $1.lastPathComponent }

            var loaded: [MeetingSummary] = []
            for file in files {
                do {
                    let content = try String(contentsOf: file, encoding: .utf8)
                    let stored = try Self.parseMarkdown(from: content, fileName: file.lastPathComponent)
                    loaded.append(MeetingSummary(
                        id: stored.id,
                        title: stored.title,
                        startedAt: stored.startedAt,
                        endedAt: stored.endedAt,
                        segmentCount: stored.transcript.count,
                        fileName: file.lastPathComponent))
                } catch {
                    self.logger.warning("skipping malformed meeting file \(file.lastPathComponent, privacy: .public): \(error.localizedDescription, privacy: .public)")
                }
            }
            self.summaries = loaded
        } catch {
            self.logger.error("failed to list meetings dir: \(error.localizedDescription, privacy: .public)")
            self.summaries = []
        }
    }

    func load(id: UUID) -> StoredMeeting? {
        guard let summary = self.summaries.first(where: { $0.id == id }) else { return nil }
        let fileURL = self.meetingsDir.appendingPathComponent(summary.fileName)
        do {
            let content = try String(contentsOf: fileURL, encoding: .utf8)
            return try Self.parseMarkdown(from: content, fileName: summary.fileName)
        } catch {
            self.logger.error("failed to load meeting \(id): \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    func delete(id: UUID) {
        guard let summary = self.summaries.first(where: { $0.id == id }) else { return }
        let fileURL = self.meetingsDir.appendingPathComponent(summary.fileName)
        do {
            try FileManager.default.removeItem(at: fileURL)
            self.logger.info("deleted meeting \(id)")
            self.loadAll()
        } catch {
            self.logger.error("failed to delete meeting \(id): \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: - Markdown Rendering

    static func renderMarkdown(from meeting: StoredMeeting) -> String {
        var lines: [String] = []

        // YAML frontmatter
        lines.append("---")
        lines.append("id: \(meeting.id.uuidString)")
        lines.append("title: \(meeting.title)")
        lines.append("date: \(iso8601String(from: meeting.startedAt))")
        if let endedAt = meeting.endedAt {
            lines.append("endedAt: \(iso8601String(from: endedAt))")
        }
        if let duration = meeting.endedAt.map({ $0.timeIntervalSince(meeting.startedAt) }) {
            lines.append("duration: \(compactDuration(duration))")
        }
        if !meeting.attendees.isEmpty {
            lines.append("attendees:")
            for attendee in meeting.attendees {
                lines.append("  - \(attendee)")
            }
        }
        lines.append("---")
        lines.append("")

        // Title heading
        lines.append("# \(meeting.title)")

        // Date range subtitle
        let dateRange = formatDateRange(start: meeting.startedAt, end: meeting.endedAt)
        lines.append("*\(dateRange)*")
        lines.append("")
        lines.append("---")
        lines.append("")

        // Transcript segments
        for segment in meeting.transcript {
            let speakerName = segment.speaker == .me ? "You" : "Other"
            let timeStr = formatTimeOnly(segment.timestamp)
            lines.append("**\(speakerName)** *(\(timeStr))*")
            lines.append(segment.text)
            lines.append("")
        }

        return lines.joined(separator: "\n")
    }

    // MARK: - Markdown Parsing

    enum ParseError: Error, LocalizedError {
        case missingFrontmatter
        case missingRequiredField(String)
        case invalidDate(String)
        case invalidUUID(String)

        var errorDescription: String? {
            switch self {
            case .missingFrontmatter: return "Missing YAML frontmatter"
            case .missingRequiredField(let f): return "Missing required field: \(f)"
            case .invalidDate(let d): return "Invalid date: \(d)"
            case .invalidUUID(let u): return "Invalid UUID: \(u)"
            }
        }
    }

    static func parseMarkdown(from content: String, fileName: String) throws -> StoredMeeting {
        let (frontmatter, body) = try extractFrontmatter(from: content)
        let fields = parseFrontmatterFields(frontmatter)

        guard let idStr = fields["id"] else { throw ParseError.missingRequiredField("id") }
        guard let id = UUID(uuidString: idStr) else { throw ParseError.invalidUUID(idStr) }
        guard let title = fields["title"] else { throw ParseError.missingRequiredField("title") }
        guard let dateStr = fields["date"] else { throw ParseError.missingRequiredField("date") }
        guard let startedAt = parseISO8601(dateStr) else { throw ParseError.invalidDate(dateStr) }

        let endedAt: Date? = fields["endedAt"].flatMap { parseISO8601($0) }
        let attendees = parseAttendeeList(from: frontmatter)
        let transcript = parseTranscriptSegments(from: body, baseDate: startedAt)

        return StoredMeeting(
            id: id,
            title: title,
            startedAt: startedAt,
            endedAt: endedAt,
            calendarEventId: nil,
            attendees: attendees,
            transcript: transcript)
    }

    private static func extractFrontmatter(from content: String) throws -> (frontmatter: String, body: String) {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("---") else { throw ParseError.missingFrontmatter }

        let afterFirst = trimmed.dropFirst(3).drop(while: { $0.isNewline })
        guard let endRange = afterFirst.range(of: "\n---") else { throw ParseError.missingFrontmatter }

        let frontmatter = String(afterFirst[afterFirst.startIndex..<endRange.lowerBound])
        let body = String(afterFirst[endRange.upperBound...]).trimmingCharacters(in: .newlines)
        return (frontmatter, body)
    }

    private static func parseFrontmatterFields(_ frontmatter: String) -> [String: String] {
        var fields: [String: String] = [:]
        for line in frontmatter.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            // Skip list items and empty lines
            if trimmed.hasPrefix("- ") || trimmed.isEmpty { continue }
            guard let colonIndex = trimmed.firstIndex(of: ":") else { continue }
            let key = String(trimmed[trimmed.startIndex..<colonIndex]).trimmingCharacters(in: .whitespaces)
            let value = String(trimmed[trimmed.index(after: colonIndex)...]).trimmingCharacters(in: .whitespaces)
            if !value.isEmpty {
                fields[key] = value
            }
        }
        return fields
    }

    private static func parseAttendeeList(from frontmatter: String) -> [String] {
        var attendees: [String] = []
        var inAttendees = false
        for line in frontmatter.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("attendees:") {
                inAttendees = true
                continue
            }
            if inAttendees {
                if trimmed.hasPrefix("- ") {
                    let value = String(trimmed.dropFirst(2)).trimmingCharacters(in: .whitespaces)
                    if !value.isEmpty {
                        attendees.append(value)
                    }
                } else if !trimmed.isEmpty {
                    break
                }
            }
        }
        return attendees
    }

    private static func parseTranscriptSegments(from body: String, baseDate: Date) -> [StoredMeeting.StoredSegment] {
        var segments: [StoredMeeting.StoredSegment] = []
        let lines = body.components(separatedBy: "\n")
        var i = 0

        while i < lines.count {
            let line = lines[i]

            // Match **Speaker** *(time)*
            if line.hasPrefix("**"),
               let speakerEnd = line.range(of: "**", range: line.index(line.startIndex, offsetBy: 2)..<line.endIndex),
               let timeStart = line.range(of: "*("),
               let timeEnd = line.range(of: ")*")
            {
                let speakerStr = String(line[line.index(line.startIndex, offsetBy: 2)..<speakerEnd.lowerBound])
                let speaker: Speaker = speakerStr == "You" ? .me : .other

                let timeStr = String(line[timeStart.upperBound..<timeEnd.lowerBound])
                let timestamp = parseTimeOnly(timeStr, baseDate: baseDate) ?? baseDate

                // Collect text lines until next speaker or end
                i += 1
                var textLines: [String] = []
                while i < lines.count {
                    let nextLine = lines[i]
                    if nextLine.hasPrefix("**") && nextLine.contains("*(") {
                        break
                    }
                    let trimmedNext = nextLine.trimmingCharacters(in: .whitespaces)
                    if !trimmedNext.isEmpty {
                        textLines.append(trimmedNext)
                    }
                    i += 1
                }

                if !textLines.isEmpty {
                    segments.append(StoredMeeting.StoredSegment(
                        speaker: speaker,
                        text: textLines.joined(separator: "\n"),
                        timestamp: timestamp))
                }
            } else {
                i += 1
            }
        }

        return segments
    }

    // MARK: - Date Formatting Helpers

    private static let iso8601Formatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private static func iso8601String(from date: Date) -> String {
        iso8601Formatter.string(from: date)
    }

    private static func parseISO8601(_ string: String) -> Date? {
        iso8601Formatter.date(from: string)
    }

    private static let timeOnlyFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "h:mm a"
        return f
    }()

    private static func formatTimeOnly(_ date: Date) -> String {
        timeOnlyFormatter.string(from: date)
    }

    private static func parseTimeOnly(_ string: String, baseDate: Date) -> Date? {
        let f = DateFormatter()
        f.dateFormat = "h:mm a"
        guard let timeParsed = f.date(from: string) else { return nil }

        let calendar = Calendar.current
        let baseComponents = calendar.dateComponents([.year, .month, .day], from: baseDate)
        let timeComponents = calendar.dateComponents([.hour, .minute], from: timeParsed)

        var merged = DateComponents()
        merged.year = baseComponents.year
        merged.month = baseComponents.month
        merged.day = baseComponents.day
        merged.hour = timeComponents.hour
        merged.minute = timeComponents.minute
        return calendar.date(from: merged)
    }

    private static let dateRangeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMM d, yyyy"
        return f
    }()

    private static func formatDateRange(start: Date, end: Date?) -> String {
        let datePart = dateRangeFormatter.string(from: start)
        let startTime = formatTimeOnly(start)
        guard let end else {
            return "\(datePart), \(startTime)"
        }
        let endTime = formatTimeOnly(end)
        let duration = compactDuration(end.timeIntervalSince(start))
        return "\(datePart), \(startTime) – \(endTime) (\(duration))"
    }

    private static func compactDuration(_ interval: TimeInterval) -> String {
        let total = Int(interval)
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        if hours > 0 {
            return "\(hours)h \(minutes)m"
        }
        return "\(minutes)m"
    }

    // MARK: - Legacy JSON Migration

    private func migrateJsonIfNeeded() {
        let fm = FileManager.default
        let sentinel = self.meetingsDir.appendingPathComponent(".migrated-from-json")

        guard fm.fileExists(atPath: self.legacyMeetingsDir.path),
              !fm.fileExists(atPath: sentinel.path) else { return }

        self.ensureDirectory()
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601

        do {
            let files = try fm.contentsOfDirectory(at: self.legacyMeetingsDir, includingPropertiesForKeys: nil)
                .filter { $0.pathExtension == "json" }

            guard !files.isEmpty else {
                // Write sentinel even if no files to avoid re-checking
                try "".write(to: sentinel, atomically: true, encoding: .utf8)
                return
            }

            var migrated = 0
            for file in files {
                do {
                    let data = try Data(contentsOf: file)
                    let stored = try decoder.decode(StoredMeeting.self, from: data)
                    let markdown = Self.renderMarkdown(from: stored)
                    let mdFileName = file.deletingPathExtension().lastPathComponent + ".md"
                    let destURL = self.meetingsDir.appendingPathComponent(mdFileName)
                    if !fm.fileExists(atPath: destURL.path) {
                        try markdown.write(to: destURL, atomically: true, encoding: .utf8)
                        migrated += 1
                    }
                } catch {
                    self.logger.warning("migration: skipping \(file.lastPathComponent, privacy: .public): \(error.localizedDescription, privacy: .public)")
                }
            }

            try "".write(to: sentinel, atomically: true, encoding: .utf8)
            self.logger.info("migrated \(migrated) meetings from JSON to Markdown")
        } catch {
            self.logger.error("migration failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: - Google Drive Sync (gog CLI)

    private static let gogSearchPaths = [
        "/opt/homebrew/bin/gog",
        "/usr/local/bin/gog",
        "/usr/bin/gog",
    ]

    private(set) var gogPath: String?

    private func checkGogAvailability() {
        for path in Self.gogSearchPaths {
            if FileManager.default.isExecutableFile(atPath: path) {
                self.gogPath = path
                self.gogAvailable = true
                return
            }
        }
        self.gogAvailable = false
    }

    func syncToGoogleDrive(fileURL: URL, meetingId: UUID) {
        let enabled = UserDefaults.standard.bool(forKey: "meetingGoogleDriveSyncEnabled")
        guard enabled, self.gogAvailable else { return }
        guard let folderId = UserDefaults.standard.string(forKey: "meetingGoogleDriveFolderId"),
              !folderId.isEmpty else { return }

        self.syncStatuses[meetingId] = .syncing
        let gog = self.gogPath ?? "gog"
        Task.detached { [logger] in
            let result = await ShellExecutor.runDetailed(
                command: [gog, "drive", "upload", fileURL.path, "--parent", folderId],
                cwd: nil,
                env: nil,
                timeout: 30)

            await MainActor.run {
                if result.success {
                    self.syncStatuses[meetingId] = .synced
                    logger.info("synced meeting \(meetingId) to Google Drive")
                } else {
                    let msg = result.errorMessage ?? result.stderr
                    self.syncStatuses[meetingId] = .failed(msg)
                    logger.warning("Google Drive sync failed for \(meetingId): \(msg, privacy: .public)")
                }
            }
        }
    }

    func retrySyncToGoogleDrive(id: UUID) {
        guard let summary = self.summaries.first(where: { $0.id == id }) else { return }
        let fileURL = self.meetingsDir.appendingPathComponent(summary.fileName)
        self.syncToGoogleDrive(fileURL: fileURL, meetingId: id)
    }

    // MARK: - Helpers

    private func fileName(for session: MeetingSession) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd_HH-mm"
        let dateStr = formatter.string(from: session.startedAt)
        let slug = Self.slugify(session.title)
        return "\(dateStr)_\(slug).md"
    }

    private static func slugify(_ title: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-"))
        let slug = title
            .lowercased()
            .replacingOccurrences(of: " ", with: "-")
            .unicodeScalars
            .filter { allowed.contains($0) }
            .map { Character($0) }
        let result = String(slug)
        if result.isEmpty { return "meeting" }
        return String(result.prefix(50))
    }
}
