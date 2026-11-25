import Foundation
import SwiftUI

enum ChatInlineChipKind: Hashable, Sendable {
    case file
    case pullRequest
    case issue

    var systemImage: String {
        switch self {
        case .file: "doc.text"
        case .pullRequest: "arrow.triangle.pull"
        case .issue: "smallcircle.filled.circle"
        }
    }
}

/// Marks prose runs that render as a file or GitHub item chip.
enum ChatInlineChipAttribute: AttributedStringKey {
    typealias Value = ChatInlineChipKind
    static let name = "OpenClawChatInlineChip"
}

/// A file reference `ChatMarkdownInlineChips.decorate` found. The source text stays until the
/// renderer resolves it into a chip, because file links and labels depend on the whole message.
struct ChatInlineFileReference: Hashable, Sendable {
    let path: String
    let line: Int?
    /// Source text after the path, such as a `:42` line suffix.
    let suffix: String
    /// Authored Markdown link labels stay as written.
    let authoredLabel: String?
}

enum ChatInlineFileReferenceAttribute: AttributedStringKey {
    typealias Value = ChatInlineFileReference
    static let name = "OpenClawChatInlineFileReference"
}

extension EnvironmentValues {
    /// Message bodies turn file references into chips (web enables `fileLinks` only there).
    @Entry var openClawChatMarkdownFileLinks: Bool = false
    /// Shortest unique file labels for the whole message, published by its outermost renderer.
    @Entry var openClawChatMarkdownFileLabels: [String: String]?
}

extension View {
    /// Enables file chips for the Markdown inside this view: use only on message bodies.
    func chatMarkdownFileLinks() -> some View {
        self.environment(\.openClawChatMarkdownFileLinks, true)
    }
}

/// File and GitHub item references in rendered prose.
/// Ports the web detection rules so the same text becomes a chip on both clients.
enum ChatMarkdownInlineChips {
    struct FileTarget: Equatable {
        let path: String
        let line: Int?
    }

    struct GitHubItem: Equatable {
        let kind: ChatInlineChipKind
        let owner: String
        let repo: String
        let number: Int

        var url: URL {
            let path = self.kind == .pullRequest ? "pull" : "issues"
            // Owner and repo are validated to URL-safe characters by `githubItem`/`githubReferences`.
            return URL(string: "https://github.com/\(self.owner)/\(self.repo)/\(path)/\(self.number)")!
        }

        /// ui/src/components/github-link-target.ts:8-12
        var reference: String {
            "\(self.owner)/\(self.repo)#\(self.number)"
        }
    }

    static let fileURLScheme = "openclaw-file"

    // MARK: File grammar (ui/src/components/markdown-file-links.ts:3-38)

    private static let segment = #"[\p{L}\p{M}\p{N}_.@#+-]+"#
    private static let authoredSegment = #"[^/\\:?\p{Cc}]+"#
    private static let scannedExtension = "[A-Za-z][A-Za-z0-9]{0,7}"
    private static let authoredExtension = "[A-Za-z0-9]{1,8}"
    private static let lineSuffix = #":\d{1,6}(?:[-:]\d{1,6})?"#

    private struct Grammar {
        let source: String
        let exact: NSRegularExpression
        let bare: NSRegularExpression
    }

