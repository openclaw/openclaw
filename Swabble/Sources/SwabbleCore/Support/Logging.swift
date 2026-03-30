import Foundation

public enum LogLevel: String, Comparable, CaseIterable, Sendable {
    case trace, debug, info, warn, error

    var rank: Int {
        switch self {
        case .trace: 0
        case .debug: 1
        case .info: 2
        case .warn: 3
        case .error: 4
        }
    }

    public static func < (lhs: LogLevel, rhs: LogLevel) -> Bool { lhs.rank < rhs.rank }
}

public enum LogFormat: String, Sendable {
    case text
    case json
}

public enum LogFieldValue: Sendable, Encodable, Equatable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case array([LogFieldValue])
    case object([String: LogFieldValue])
    case null

    public init(_ value: String) { self = .string(value) }
    public init(_ value: Int) { self = .int(value) }
    public init(_ value: Double) { self = .double(value) }
    public init(_ value: Bool) { self = .bool(value) }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case let .string(value):
            try container.encode(value)
        case let .int(value):
            try container.encode(value)
        case let .double(value):
            try container.encode(value)
        case let .bool(value):
            try container.encode(value)
        case let .array(value):
            try container.encode(value)
        case let .object(value):
            try container.encode(value)
        case .null:
            try container.encodeNil()
        }
    }
}

public struct Logger: Sendable {
    public let level: LogLevel
    public let format: LogFormat
    public let redactPii: Bool

    public init(level: LogLevel, format: LogFormat = .text, redactPii: Bool = true) {
        self.level = level
        self.format = format
        self.redactPii = redactPii
    }

    public func log(_ level: LogLevel, _ message: String) {
        log(level, event: "log", message: message)
    }

    public func log(_ level: LogLevel, event: String, message: String, fields: [String: LogFieldValue] = [:]) {
        guard let line = formattedLine(level, event: event, message: message, fields: fields) else { return }
        print(line)
    }

    public func formattedLine(
        _ level: LogLevel,
        event: String,
        message: String,
        fields: [String: LogFieldValue] = [:],
        timestamp: Date = Date())
    -> String? {
        guard level >= self.level else { return nil }

        let ts = Self.timestamp(from: timestamp)
        let sanitizedMessage = redactPii ? redact(message) : message
        let sanitizedEvent = redactPii ? redact(event) : event
        let sanitizedFields = Self.sanitizeFields(fields, redactPii: redactPii)

        switch format {
        case .text:
            return Self.renderText(
                ts: ts,
                level: level,
                event: sanitizedEvent,
                message: sanitizedMessage,
                fields: sanitizedFields)
        case .json:
            return Self.renderJSON(
                ts: ts,
                level: level,
                event: sanitizedEvent,
                message: sanitizedMessage,
                fields: sanitizedFields)
        }
    }

    public func trace(_ msg: String) { log(.trace, msg) }
    public func debug(_ msg: String) { log(.debug, msg) }
    public func info(_ msg: String) { log(.info, msg) }
    public func warn(_ msg: String) { log(.warn, msg) }
    public func error(_ msg: String) { log(.error, msg) }

    public func trace(event: String, message: String, fields: [String: LogFieldValue] = [:]) {
        log(.trace, event: event, message: message, fields: fields)
    }

    public func debug(event: String, message: String, fields: [String: LogFieldValue] = [:]) {
        log(.debug, event: event, message: message, fields: fields)
    }

    public func info(event: String, message: String, fields: [String: LogFieldValue] = [:]) {
        log(.info, event: event, message: message, fields: fields)
    }

    public func warn(event: String, message: String, fields: [String: LogFieldValue] = [:]) {
        log(.warn, event: event, message: message, fields: fields)
    }

    public func error(event: String, message: String, fields: [String: LogFieldValue] = [:]) {
        log(.error, event: event, message: message, fields: fields)
    }

    private static let sensitiveFieldNames: Set<String> = [
        "transcript",
        "text",
        "utterance",
        "commandargs"
    ]

    private static func sanitizeFields(_ fields: [String: LogFieldValue], redactPii: Bool) -> [String: LogFieldValue] {
        var output: [String: LogFieldValue] = [:]
        output.reserveCapacity(fields.count)
        for (key, value) in fields {
            output[key] = sanitizeFieldValue(key: key, value: value, redactPii: redactPii)
        }
        return output
    }

