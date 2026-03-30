import Foundation

private let commandISO8601Formatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
}()

enum CommandOutputFormat: String {
    case text
    case json

    init(parsedValue: String) {
        self = CommandOutputFormat(rawValue: parsedValue.lowercased()) ?? .text
    }
}

func encodeJSONOutput<T: Encodable>(_ value: T) -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]

    if let data = try? encoder.encode(value),
       let output = String(data: data, encoding: .utf8)
    {
        return output
    }
    return "{}"
}

func isoTimestamp(_ date: Date?) -> String? {
    guard let date else { return nil }
    return commandISO8601Formatter.string(from: date)
}

func textTimestamp(_ date: Date?) -> String {
    isoTimestamp(date) ?? "never"
}
