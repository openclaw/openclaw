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
        "please help me with this.w",
    ]

    static func compose(from payload: SharedContentPayload) -> String {
        var fragments: [String] = []
        let title = self.sanitize(payload.title)
        let text = self.sanitize(payload.text)
        let url = payload.url?.absoluteString.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        if let title { fragments.append(title) }
        if let text { fragments.append(text) }
        if !url.isEmpty { fragments.append(url) }

        return fragments.joined(separator: "\n\n")
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