    private static func sanitizeFieldValue(key: String, value: LogFieldValue, redactPii: Bool) -> LogFieldValue {
        guard redactPii else { return value }

        if sensitiveFieldNames.contains(key.lowercased()) {
            return .string("[REDACTED_TEXT]")
        }

        switch value {
        case let .string(text):
            return .string(redact(text))
        case let .array(values):
            return .array(values.map { sanitizeFieldValue(key: key, value: $0, redactPii: redactPii) })
        case let .object(fields):
            var sanitized: [String: LogFieldValue] = [:]
            sanitized.reserveCapacity(fields.count)
            for (nestedKey, nestedValue) in fields {
                sanitized[nestedKey] = sanitizeFieldValue(key: nestedKey, value: nestedValue, redactPii: redactPii)
            }
            return .object(sanitized)
        case .int, .double, .bool, .null:
            return value
        }
    }

    private static func timestamp(from date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    private static func renderText(
        ts: String,
        level: LogLevel,
        event: String,
        message: String,
        fields: [String: LogFieldValue])
    -> String {
        var output = "[\(level.rawValue.uppercased())] \(ts) | \(message)"
        if event != "log" {
            output += " event=\(event)"
        }

        if !fields.isEmpty {
            let rendered = fields
                .sorted { $0.key < $1.key }
                .map { "\($0.key)=\(textValue(for: $0.value))" }
                .joined(separator: " ")
            output += " \(rendered)"
        }

        return output
    }

    private static func renderJSON(
        ts: String,
        level: LogLevel,
        event: String,
        message: String,
        fields: [String: LogFieldValue])
    -> String {
        let payload = LogEvent(ts: ts, level: level.rawValue, event: event, message: message, fields: fields)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]

        guard let data = try? encoder.encode(payload),
              let line = String(data: data, encoding: .utf8)
        else {
            return "{\"ts\":\"\(ts)\",\"level\":\"\(level.rawValue)\",\"event\":\"logger.encode_error\",\"message\":\"Failed to encode log event\",\"fields\":{}}"
        }
        return line
    }

    private static func textValue(for value: LogFieldValue) -> String {
        switch value {
        case let .string(text):
            return text.replacingOccurrences(of: "\n", with: "\\n")
        case let .int(number):
            return String(number)
        case let .double(number):
            return String(number)
        case let .bool(flag):
            return String(flag)
        case let .array(values):
            return "[\(values.map(textValue(for:)).joined(separator: ","))]"
        case let .object(fields):
            return "{\(fields.sorted(by: { $0.key < $1.key }).map { "\($0.key):\(textValue(for: $0.value))" }.joined(separator: ","))}"
        case .null:
            return "null"
        }
    }
}

private struct LogEvent: Encodable {
    let ts: String
    let level: String
    let event: String
    let message: String
    let fields: [String: LogFieldValue]
}

extension LogLevel {
    public init?(configValue: String) {
        self.init(rawValue: configValue.lowercased())
    }
}

extension LogFormat {
    public init?(configValue: String) {
        self.init(rawValue: configValue.lowercased())
    }
}

public func redact(_ text: String) -> String {
    var output = text
    output = replaceAll(in: output, using: RedactionPatterns.email, withTemplate: "[REDACTED_EMAIL]")
    output = replacePhoneNumbers(in: output)
    output = replaceAll(in: output, using: RedactionPatterns.queryValue, withTemplate: "$1=[REDACTED_QUERY]")
    return output
}

public func redactTranscriptIfNeeded(_ text: String, enabled: Bool) -> String {
    guard enabled else { return text }
    return "[REDACTED_TEXT]"
}

private enum RedactionPatterns {
    static let email = try! NSRegularExpression(
        pattern: "[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}",
        options: [.caseInsensitive])

    static let phone = try! NSRegularExpression(
        pattern: "(?<!\\w)(?:\\+?\\d[\\d().\\-\\s]{6,}\\d)(?!\\w)",
        options: [])

    static let queryValue = try! NSRegularExpression(
        pattern: "([?&][^=\\s&]+)=([^&\\s#]*)",
        options: [.caseInsensitive])
}

private func replaceAll(in text: String, using regex: NSRegularExpression, withTemplate template: String) -> String {
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    return regex.stringByReplacingMatches(in: text, options: [], range: range, withTemplate: template)
}

private func replacePhoneNumbers(in text: String) -> String {
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    let matches = RedactionPatterns.phone.matches(in: text, options: [], range: range)
    guard !matches.isEmpty else { return text }

    var output = text
    for match in matches.reversed() {
        guard let stringRange = Range(match.range, in: output) else { continue }
        let candidate = String(output[stringRange])
        let digitCount = candidate.filter(\.isNumber).count
        if digitCount >= 10 {
            output.replaceSubrange(stringRange, with: "[REDACTED_PHONE]")
        }
    }

    return output
}