    private static func grammar(extension ext: String, segment: String) -> Grammar {
        let name = "\(segment)\\.\(ext)"
        let prefixed = #"(?:~/|\.\./|\./|/)(?:"# + segment + "/)*" + name
        // A domain-shaped root is ambiguous, not evidence of a workspace file.
        let domain = #"[\p{L}\p{M}\p{N}-]+(?:\.[\p{L}\p{M}\p{N}-]+)*\.(?:[\p{L}\p{M}]{2,}|[xX][nN]--[A-Za-z0-9-]+)"#
        let unprefixed = "(?!\(domain)/)\(segment)(?:/\(segment))*/\(name)"
        let windows = #"[A-Za-z]:[\\/](?:"# + segment + #"[\\/])*"# + name
        // A reference may not stop early inside a longer token ("logs/app.log.1").
        let end = #"(?!\.?[\p{L}\p{M}\p{N}_])"#
        let multi = "(?:\(prefixed)|\(windows)|\(unprefixed))(?:\(lineSuffix))?\(end)"
        let bareWithLine = "\(name)\(lineSuffix)\(end)"
        return Grammar(
            source: "\(multi)|\(bareWithLine)",
            exact: self.regex("^(?:\(multi)|\(bareWithLine))$"),
            bare: self.regex("^\(segment)\\.(\(self.scannedExtension))$"))
    }

