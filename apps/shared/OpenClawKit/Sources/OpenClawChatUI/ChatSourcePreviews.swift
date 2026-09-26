import Foundation
import Markdown
import OpenClawKit

struct ChatSourcePreview: Identifiable, Hashable {
    enum ExcerptKind: Hashable {
        case search
        case page
    }

    let url: URL
    let title: String
    let domain: String
    let excerpt: String?
    let excerptKind: ExcerptKind?
    var citedURLs: [URL] = []

    var id: String {
        self.url.absoluteString
    }

    func represents(_ url: URL) -> Bool {
        guard let canonical = ChatSourcePreviewProjector.url(url.absoluteString) else { return false }
        let key = ChatSourcePreviewProjector.key(canonical)
        return ChatSourcePreviewProjector.key(self.url) == key ||
            self.citedURLs.contains { ChatSourcePreviewProjector.key($0) == key }
    }
}

/// Keeps parsed Markdown and recorded result fields for unchanged transcript rows.
/// The projection is rebuilt from canonical history, never from a neighboring turn.
struct ChatSourcePreviewProjector {
    private struct Entry {
        let message: OpenClawChatMessage
        let links: [URL]
        let results: [Result]
    }

    private struct Result {
        let callID: String?
        let name: String?
        let candidates: [Candidate]
    }

    private struct Candidate: Hashable {
        let url: URL
        let keys: [String]
        let name: String
        let title: String?
        let excerpt: String?
    }

    private struct Sources {
        var source: Candidate
        var page: Candidate?
        var search: Candidate?

        func preview(
            cached: [Candidate: RenderedCandidate],
            retained: inout [Candidate: RenderedCandidate]) -> ChatSourcePreview
        {
            func render(_ candidate: Candidate) -> RenderedCandidate {
                let value = retained[candidate] ?? cached[candidate] ?? RenderedCandidate(
                    title: ChatSourcePreviewProjector.title(candidate.title, source: candidate.name),
                    excerpt: ChatSourcePreviewProjector.excerpt(candidate.excerpt, source: candidate.name))
                retained[candidate] = value
                return value
            }
            let source = render(self.source)
            let pageExcerpt = self.page.map(render)?.excerpt
            let excerpt = pageExcerpt ?? self.search.map(render)?.excerpt
            return ChatSourcePreview(
                url: self.source.url,
                title: source.title ?? self.source.url.host ?? self.source.url.absoluteString,
                domain: self.source.url.host ?? "",
                excerpt: excerpt,
                excerptKind: excerpt.map { _ in pageExcerpt != nil ? .page : .search })
        }
    }

    private struct RenderedCandidate {
        let title: String?
        let excerpt: String?
    }

    private var entries: [UUID: Entry] = [:]
    private var renderedCandidates: [Candidate: RenderedCandidate] = [:]

    mutating func project(
        _ messages: [OpenClawChatMessage],
        context: OpenClawChatSourceContext? = nil) -> [UUID: [ChatSourcePreview]]
    {
        var retained: [UUID: Entry] = [:]
        var retainedCandidates: [Candidate: RenderedCandidate] = [:]
        var runs: [String: [Entry]] = [:]
        var previews: [UUID: [ChatSourcePreview]] = [:]
        for message in messages {
            guard let runID = ChatPayloadDecoding.trimmedNonEmptyString(message.transcriptRunID) else { continue }
            let entry: Entry = if let cached = self.entries[message.id], cached.message == message {
                cached
            } else {
                Entry(
                    message: message,
                    links: message.isCompletedReply ? Self.citations(in: message) : [],
                    results: Self.results(in: message, runID: runID))
            }
            retained[message.id] = entry
            if !entry.links.isEmpty {
                previews[message.id] = Self.previews(
                    links: entry.links,
                    entries: runs[runID] ?? [],
                    context: context,
                    cached: self.renderedCandidates,
                    retained: &retainedCandidates)
            }
            runs[runID, default: []].append(entry)
        }
        self.entries = retained
        self.renderedCandidates = retainedCandidates
        return previews
    }

