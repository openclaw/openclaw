import Foundation

enum ChatMarkdownPreprocessor {
    // Keep in sync with `src/auto-reply/reply/strip-inbound-meta.ts`
    // (`INBOUND_META_SENTINELS`), and extend parser expectations in
    // `ChatMarkdownPreprocessorTests` when sentinels change.
    private static let inboundContextHeaders = [
        "Conversation info (untrusted metadata):",
        "Sender (untrusted metadata):",
        "Thread starter (untrusted, for context):",
        "Replied message (untrusted, for context):",
        "Forwarded message context (untrusted metadata):",
        "Chat history since last reply (untrusted, for context):",
    ]

    private static let markdownImagePattern = #"!\[([^\]]*)\]\(([^)]+)\)"#

    struct InlineImage: Identifiable {
        let id = UUID()
        let label: String
        let image: OpenClawPlatformImage?
    }

    struct Result {
        let cleaned: String
        let images: [InlineImage]
    }

    static func preprocess(markdown raw: String) -> Result {
        let withoutContextBlocks = self.stripInboundContextBlocks(raw)
        let withoutTimestamps = self.stripPrefixedTimestamps(withoutContextBlocks)
        guard let re = try? NSRegularExpression(pattern: self.markdownImagePattern) else {
            return Result(cleaned: self.normalize(withoutTimestamps), images: [])
        }

        let ns = withoutTimestamps as NSString
        let matches = re.matches(
            in: withoutTimestamps,
            range: NSRange(location: 0, length: ns.length))
        if matches.isEmpty { return Result(cleaned: self.normalize(withoutTimestamps), images: []) }

        var images: [InlineImage] = []
        let cleaned = NSMutableString(string: withoutTimestamps)

        for match in matches.reversed() {
            guard match.numberOfRanges >= 3 else { continue }
            let label = ns.substring(with: match.range(at: 1))
            let source = ns.substring(with: match.range(at: 2))

            if let inlineImage = self.inlineImage(label: label, source: source) {
                images.append(inlineImage)
                cleaned.replaceCharacters(in: match.range, with: "")
            } else {
                cleaned.replaceCharacters(in: match.range, with: self.fallbackImageLabel(label))
            }
        }

        return Result(cleaned: self.normalize(cleaned as String), images: images.reversed())
    }

    private static func inlineImage(label: String, source: String) -> InlineImage? {
        let trimmed = source.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let comma = trimmed.firstIndex(of: ","),
              trimmed[..<comma].range(
                  of: #"^data:image\/[^;]+;base64$"#,
                  options: [.regularExpression, .caseInsensitive]) != nil
        else {
            return nil
        }

        let b64 = String(trimmed[trimmed.index(after: comma)...])
        let image = Data(base64Encoded: b64).flatMap(OpenClawPlatformImage.init(data:))
        return InlineImage(label: label, image: image)
    }

    private static func fallbackImageLabel(_ label: String) -> String {
        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "image" : trimmed
    }

    private static func stripInboundContextBlocks(_ raw: String) -> String {
        guard self.inboundContextHeaders.contains(where: raw.contains) else {
            return raw
        }

        let normalized = raw.replacingOccurrences(of: "\r\n", with: "\n")
        var outputLines: [String] = []
        var inMetaBlock = false
        var inFencedJson = false

        for line in normalized.split(separator: "\n", omittingEmptySubsequences: false) {
            let currentLine = String(line)

            if !inMetaBlock && self.inboundContextHeaders.contains(where: currentLine.hasPrefix) {
                inMetaBlock = true
                inFencedJson = false
                continue
            }

            if inMetaBlock {
                if !inFencedJson && currentLine.trimmingCharacters(in: .whitespacesAndNewlines) == "```json" {
                    inFencedJson = true
                    continue
                }

                if inFencedJson {
                    if currentLine.trimmingCharacters(in: .whitespacesAndNewlines) == "```" {
                        inMetaBlock = false
                        inFencedJson = false
                    }
                    continue
                }

                if currentLine.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    continue
                }

                inMetaBlock = false
            }

            outputLines.append(currentLine)
        }

        return outputLines
            .joined(separator: "\n")
            .replacingOccurrences(of: #"^\n+"#, with: "", options: .regularExpression)
    }

    private static func stripPrefixedTimestamps(_ raw: String) -> String {
        let pattern = #"(?m)^\[[A-Za-z]{3}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s+(?:GMT|UTC)[+-]?\d{0,2}\]\s*"#
        return raw.replacingOccurrences(of: pattern, with: "", options: .regularExpression)
    }

    private static func normalize(_ raw: String) -> String {
        var output = raw
        output = output.replacingOccurrences(of: "\r\n", with: "\n")
        output = output.replacingOccurrences(of: "\n\n\n", with: "\n\n")
        output = output.replacingOccurrences(of: "\n\n\n", with: "\n\n")
        return output.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
