import Foundation
import OpenClawKit

enum ShareDraftComposer {
    /// These lines came from the legacy generated share template. Match the
    /// complete trimmed line so real content such as "Text: details" survives.
    private static let legacyScaffoldLines: Set<String> = [
        "shared from ios.",
        "text:",
        "shared attachment(s):",
        "please help me with this.",
    ]

    static func compose(from payload: SharedContentPayload) -> String {
        [self.sanitize(payload.title), self.sanitize(payload.text), payload.url?.absoluteString.trimmedNonEmpty]
            .compactMap(\.self)
            .joined(separator: "\n\n")
    }

    private static func sanitize(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let cleanedLines = raw
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { line in
                !line.isEmpty && !self.legacyScaffoldLines.contains(line.lowercased())
            }
        let cleaned = cleanedLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? nil : cleaned
    }
}

enum SharePayloadNormalizer {
    static func distinctProviderText(_ raw: String?, sharedURL: URL?) -> String? {
        guard let candidate = raw?.trimmedNonEmpty else { return nil }
        return candidate == sharedURL?.absoluteString.trimmedNonEmpty ? nil : candidate
    }

    static func distinctAttributedText(_ raw: String?, sharedText: String?, sharedURL: URL?) -> String? {
        guard let candidate = raw?.trimmedNonEmpty else { return nil }
        let duplicates = [sharedText?.trimmedNonEmpty, sharedURL?.absoluteString.trimmedNonEmpty].compactMap(\.self)
        return duplicates.contains(candidate) ? nil : candidate
    }

    static func webURL(from raw: String) -> URL? {
        guard let trimmed = raw.trimmedNonEmpty else { return nil }
        guard let components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              components.host?.isEmpty == false
        else {
            return nil
        }
        return components.url
    }
}