    private static func previews(
        links: [URL],
        entries: [Entry],
        context: OpenClawChatSourceContext?,
        cached: [Candidate: RenderedCandidate],
        retained: inout [Candidate: RenderedCandidate]) -> [ChatSourcePreview]
    {
        var cited = Set(links.map(Self.key))
        var sources: [String: Sources] = [:]
        var redirects: [String: String] = [:]
        var callNames: [String: String] = [:]
        for entry in entries {
            let message = entry.message
            guard ["assistant", "tool", "toolresult", "tool_result"].contains(message.role.lowercased()),
                  !message.content.contains(where: {
                      ($0.isToolCall || $0.isToolResult) && ChatPayloadDecoding.trimmedNonEmptyString($0.runId).map {
                          $0 != message.transcriptRunID
                      } == true
                  })
            else { continue }
            for call in message.content where call.isToolCall {
                if let id = ChatPayloadDecoding.trimmedNonEmptyString(call.id ?? message.toolCallId),
                   let name = ChatPayloadDecoding.trimmedNonEmptyString(call.name)
                {
                    callNames[id] = name
                }
            }
            for result in entry.results {
                let envelopeName = ChatPayloadDecoding.trimmedNonEmptyString(message.toolName)
                let invocationName = result.callID.flatMap { callNames[$0] }
                guard let name = invocationName ?? envelopeName,
                      ["web_search", "web_fetch"].contains(name),
                      (result.name ?? invocationName) == name,
                      envelopeName == nil || envelopeName == name
                else { continue }
                for candidate in result.candidates where candidate.name == name &&
                    candidate.keys.contains(where: cited.contains)
                {
                    let canonical = Self.key(candidate.url)
                    var group = sources[canonical] ?? Sources(source: candidate)
                    if name == "web_fetch" {
                        group.source = candidate
                        group.page = candidate
                        group.search = group.search ?? candidate.keys.compactMap { sources[$0]?.search }.first
                        cited.insert(canonical)
                        for key in candidate.keys where key != canonical {
                            redirects[key] = canonical
                        }
                        // A later successful fetch ends the destination's previous redirect.
                        redirects.removeValue(forKey: canonical)
                    } else if group.search?.excerpt == nil {
                        group.search = candidate
                        if group.page == nil { group.source = candidate }
                    }
                    sources[canonical] = group
                }
            }
        }
        var previews: [ChatSourcePreview] = []
        for link in links {
            guard !Self.hasDedicatedCard(link, context: context) else { continue }
            var canonical = Self.key(link)
            var visited = Set<String>()
            while let next = redirects[canonical], visited.insert(canonical).inserted {
                canonical = next
            }
            guard let source = sources[canonical], !Self.hasDedicatedCard(source.source.url, context: context)
            else { continue }
            if let index = previews.firstIndex(where: { Self.key($0.url) == canonical }) {
                previews[index].citedURLs.append(link)
            } else if previews.count < 8 {
                var preview = source.preview(cached: cached, retained: &retained)
                preview.citedURLs = [link]
                previews.append(preview)
            }
        }
        return previews
    }

    private static func results(in message: OpenClawChatMessage, runID: String) -> [Result] {
        guard message.isError != true, message.stopReason != "error", message.stopReason != "aborted" else { return [] }
        if ["tool", "toolresult", "tool_result"].contains(message.role.lowercased()) {
            let text = ChatMessageVisibleText.displayText(in: message, includeThinking: false)
            guard !ChatToolActivity.resultIsError(message.isError, text: text) else { return [] }
            return [Self.result(
                callID: message.toolCallId,
                name: message.toolName,
                details: message.details,
                text: text)]
        }
        guard message.role.lowercased() == "assistant" else { return [] }
        return message.content.filter(\.isToolResult).compactMap { block in
            guard ChatPayloadDecoding.trimmedNonEmptyString(block.runId).map({ $0 == runID }) ?? true,
                  !ChatToolActivity.resultIsError(block.isError, text: block.text)
            else { return nil }
            return Self.result(
                callID: block.id ?? message.toolCallId,
                name: block.name ?? message.toolName,
                details: block.details,
                text: block.text ?? block.content?.stringValue)
        }
    }

    private static func result(callID: String?, name: String?, details: AnyCodable?, text: String?) -> Result {
        let payload: [String: AnyCodable]? = if let details {
            details.dictionaryValue
        } else if let text, text.utf16.count <= 100_000, let data = text.data(using: .utf8) {
            (try? JSONDecoder().decode(AnyCodable.self, from: data))?.dictionaryValue
        } else {
            nil
        }
        guard let payload,
              let external = payload["externalContent"]?.dictionaryValue,
              let source = external["source"]?.stringValue,
              external["untrusted"]?.boolValue == true, external["wrapped"]?.boolValue == true
        else { return Result(
            callID: ChatPayloadDecoding.trimmedNonEmptyString(callID),
            name: ChatPayloadDecoding.trimmedNonEmptyString(name),
            candidates: []) }
        var candidates: [Candidate] = []
        if source == "web_search" {
            let isResults = payload["kind"]?.stringValue == "results"
            let rows = isResults ? payload["results"] : payload["kind"]?
                .stringValue == "answer" ? payload["citations"] : nil
            candidates = (rows?.arrayValue ?? []).prefix(20).compactMap { value in
                guard let row = value.dictionaryValue, let url = Self.url(row["url"]?.stringValue) else { return nil }
                return Candidate(
                    url: url,
                    keys: [Self.key(url)],
                    name: source,
                    title: row["title"]?.stringValue,
                    excerpt: isResults ? row["snippet"]?.stringValue : nil)
            }
        } else if source == "web_fetch", let status = payload["status"]?.doubleValue,
                  status >= 200, status < 300,
                  let requested = Self.url(payload["url"]?.stringValue),
                  let final = Self.url(payload["finalUrl"]?.stringValue)
        {
            candidates = [Candidate(
                url: final,
                keys: [Self.key(requested), Self.key(final)],
                name: source,
                title: payload["title"]?.stringValue,
                excerpt: payload["text"]?.stringValue)]
        }
        return Result(
            callID: ChatPayloadDecoding.trimmedNonEmptyString(callID),
            name: ChatPayloadDecoding.trimmedNonEmptyString(name),
            candidates: candidates)
    }

