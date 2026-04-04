import Foundation
import OpenClawKit

struct CorrectionWebResearchResult: Sendable {
    let query: String
    let summary: String
    let items: [CorrectionExternalResearchItem]
}

enum CorrectionWebResearchError: LocalizedError {
    case invalidQuery
    case invalidEndpoint
    case invalidResponse
    case transportStatus(Int)
    case emptyDocument

    var errorDescription: String? {
        switch self {
        case .invalidQuery:
            "The web research query is empty."
        case .invalidEndpoint:
            "The web research endpoint could not be created."
        case .invalidResponse:
            "The web research endpoint returned an invalid response."
        case let .transportStatus(status):
            "The web research endpoint returned HTTP \(status)."
        case .emptyDocument:
            "The web research endpoint returned an empty document."
        }
    }
}

actor CorrectionWebResearchStore {
    static let shared = CorrectionWebResearchStore()

    private static let titlePatterns: [NSRegularExpression] = [
        try! NSRegularExpression(pattern: #".*?##\s+\[(.+?)\]\((https?://[^)\s]+)\)\s*(.*)$"#),
        try! NSRegularExpression(pattern: #".*?\[##\s*(.+?)\]\((https?://[^)\s]+)\)\s*(.*)$"#),
    ]

    private let logger = Logger(subsystem: "ai.openclaw", category: "correction.web-research")
    private let session: URLSession

    init(session: URLSession? = nil) {
        if let session {
            self.session = session
            return
        }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 20
        configuration.timeoutIntervalForResource = 20
        configuration.waitsForConnectivity = false
        self.session = URLSession(configuration: configuration)
    }

    func research(query rawQuery: String, limit: Int = 3) async throws -> CorrectionWebResearchResult {
        let query = Self.condenseWhitespace(rawQuery)
        guard !query.isEmpty else {
            throw CorrectionWebResearchError.invalidQuery
        }
        guard let url = Self.endpoint(query: query) else {
            throw CorrectionWebResearchError.invalidEndpoint
        }

        var request = URLRequest(url: url)
        request.timeoutInterval = 20
        request.setValue("text/plain, text/markdown;q=0.9, */*;q=0.1", forHTTPHeaderField: "Accept")

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await self.session.data(for: request)
        } catch {
            self.logger.error("web research request failed: \(error.localizedDescription, privacy: .public)")
            throw error
        }

        guard let http = response as? HTTPURLResponse else {
            throw CorrectionWebResearchError.invalidResponse
        }
        guard (200 ..< 300).contains(http.statusCode) else {
            throw CorrectionWebResearchError.transportStatus(http.statusCode)
        }

        let document = String(decoding: data, as: UTF8.self)
        let trimmedDocument = document.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedDocument.isEmpty else {
            throw CorrectionWebResearchError.emptyDocument
        }

        let items = Self.parseSearchDocument(trimmedDocument, limit: limit)
        let summary: String
        if items.isEmpty {
            summary = "No stable public web references were captured for the current symptom query."
        } else {
            summary = "Captured \(items.count) public reference(s) for the current symptom query."
        }

        return CorrectionWebResearchResult(
            query: query,
            summary: summary,
            items: items)
    }

    static func parseSearchDocument(_ document: String, limit: Int = 3) -> [CorrectionExternalResearchItem] {
        var items: [CorrectionExternalResearchItem] = []
        var seenURLs: Set<String> = []

        for rawLine in document.components(separatedBy: .newlines) {
            guard let item = self.parseSearchLine(rawLine) else { continue }
            let dedupeKey = item.url.lowercased()
            guard seenURLs.insert(dedupeKey).inserted else { continue }
            items.append(item)
            if items.count >= limit {
                break
            }
        }

        return items
    }

    private static func endpoint(query: String) -> URL? {
        var components = URLComponents(string: "https://duckduckgo.com/")
        components?.queryItems = [
            URLQueryItem(name: "q", value: query),
        ]
        guard let upstream = components?.url?.absoluteString else {
            return nil
        }
        return URL(string: "https://r.jina.ai/http://\(upstream)")
    }

    private static func parseSearchLine(_ rawLine: String) -> CorrectionExternalResearchItem? {
        let line = self.condenseWhitespace(rawLine)
        guard !line.isEmpty else { return nil }
        guard !line.localizedCaseInsensitiveContains("report ad") else { return nil }
        guard !line.contains("duckduckgo.com/y.js?") else { return nil }

        for pattern in self.titlePatterns {
            let range = NSRange(line.startIndex..<line.endIndex, in: line)
            guard let match = pattern.firstMatch(in: line, options: [], range: range),
                  match.numberOfRanges == 4,
                  let title = Range(match.range(at: 1), in: line).map({ String(line[$0]) }),
                  let urlString = Range(match.range(at: 2), in: line).map({ String(line[$0]) }),
                  let snippet = Range(match.range(at: 3), in: line).map({ String(line[$0]) })
            else {
                continue
            }

            guard let url = URL(string: urlString),
                  let host = url.host?.lowercased(),
                  !host.contains("duckduckgo.com")
            else {
                continue
            }

            let cleanedTitle = self.cleanTitle(title)
            guard !cleanedTitle.isEmpty else { continue }

            let cleanedSnippet = self.cleanSnippet(snippet)
            let source = self.cleanHost(host)

            return CorrectionExternalResearchItem(
                title: cleanedTitle,
                url: url.absoluteString,
                source: source,
                snippet: cleanedSnippet)
        }

        return nil
    }

    private static func cleanTitle(_ value: String) -> String {
        self.condenseWhitespace(
            self.stripMarkdown(from: value)
                .replacingOccurrences(of: "##", with: "")
                .trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private static func cleanSnippet(_ value: String) -> String {
        var cleaned = self.stripMarkdown(from: value)
        if let range = cleaned.range(of: "Source:", options: .caseInsensitive) {
            cleaned = String(cleaned[..<range.lowerBound])
        }
        if let range = cleaned.range(of: "Was this helpful?", options: .caseInsensitive) {
            cleaned = String(cleaned[..<range.lowerBound])
        }
        cleaned = cleaned
            .replacingOccurrences(of: "Continued in Wikipedia", with: "")
            .replacingOccurrences(of: "More", with: "")
            .trimmingCharacters(in: CharacterSet(charactersIn: "-:;,. ").union(.whitespacesAndNewlines))

        let condensed = self.condenseWhitespace(cleaned)
        guard !condensed.isEmpty else { return "" }
        if condensed.count <= 220 {
            return condensed
        }
        let cutoff = condensed.index(condensed.startIndex, offsetBy: 217)
        return String(condensed[..<cutoff]).trimmingCharacters(in: .whitespacesAndNewlines) + "..."
    }

    private static func stripMarkdown(from value: String) -> String {
        var result = value
        let linkPattern = try! NSRegularExpression(pattern: #"\[([^\]]+)\]\([^)]+\)"#)
        let imagePattern = try! NSRegularExpression(pattern: #"!\[[^\]]*\]\([^)]+\)"#)
        let fullRange = NSRange(result.startIndex..<result.endIndex, in: result)
        result = imagePattern.stringByReplacingMatches(in: result, options: [], range: fullRange, withTemplate: "")
        let linkRange = NSRange(result.startIndex..<result.endIndex, in: result)
        result = linkPattern.stringByReplacingMatches(in: result, options: [], range: linkRange, withTemplate: "$1")
        return result
    }

    private static func cleanHost(_ host: String) -> String {
        host.replacingOccurrences(of: #"^www\."#, with: "", options: .regularExpression)
    }

    private static func condenseWhitespace(_ value: String) -> String {
        value
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
