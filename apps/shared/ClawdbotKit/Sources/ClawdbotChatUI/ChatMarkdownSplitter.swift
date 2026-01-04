import Foundation

enum ChatMarkdownSplitter {
    struct InlineImage: Identifiable {
        let id = UUID()
        let label: String
        let image: ClawdbotPlatformImage?
    }

    struct Block: Identifiable {
        enum Kind: Equatable {
            case text
            case code(language: String?)
        }

        let id = UUID()
        let kind: Kind
        let text: String
    }

    struct SplitResult {
        let blocks: [Block]
        let images: [InlineImage]
    }

    static func split(markdown raw: String) -> SplitResult {
        let extracted = self.extractInlineImages(from: raw)
        let blocks = self.splitCodeBlocks(from: extracted.cleaned)
        return SplitResult(blocks: blocks, images: extracted.images)
    }

    private static func splitCodeBlocks(from raw: String) -> [Block] {
        var blocks: [Block] = []
        var buffer: [String] = []
        var inCode = false
        var codeLang: String?
        var codeLines: [String] = []

        for line in raw.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            if line.hasPrefix("```") {
                if inCode {
                    blocks.append(Block(kind: .code(language: codeLang), text: codeLines.joined(separator: "\n")))
                    codeLines.removeAll(keepingCapacity: true)
                    inCode = false
                    codeLang = nil
                } else {
                    let text = buffer.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
                    if !text.isEmpty {
                        blocks.append(Block(kind: .text, text: text))
                    }
                    buffer.removeAll(keepingCapacity: true)
                    inCode = true
                    codeLang = line.dropFirst(3).trimmingCharacters(in: .whitespacesAndNewlines)
                    if codeLang?.isEmpty == true { codeLang = nil }
                }
                continue
            }

            if inCode {
                codeLines.append(line)
            } else {
                buffer.append(line)
            }
        }

        if inCode {
            blocks.append(Block(kind: .code(language: codeLang), text: codeLines.joined(separator: "\n")))
        } else {
            let text = buffer.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty {
                blocks.append(Block(kind: .text, text: text))
            }
        }

        return blocks.isEmpty ? [Block(kind: .text, text: raw)] : blocks
    }

    private static func extractInlineImages(from raw: String) -> (cleaned: String, images: [InlineImage]) {
        let pattern = #"!\[([^\]]*)\]\((data:image\/[^;]+;base64,[^)]+)\)"#
        guard let re = try? NSRegularExpression(pattern: pattern) else {
            return (raw, [])
        }

        let ns = raw as NSString
        let matches = re.matches(in: raw, range: NSRange(location: 0, length: ns.length))
        if matches.isEmpty { return (raw, []) }

        var images: [InlineImage] = []
        var cleaned = raw

        for match in matches.reversed() {
            guard match.numberOfRanges >= 3 else { continue }
            let label = ns.substring(with: match.range(at: 1))
            let dataURL = ns.substring(with: match.range(at: 2))

            let image: ClawdbotPlatformImage? = {
                guard let comma = dataURL.firstIndex(of: ",") else { return nil }
                let b64 = String(dataURL[dataURL.index(after: comma)...])
                guard let data = Data(base64Encoded: b64) else { return nil }
                return ClawdbotPlatformImage(data: data)
            }()
            images.append(InlineImage(label: label, image: image))

            let start = cleaned.index(cleaned.startIndex, offsetBy: match.range.location)
            let end = cleaned.index(start, offsetBy: match.range.length)
            cleaned.replaceSubrange(start..<end, with: "")
        }

        let normalized = cleaned
            .replacingOccurrences(of: "\n\n\n", with: "\n\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return (normalized, images.reversed())
    }
}