    private static func citations(in message: OpenClawChatMessage) -> [URL] {
        let text = ChatMessageVisibleText.visibleText(in: message)
        guard !text.isEmpty, text.utf16.count <= 30000 else { return [] }
        return chatPreviewURLs(in: text).compactMap { Self.url($0.absoluteString) }
    }

    private static func prose(_ value: String?, source: String) -> String? {
        guard let value, value.utf16.count <= 100_000 else { return nil }
        // Only the provenance-owned frame is removed; quoted markers remain source prose.
        let pattern = #"(?:^|\n)<<<EXTERNAL_UNTRUSTED_CONTENT id="([a-f0-9]{16})">>>\r?\n"# +
            #"Source: ([^\r\n]+)\r?\n---\r?\n([\s\S]*?)\r?\n"# +
            #"<<<END_EXTERNAL_UNTRUSTED_CONTENT id="\1">>>"#
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)),
              let nameRange = Range(match.range(at: 2), in: value),
              value[nameRange] == (source == "web_search" ? "Web Search" : "Web Fetch"),
              let bodyRange = Range(match.range(at: 3), in: value)
        else { return nil }
        return String(value[bodyRange].trimmingCharacters(in: .whitespacesAndNewlines).prefix(30000))
    }

    private static func inlineText(_ markup: any Markup) -> String {
        if let text = markup as? Markdown.Text { return text.string }
        if let code = markup as? InlineCode { return code.code }
        if markup is SoftBreak || markup is LineBreak { return " " }
        if markup is Markdown.Image || markup is CodeBlock || markup is HTMLBlock || markup is InlineHTML { return "" }
        return markup.children.map(Self.inlineText).joined()
    }

    private static func cleanText(_ text: String) -> String {
        text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    private static func title(_ value: String?, source: String) -> String? {
        guard let prose = Self.prose(value, source: source) else { return nil }
        let text = Self.cleanText(Document(parsing: prose).children.map(Self.inlineText).joined(separator: " "))
        return text.isEmpty ? nil : String(text.prefix(180))
    }

    private static func excerpt(_ value: String?, source: String) -> String? {
        guard let prose = Self.prose(value, source: source) else { return nil }
        let document = Document(parsing: prose)
        func paragraphs(_ markup: any Markup) -> [String] {
            if markup is Paragraph { return [Self.cleanText(Self.inlineText(markup))] }
            return markup.children.flatMap(paragraphs)
        }
        let paragraphs = source == "web_fetch"
            ? document.children.compactMap { $0 is Paragraph ? Self.cleanText(Self.inlineText($0)) : nil }
            : paragraphs(document)
        guard let text = paragraphs.first(where: { $0.count >= (source == "web_fetch" ? 60 : 1) }) else { return nil }
        return text.count > 280 ? String(text.prefix(279)).trimmingCharacters(in: .whitespacesAndNewlines) + "…" : text
    }

    fileprivate static func url(_ value: String?) -> URL? {
        guard let value, value.utf16.count <= 2048,
              var components = URLComponents(string: value),
              let scheme = components.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil
        else { return nil }
        components.scheme = scheme
        components.host = host.lowercased()
        if components.path.isEmpty { components.path = "/" }
        if components.port == (scheme == "https" ? 443 : 80) { components.port = nil }
        return components.url
    }

    fileprivate static func key(_ url: URL) -> String {
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        components.fragment = nil
        return components.string!
    }

    private static func hasDedicatedCard(_ url: URL, context: OpenClawChatSourceContext?) -> Bool {
        if self.isGitHubItem(url) { return true }
        guard let context, [context.gatewayURL, context.publicOrigin].compactMap(\.self).contains(where: {
            $0.scheme?.lowercased() == url.scheme?.lowercased() && $0.host?.lowercased() == url.host?.lowercased() &&
                ($0.port ?? ($0.scheme == "https" ? 443 : 80)) == (url.port ?? (url.scheme == "https" ? 443 : 80))
        }) else { return false }
        let base = context.basePath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let prefix = base.isEmpty ? "" : "/" + base
        let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath ?? ""
        for namespace in ["chat", "dashboard"] {
            let route = prefix + "/" + namespace + "/"
            guard path.hasPrefix(route) else { continue }
            var suffix = String(path.dropFirst(route.count))
            if suffix.hasSuffix("/") { suffix.removeLast() }
            let segments = suffix.components(separatedBy: "/")
            guard segments.allSatisfy({ !($0.removingPercentEncoding ?? "").isEmpty }) else { return false }
            return segments.count < 2 || segments[1] != "~key" || segments.count > 2
        }
        return false
    }

    private static func isGitHubItem(_ url: URL) -> Bool {
        guard url.scheme == "https", url.host == "github.com", url.port == nil else { return false }
        let parts = url.path.split(separator: "/")
        return parts.count >= 4 && ["issues", "pull"].contains(parts[2]) &&
            parts[3].range(of: #"^[1-9][0-9]{0,9}$"#, options: .regularExpression) != nil
    }
}
