import Foundation

enum ChatMarkdownPreprocessor {
    private static let inboundContextHeaders = [
        "Conversation info (untrusted metadata):",
        "Sender (untrusted metadata):",
        "Thread starter (untrusted, for context):",
        "Replied message (untrusted, for context):",
        "Forwarded message context (untrusted metadata):",
        "Chat history since last reply (untrusted, for context):",
    ]

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
        let pattern = #"!\[([^\]]*)\]\((data:image\/[^;]+;base64,[^)]+)\)"#
        guard let re = try? NSRegularExpression(pattern: pattern) else {
            return Result(cleaned: self.normalize(withoutTimestamps), images: [])
        }

        let ns = withoutTimestamps as NSString
        let matches = re.matches(
            in: withoutTimestamps,
            range: NSRange(location: 0, length: ns.length))
        if matches.isEmpty { return Result(cleaned: self.normalize(withoutTimestamps), images: []) }

        var images: [InlineImage] = []
        var cleaned = withoutTimestamps

        for match in matches.reversed() {
            guard match.numberOfRanges >= 3 else { continue }
            let label = ns.substring(with: match.range(at: 1))
            let dataURL = ns.substring(with: match.range(at: 2))

            let image: OpenClawPlatformImage? = {
                guard let comma = dataURL.firstIndex(of: ",") else { return nil }
                let b64 = String(dataURL[dataURL.index(after: comma)...])
                guard let data = Data(base64Encoded: b64) else { return nil }
                return OpenClawPlatformImage(data: data)
            }()
            images.append(InlineImage(label: label, image: image))

            let start = cleaned.index(cleaned.startIndex, offsetBy: match.range.location)
            let end = cleaned.index(start, offsetBy: match.range.length)
            cleaned.replaceSubrange(start..<end, with: "")
        }

        return Result(cleaned: self.normalize(cleaned), images: images.reversed())
    }

    private static func stripInboundContextBlocks(_ raw: String) -> String {
        var output = raw
        for header in self.inboundContextHeaders {
            let escaped = NSRegularExpression.escapedPattern(for: header)
            let pattern = "(?ms)^" + escaped + "\\n```json\\n.*?\\n```\\n?"
            output = output.replacingOccurrences(
                of: pattern,
                with: "",
                options: .regularExpression)
        }
        return output
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
