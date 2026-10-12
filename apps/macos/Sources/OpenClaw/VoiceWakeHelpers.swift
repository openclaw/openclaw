import Foundation

func sanitizeVoiceWakeTriggers(_ words: [String]) -> [String] {
    let cleaned = words
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
        .prefix(voiceWakeMaxWords)
        .map { String($0.prefix(voiceWakeMaxWordLength)) }
    return cleaned.isEmpty ? defaultVoiceWakeTriggers : cleaned
}

func normalizeLocaleIdentifier(_ raw: String) -> String {
    var trimmed = raw
    if let at = trimmed.firstIndex(of: "@") {
        trimmed = String(trimmed[..<at])
    }
    for marker in ["-u-", "-t-"] {
        if let range = trimmed.range(of: marker) {
            trimmed = String(trimmed[..<range.lowerBound])
        }
    }
    return trimmed
}