    private static let scannedGrammar = Self.grammar(extension: Self.scannedExtension, segment: Self.segment)
    private static let authoredGrammar = Self.grammar(
        extension: Self.authoredExtension,
        segment: Self.authoredSegment)
    /// Start boundary: ui/src/components/markdown-link-boundary.ts:1-3.
    private static let fileScan = Self.regex(#"(?:^|(?<=[\s(\[{<"'`]))(?:"# + Self.scannedGrammar.source + ")")
    private static let lineSuffixAtEnd = Self.regex(#":(\d{1,6})(?:[-:]\d{1,6})?$"#)
    private static let explicitPathPrefix = Self.regex(#"^(?:~/|\.{1,2}/|/|[A-Za-z]:[\\/])"#)
    private static let hostLocalHref = Self.regex(
        #"^(?:~/|/(?:Users|home|tmp|private/tmp|var/folders|private/var/folders)/|/[A-Za-z]:/|[A-Za-z]:[\\/])"#)
    private static let fileReferenceMarker = CharacterSet(charactersIn: "/\\:")

    /// ui/src/components/markdown-file-links.ts:40-94
    private static let autolinkExtensions: Set<String> = [
        "astro", "bash", "c", "cc", "cfg", "cjs", "conf", "cpp", "cs", "css", "csv", "diff", "fish",
        "go", "h", "hpp", "htm", "html", "ini", "java", "js", "json", "jsonc", "jsx", "kt", "kts",
        "less", "lock", "log", "markdown", "md", "mdx", "mjs", "patch", "plist", "proto", "py", "rb",
        "rs", "scss", "sh", "sql", "svelte", "svg", "swift", "toml", "ts", "tsx", "txt", "vue", "xml",
        "yaml", "yml", "zsh",
    ]

    /// ui/src/components/markdown-file-links.ts:146-180 (`parseMarkdownFileLinkTarget`).
    static func fileTarget(_ raw: String, authored: Bool = false) -> FileTarget? {
        let target = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let grammar = authored ? self.authoredGrammar : self.scannedGrammar
        guard self.matches(grammar.exact, target) || self.isAllowlistedBareFilename(target, grammar.bare)
        else { return nil }
        let parsed = self.splitLineSuffix(target)
        // Unprefixed paths are ambiguous with repository names ("openclaw/openclaw.ai").
        if !authored,
           parsed.path.contains("/"),
           !self.matches(self.explicitPathPrefix, parsed.path),
           !self.autolinkExtensions.contains(self.fileExtension(parsed.path))
        {
            return nil
        }
        return parsed
    }

    private static func isAllowlistedBareFilename(_ raw: String, _ bare: NSRegularExpression) -> Bool {
        guard !raw.contains("/"), !raw.contains("\\"),
              let match = bare.firstMatch(in: raw, range: NSRange(raw.startIndex..., in: raw)),
              let range = Range(match.range(at: 1), in: raw)
        else { return false }
        return self.autolinkExtensions.contains(raw[range].lowercased())
    }

    private static func splitLineSuffix(_ raw: String) -> FileTarget {
        guard let match = self.lineSuffixAtEnd.firstMatch(in: raw, range: NSRange(raw.startIndex..., in: raw)),
              let whole = Range(match.range, in: raw),
              let lineRange = Range(match.range(at: 1), in: raw)
        else { return FileTarget(path: raw, line: nil) }
        return FileTarget(path: String(raw[..<whole.lowerBound]), line: Int(raw[lineRange]))
    }

    private static func fileExtension(_ path: String) -> String {
        guard let dot = path.lastIndex(of: ".") else { return path.lowercased() }
        return path[path.index(after: dot)...].lowercased()
    }

    static func fileURL(for target: FileTarget) -> URL? {
        var components = URLComponents()
        components.scheme = self.fileURLScheme
        components.queryItems = [URLQueryItem(name: "path", value: target.path)] +
            (target.line.map { [URLQueryItem(name: "line", value: String($0))] } ?? [])
        return components.url
    }

    static func fileTarget(from url: URL) -> FileTarget? {
        guard url.scheme == self.fileURLScheme,
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              let path = items.first(where: { $0.name == "path" })?.value, !path.isEmpty
        else { return nil }
        return FileTarget(path: path, line: items.first { $0.name == "line" }?.value.flatMap { Int($0) })
    }

    /// ui/src/components/file-kind.ts:98-133: colliding basenames keep enough trailing segments to stay distinct.
    static func shortestFileLabels(_ paths: [String]) -> [String: String] {
        let segmentsByPath = Set(paths).map { path in
            (path, path.split(omittingEmptySubsequences: false) { $0 == "/" || $0 == "\\" }.map(String.init))
        }
        var suffixCounts: [[String]: Int] = [:]
        for (_, segments) in segmentsByPath {
            for depth in 1...max(segments.count, 1) {
                suffixCounts[Array(segments.suffix(depth)), default: 0] += 1
            }
        }
        var labels: [String: String] = [:]
        for (path, segments) in segmentsByPath {
            let depth = (1...max(segments.count, 1)).first {
                suffixCounts[Array(segments.suffix($0))] == 1
            } ?? segments.count
            labels[path] = segments.suffix(depth).joined(separator: path.contains("\\") ? "\\" : "/")
        }
        return labels
    }

    // MARK: GitHub items

    private static let githubItemPath = Self.regex(
        #"^/([^/]+)/([^/]+)/(?:issues/([1-9]\d{0,9})|pull/([1-9]\d{0,9})"# +
            #"(?:/(?:files|checks|commits(?:/[a-fA-F\d]{7,40})?))?)/?$"#)
    private static let githubOwner = Self.regex(#"^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$"#, caseInsensitive: true)
    private static let githubRepo = Self.regex(#"^[a-z\d._-]{1,100}$"#, caseInsensitive: true)
    private static let githubRepoReserved = Self.regex(#"^\.{1,2}$|\.(?:git|atom)$"#, caseInsensitive: true)
    private static let githubHosts: Set<String> = ["github.com", "www.github.com", "github.com.", "www.github.com."]

    /// ui/src/components/github-link-eligibility.ts:8-24,42-55.
    static func githubItem(_ url: URL) -> GitHubItem? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = components.host?.lowercased(), self.githubHosts.contains(host)
        else { return nil }
        let path = components.percentEncodedPath
        guard let match = self.githubItemPath.firstMatch(in: path, range: NSRange(path.startIndex..., in: path)),
              let ownerRange = Range(match.range(at: 1), in: path),
              let repoRange = Range(match.range(at: 2), in: path),
              let owner = String(path[ownerRange]).removingPercentEncoding,
              let repo = String(path[repoRange]).removingPercentEncoding,
              self.matches(self.githubOwner, owner),
              self.matches(self.githubRepo, repo),
              !self.matches(self.githubRepoReserved, repo)
        else { return nil }
        guard let numberRange = Range(match.range(at: 3), in: path) ?? Range(match.range(at: 4), in: path),
              let number = Int(path[numberRange])
        else { return nil }
        let kind: ChatInlineChipKind = match.range(at: 3).location != NSNotFound ? .issue : .pullRequest
        return GitHubItem(kind: kind, owner: owner, repo: repo, number: number)
    }

    /// ui/src/components/markdown-github-refs.ts:9-11
    private static let githubRef = Self.regex(
        #"(?<![A-Za-z0-9_.-])(?:([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+))?#([1-9]\d{0,9})(?!\w|[.-]\w)"#)
    private static let githubKeyword = Self.regex(
        #"(PR|pull request|pull|issue|fixes|closes|resolves)\s+$"#,
        caseInsensitive: true)
    private static let qualifiedRepositorySuffix = Self.regex(
        #"(?:^|[\s(\[{"'])([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)$"#)
    private static let continuesIntoWord = Self.regex(#"^[.-]\w"#)

    /// ui/src/components/markdown-github-refs.ts:13-23
    private static func qualifiedRepository(_ prefix: String) -> (owner: String, repo: String, length: Int)? {
        let ns = prefix as NSString
        guard let match = self.qualifiedRepositorySuffix.firstMatch(
            in: prefix,
            range: NSRange(location: 0, length: ns.length))
        else { return nil }
        let owner = ns.substring(with: match.range(at: 1))
        let repo = ns.substring(with: match.range(at: 2))
        guard ![owner, repo].contains(where: { $0 == "." || $0 == ".." }) else { return nil }
        return (owner, repo, (owner as NSString).length + (repo as NSString).length + 1)
    }

    /// Repository-qualified item references in one prose run (UTF-16 ranges).
    /// Ports ui/src/components/markdown-github-refs.ts:62-130; unqualified refs stay plain text there too.
    static func githubReferences(in content: String) -> [(range: NSRange, item: GitHubItem)] {
        let ns = content as NSString
        var scannedTo = 0
        var results: [(range: NSRange, item: GitHubItem)] = []
        for match in self.githubRef.matches(in: content, range: NSRange(location: 0, length: ns.length)) {
            guard match.range(at: 2).location != NSNotFound,
                  let number = Int(ns.substring(with: match.range(at: 2)))
            else { continue }
            let start = match.range.location
            let end = NSMaxRange(match.range)
            let qualifier = match.range(at: 1).location == NSNotFound ? nil : ns.substring(with: match.range(at: 1))
            let preceding = ns.substring(with: NSRange(location: scannedTo, length: max(0, start - scannedTo)))
            let direct = self.qualifiedRepository(qualifier ?? preceding)
            if qualifier != nil, direct == nil { continue }
            let keywordEnd = if let direct, qualifier == nil {
                start - direct.length
            } else {
                start
            }
            let keywordSource = ns.substring(with: NSRange(location: scannedTo, length: max(0, keywordEnd - scannedTo)))
            let keywordMatch = self.githubKeyword.firstMatch(
                in: keywordSource,
                range: NSRange(location: 0, length: (keywordSource as NSString).length))
            // A prior number cannot be part of the next adjacent keyword.
            scannedTo = end
            let keywordLength = keywordMatch?.range.length ?? 0
            let keyword = keywordMatch != nil &&
                self.hasLinkBoundaries(ns, start: keywordEnd - keywordLength, end: end)
            guard keyword || direct != nil || match.range(at: 2).length >= 4,
                  self.hasLinkBoundaries(ns, start: keywordEnd, end: end),
                  !self.matches(self.continuesIntoWord, ns.substring(from: end))
            else { continue }
            let repository: (owner: String, repo: String)? = if let direct {
                (direct.owner, direct.repo)
            } else if keyword {
                self.qualifiedRepository(String(preceding.dropLast(keywordLength))
                    .replacingOccurrences(of: #"\s+$"#, with: "", options: .regularExpression))
                    .map { ($0.owner, $0.repo) }
            } else {
                nil
            }
            guard let repository else { continue }
            // Every pull keyword (PR, pull, pull request) starts with "p"; the rest name issues.
            let keywordText = keywordMatch.map { (keywordSource as NSString).substring(with: $0.range(at: 1)) }
            let kind: ChatInlineChipKind = keyword && keywordText?.lowercased().hasPrefix("p") == true
                ? .pullRequest : .issue
            results.append((
                match.range,
                GitHubItem(kind: kind, owner: repository.owner, repo: repository.repo, number: number)))
        }
        return results
    }

    /// ui/src/components/markdown-link-boundary.ts:5-12
    private static func hasLinkBoundaries(_ value: NSString, start: Int, end: Int) -> Bool {
        if start > 0 {
            let before = value.substring(with: NSRange(location: start - 1, length: 1))
            guard self.isWhitespace(before) || "([{<\"'`".contains(before) else { return false }
        }
        guard end < value.length else { return true }
        let after = value.substring(with: NSRange(location: end, length: 1))
        return self.isWhitespace(after) || ".,;:!?)]}>\"'".contains(after)
    }

    private static func isWhitespace(_ character: String) -> Bool {
        character.unicodeScalars.allSatisfy(CharacterSet.whitespacesAndNewlines.contains)
    }

    // MARK: Decoration

    private enum Mark {
        case github(kind: ChatInlineChipKind, url: URL, label: String)
        case file(ChatInlineFileReference)
    }

    private struct Chip {
        let range: Range<AttributedString.Index>
        let mark: Mark
    }

    private nonisolated(unsafe) static let linkDetector = try? NSDataDetector(
        types: NSTextCheckingResult.CheckingType.link.rawValue)

    /// Turns GitHub item references into chips and marks file references in rendered prose.
    /// File references keep their source text: they become chips only where the renderer enables
    /// file links, labelled across the whole message (`resolvingFiles`).
    static func decorate(_ source: AttributedString, isHeading: Bool = false) -> AttributedString {
        var chips: [Chip] = []

        // Authored links: markdown-parser.ts:282-335 (file hrefs) and 459-498 (GitHub item chips).
        for (link, range) in source.runs[\.link] {
            guard let link else { continue }
            let label = String(source[range].characters)
            if let item = self.githubItem(link) {
                let generated = label == link.absoluteString
                let runs = source[range].runs
                let plainLabel = runs.count == 1 && !self.isCode(runs.first?.inlinePresentationIntent)
                guard generated || (plainLabel && (label == "#\(item.number)" || label == item.reference))
                else { continue }
                chips.append(Chip(range: range, mark: .github(kind: item.kind, url: link, label: item.reference)))
            } else if link.scheme == nil {
                let href = link.relativeString.removingPercentEncoding ?? link.relativeString
                let target = self.fileTarget(href, authored: true) ??
                    (self.matches(self.hostLocalHref, href) ? self.splitLineSuffix(href) : nil)
                guard let target else { continue }
                // Authored labels stay as written.
                chips.append(Chip(range: range, mark: .file(ChatInlineFileReference(
                    path: target.path,
                    line: target.line,
                    suffix: "",
                    authoredLabel: label))))
            }
        }

        var segmentStart: AttributedString.Index?
        func flushSegment(upTo end: AttributedString.Index) {
            guard let start = segmentStart else { return }
            segmentStart = nil
            chips += self.textChips(in: source, range: start..<end, isHeading: isHeading)
        }
        // Emphasis is transparent to references; links, code and line breaks are not.
        for run in source.runs {
            if run.link != nil {
                flushSegment(upTo: run.range.lowerBound)
            } else if self.isCode(run.inlinePresentationIntent) {
                flushSegment(upTo: run.range.lowerBound)
                if let chip = self.codeChip(in: source, range: run.range) {
                    chips.append(chip)
                }
            } else if segmentStart == nil {
                segmentStart = run.range.lowerBound
            }
        }
        flushSegment(upTo: source.endIndex)

        guard !chips.isEmpty else { return source }
        chips.sort { $0.range.lowerBound < $1.range.lowerBound }

        var output = AttributedString()
        var cursor = source.startIndex
        for chip in chips where chip.range.lowerBound >= cursor {
            output.append(source[cursor..<chip.range.lowerBound])
            switch chip.mark {
            case let .github(kind, url, label):
                var piece = AttributedString(label)
                if let attributes = source[chip.range].runs.first?.attributes {
                    piece.mergeAttributes(attributes)
                }
                piece.inlinePresentationIntent = nil
                piece.link = url
                piece[ChatInlineChipAttribute.self] = kind
                output.append(piece)
            case let .file(reference):
                var piece = AttributedString(source[chip.range])
                piece[ChatInlineFileReferenceAttribute.self] = reference
                output.append(piece)
            }
            cursor = chip.range.upperBound
        }
        output.append(source[cursor...])
        return output
    }

    /// Paths of the file references `decorate` marked, in order.
    static func filePaths(in attributed: AttributedString) -> [String] {
        attributed.runs[ChatInlineFileReferenceAttribute.self].compactMap { reference, _ in reference?.path }
    }

    /// Cheap pre-check before parsing nested Markdown just to collect its file references:
    /// every file form needs a separator, a line suffix, a code span or a link destination.
    static func mayContainFileReference(_ markdown: String) -> Bool {
        markdown.contains { $0 == "/" || $0 == "\\" || $0 == ":" || $0 == "`" || $0 == "(" }
    }

    /// Inline-only Markdown (table cells) parsed and decorated like prose.
    static func inlineMarkdown(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible)
        return self.decorate((try? AttributedString(markdown: text, options: options)) ?? AttributedString(text))
    }

    /// Turns marked file references into file chips. `labels` holds the message's shortest unique
    /// path suffixes (markdown-parser.ts:378-385); line suffixes stay on the shortened label.
    static func resolvingFiles(in source: AttributedString, labels: [String: String]) -> AttributedString {
        var output = AttributedString()
        var changed = false
        for (reference, range) in source.runs[ChatInlineFileReferenceAttribute.self] {
            guard let reference,
                  let url = self.fileURL(for: FileTarget(path: reference.path, line: reference.line))
            else {
                output.append(source[range])
                continue
            }
            changed = true
            var piece = AttributedString(
                reference.authoredLabel ?? (labels[reference.path] ?? reference.path) + reference.suffix)
            if let attributes = source[range].runs.first?.attributes {
                piece.mergeAttributes(attributes)
            }
            // Paths read as code; GitHub items read as prose.
            piece.inlinePresentationIntent = .code
            piece.link = url
            piece[ChatInlineChipAttribute.self] = .file
            output.append(piece)
        }
        return changed ? output : source
    }

    private static func isCode(_ intent: InlinePresentationIntent?) -> Bool {
        intent?.contains(.code) == true
    }

    private static func fileReference(_ target: FileTarget, reference: String) -> ChatInlineFileReference {
        ChatInlineFileReference(
            path: target.path,
            line: target.line,
            suffix: String(reference.dropFirst(target.path.count)),
            authoredLabel: nil)
    }

    /// Code spans: whole-span file targets (markdown-parser.ts:353-360) and GitHub item URLs (440-452).
    private static func codeChip(in source: AttributedString, range: Range<AttributedString.Index>) -> Chip? {
        let content = String(source[range].characters)
        if !content.contains(where: \.isWhitespace),
           let url = URL(string: content), let item = self.githubItem(url)
        {
            return Chip(range: range, mark: .github(kind: item.kind, url: url, label: item.reference))
        }
        guard let target = self.fileTarget(content) else { return nil }
        let reference = content.trimmingCharacters(in: .whitespacesAndNewlines)
        return Chip(range: range, mark: .file(self.fileReference(target, reference: reference)))
    }

    private static func textChips(
        in source: AttributedString,
        range: Range<AttributedString.Index>,
        isHeading: Bool) -> [Chip]
    {
        let content = String(source[range].characters)
        let ns = content as NSString
        let whole = NSRange(location: 0, length: ns.length)
        var found: [(range: NSRange, mark: Mark)] = []
        func overlaps(_ candidate: NSRange) -> Bool {
            found.contains { NSIntersectionRange($0.range, candidate).length > 0 }
        }

        // Bare GitHub item URLs are linkified, then chipped with the item reference (markdown-parser.ts:459-490).
        // The chip opens the URL as written, keeping subviews such as /files or #issuecomment anchors.
        if content.contains("github.com") {
            for match in self.linkDetector?.matches(in: content, range: whole) ?? [] {
                guard let url = match.url, let item = self.githubItem(url) else { continue }
                found.append((match.range, .github(kind: item.kind, url: url, label: item.reference)))
            }
        }
        // Headings never carry item references (markdown-github-refs.ts:28-37).
        if !isHeading, content.contains("#") {
            for reference in self.githubReferences(in: content) where !overlaps(reference.range) {
                let item = reference.item
                found.append((reference.range, .github(kind: item.kind, url: item.url, label: item.reference)))
            }
        }
        // Prose references need a path separator or a bare filename's :line suffix (markdown-parser.ts:49,362-385).
        if content.rangeOfCharacter(from: self.fileReferenceMarker) != nil {
            for match in self.fileScan.matches(in: content, range: whole) where !overlaps(match.range) {
                guard self.hasLinkBoundaries(ns, start: match.range.location, end: NSMaxRange(match.range)) else {
                    continue
                }
                let matched = ns.substring(with: match.range)
                guard let target = self.fileTarget(matched) else { continue }
                found.append((match.range, .file(self.fileReference(target, reference: matched))))
            }
        }

        return found.compactMap { match in
            guard let stringRange = Range(match.range, in: content) else { return nil }
            let lower = content.distance(from: content.startIndex, to: stringRange.lowerBound)
            let length = content.distance(from: stringRange.lowerBound, to: stringRange.upperBound)
            let start = source.characters.index(range.lowerBound, offsetBy: lower)
            let end = source.characters.index(start, offsetBy: length)
            return Chip(range: start..<end, mark: match.mark)
        }
    }

    // MARK: Rendering

    /// Text with a tinted symbol before each chip label. SwiftUI Text cannot host capsule views
    /// inline without losing wrapping and selection, so the symbol and link tint carry the chip.
    /// `fileLabels` is nil where file links are off; marked file references then stay plain text.
    static func text(_ attributed: AttributedString, fileLabels: [String: String]?) -> SwiftUI.Text {
        let attributed = fileLabels.map { self.resolvingFiles(in: attributed, labels: $0) } ?? attributed
        var text = SwiftUI.Text(verbatim: "")
        var hasChip = false
        for (kind, range) in attributed.runs[ChatInlineChipAttribute.self] {
            let slice = SwiftUI.Text(AttributedString(attributed[range]))
            guard let kind else {
                // swiftlint:disable:next shorthand_operator
                text = text + slice // SwiftUI.Text concatenates with + only; it has no +=.
                continue
            }
            hasChip = true
            text = text
                + SwiftUI.Text(Image(systemName: kind.systemImage)).foregroundStyle(.tint)
                + SwiftUI.Text(verbatim: "\u{2009}")
                + slice
        }
        return hasChip ? text : SwiftUI.Text(attributed)
    }

    // MARK: Regex helpers

    private static func regex(_ pattern: String, caseInsensitive: Bool = false) -> NSRegularExpression {
        // Patterns are constants; a compile failure is a programming error caught by the tests.
        // swiftlint:disable:next force_try
        try! NSRegularExpression(pattern: pattern, options: caseInsensitive ? [.caseInsensitive] : [])
    }

    private static func matches(_ regex: NSRegularExpression, _ value: String) -> Bool {
        regex.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil
    }
}
