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
        var cleaned = ""
        raw.enumerateSubstrings(in: raw.startIndex..<raw.endIndex, options: .byLines) { line, _, range, _ in
            let comparison = (line ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if !self.legacyScaffoldLines.contains(comparison) {
                cleaned += raw[range]
            }
        }
        return cleaned.trimmedNonEmpty == nil ? nil : cleaned
    }
}

enum SharePayloadNormalizer {
    static func distinctProviderText(_ raw: String?, sharedURL: URL?) -> String? {
        guard let candidate = raw?.trimmedNonEmpty else { return nil }
        return candidate == sharedURL?.absoluteString.trimmedNonEmpty ? nil : raw
    }

    static func distinctAttributedText(_ raw: String?, sharedText: String?, sharedURL: URL?) -> String? {
        guard let candidate = raw?.trimmedNonEmpty else { return nil }
        let duplicates = [sharedText?.trimmedNonEmpty, sharedURL?.absoluteString.trimmedNonEmpty].compactMap(\.self)
        return duplicates.contains(candidate) ? nil : raw
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
