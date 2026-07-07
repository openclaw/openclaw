import Darwin
import Foundation
import Markdown
import SwiftUI

let chatLinkPreviewTitleMaxCharacters = 120
let chatLinkPreviewDescriptionMaxCharacters = 200
let chatLinkPreviewBodyMaxBytes = 512 * 1024
private let chatLinkPreviewMaxRedirects = 3
private let chatLinkPreviewTimeout: TimeInterval = 6
private let chatLinkPreviewCacheEntries = 64
private let chatLinkPreviewAccept = "text/html"

struct ChatLinkPreviewMetadata: Equatable {
    let url: URL
    let title: String?
    let description: String?
    let imageURL: URL?
}

enum ChatLinkPreviewResult: Equatable {
    case loaded(ChatLinkPreviewMetadata)
    case failed
}

/// Returns the first HTTP(S) link outside inline and block code.
func chatFirstPreviewURL(in markdown: String) -> URL? {
    chatFirstPreviewURL(in: Document(parsing: markdown))
}

private func chatFirstPreviewURL(in markup: any Markup) -> URL? {
    if markup is InlineCode || markup is CodeBlock {
        return nil
    }
    if let link = markup as? Markdown.Link {
        return link.destination.flatMap(chatSafeWebURL)
    }
    if let text = markup as? Markdown.Text,
       let bareURL = chatFirstBareWebURL(in: text.string)
    {
        return bareURL
    }
    for child in markup.children {
        if let url = chatFirstPreviewURL(in: child) {
            return url
        }
    }
    return nil
}

private func chatFirstBareWebURL(in text: String) -> URL? {
    let pattern = #"(?i)https?://[^\s<>\"`]+"#
    guard let match = text.range(of: pattern, options: .regularExpression) else { return nil }
    var candidate = String(text[match])
    while let last = candidate.last, ".,;:!?".contains(last) {
        candidate.removeLast()
    }
    for pair: (open: Character, close: Character) in [("(", ")"), ("[", "]"), ("{", "}")] {
        while candidate.hasSuffix(String(pair.close)),
              candidate.count(of: pair.close) > candidate.count(of: pair.open)
        {
            candidate.removeLast()
        }
    }
    return chatSafeWebURL(candidate)
}

extension String {
    fileprivate func count(of character: Character) -> Int {
        self.reduce(into: 0) { count, current in
            if current == character { count += 1 }
        }
    }
}

private func chatSafeWebURL(_ value: String) -> URL? {
    guard let url = URL(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
          let scheme = url.scheme?.lowercased(),
          scheme == "http" || scheme == "https",
          url.host != nil
    else { return nil }
    return url
}

func parseChatOpenGraph(html: String, baseURL: URL) -> ChatLinkPreviewResult {
    var title: String?
    var description: String?
    var image: String?

    for tag in chatHTMLTags(named: "meta", in: html) {
        let attributes = chatHTMLAttributes(in: tag)
        let property = (attributes["property"] ?? attributes["name"])?.lowercased()
        guard let content = attributes["content"] else { continue }
        switch property {
        case "og:title" where title == nil:
            title = content
        case "og:description" where description == nil:
            description = content
        case "og:image" where image == nil, "og:image:url" where image == nil:
            image = content
        default:
            break
        }
    }

    let parsedTitle = chatSanitizeMetadataText(
        title ?? chatHTMLTitle(in: html),
        maxCharacters: chatLinkPreviewTitleMaxCharacters)
    let parsedDescription = chatSanitizeMetadataText(
        description,
        maxCharacters: chatLinkPreviewDescriptionMaxCharacters)
    let imageURL = image.flatMap { value -> URL? in
        let decoded = chatDecodeHTMLEntities(value).trimmingCharacters(in: .whitespacesAndNewlines)
        guard let resolved = URL(string: decoded, relativeTo: baseURL)?.absoluteURL,
              chatSafeWebURL(resolved.absoluteString) != nil
        else { return nil }
        return resolved
    }
    guard parsedTitle != nil || parsedDescription != nil || imageURL != nil else {
        return .failed
    }
    return .loaded(ChatLinkPreviewMetadata(
        url: baseURL,
        title: parsedTitle,
        description: parsedDescription,
        imageURL: imageURL))
}

private func chatHTMLTags(named name: String, in html: String) -> [String] {
    var tags: [String] = []
    var searchStart = html.startIndex
    let prefix = "<\(name)"
    while searchStart < html.endIndex,
          let start = html.range(
              of: prefix,
              options: [.caseInsensitive],
              range: searchStart..<html.endIndex)?.lowerBound
    {
        let boundaryIndex = html.index(start, offsetBy: prefix.count, limitedBy: html.endIndex)
        if let boundaryIndex,
           boundaryIndex < html.endIndex,
           !html[boundaryIndex].isWhitespace,
           html[boundaryIndex] != "/",
           html[boundaryIndex] != ">"
        {
            searchStart = html.index(after: start)
            continue
        }
        guard let end = chatHTMLTagEnd(in: html, after: boundaryIndex ?? html.endIndex) else { break }
        tags.append(String(html[start...end]))
        searchStart = html.index(after: end)
    }
    return tags
}

private func chatHTMLTagEnd(in html: String, after start: String.Index) -> String.Index? {
    var quote: Character?
    var index = start
    while index < html.endIndex {
        let character = html[index]
        if quote == nil, character == "\"" || character == "'" {
            quote = character
        } else if character == quote {
            quote = nil
        } else if character == ">", quote == nil {
            return index
        }
        index = html.index(after: index)
    }
    return nil
}

private func chatHTMLAttributes(in tag: String) -> [String: String] {
    let pattern = #"([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\s>]+))"#
    guard let expression = try? NSRegularExpression(pattern: pattern) else { return [:] }
    let range = NSRange(tag.startIndex..<tag.endIndex, in: tag)
    var attributes: [String: String] = [:]
    for match in expression.matches(in: tag, range: range) {
        guard let nameRange = Range(match.range(at: 1), in: tag) else { continue }
        let valueRange = (2...4).lazy
            .map { match.range(at: $0) }
            .first { $0.location != NSNotFound }
            .flatMap { Range($0, in: tag) }
        guard let valueRange else { continue }
        let name = String(tag[nameRange]).lowercased()
        if attributes[name] == nil {
            attributes[name] = String(tag[valueRange])
        }
    }
    return attributes
}

private func chatHTMLTitle(in html: String) -> String? {
    let pattern = #"(?is)<title(?:\s[^>]*)?>(.*?)</title\s*>"#
    guard let expression = try? NSRegularExpression(pattern: pattern),
          let match = expression.firstMatch(
              in: html,
              range: NSRange(html.startIndex..<html.endIndex, in: html)),
          let range = Range(match.range(at: 1), in: html)
    else { return nil }
    return String(html[range])
}

private func chatSanitizeMetadataText(_ value: String?, maxCharacters: Int) -> String? {
    guard let value else { return nil }
    let withoutControls = chatDecodeHTMLEntities(value).unicodeScalars.filter {
        !CharacterSet.controlCharacters.contains($0)
    }
    let collapsed = String(String.UnicodeScalarView(withoutControls))
        .split(whereSeparator: \.isWhitespace)
        .joined(separator: " ")
    return collapsed.isEmpty ? nil : String(collapsed.prefix(maxCharacters))
}

private func chatDecodeHTMLEntities(_ value: String) -> String {
    let pattern = #"&#(x[0-9a-fA-F]+|[0-9]+);?|&(amp|lt|gt|quot|apos|nbsp);"#
    guard let expression = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive) else {
        return value
    }
    var decoded = value
    let matches = expression.matches(
        in: value,
        range: NSRange(value.startIndex..<value.endIndex, in: value))
    for match in matches.reversed() {
        guard let fullRange = Range(match.range, in: decoded) else { continue }
        let numeric = Range(match.range(at: 1), in: value).map { String(value[$0]) }
        let named = Range(match.range(at: 2), in: value).map { String(value[$0]).lowercased() }
        let replacement: String
        if let numeric {
            let isHex = numeric.lowercased().hasPrefix("x")
            let digits = isHex ? String(numeric.dropFirst()) : numeric
            replacement = Int(digits, radix: isHex ? 16 : 10)
                .flatMap(UnicodeScalar.init)
                .map(String.init) ?? String(decoded[fullRange])
        } else {
            replacement = switch named {
            case "amp": "&"
            case "lt": "<"
            case "gt": ">"
            case "quot": "\""
            case "apos": "'"
            case "nbsp": " "
            default: String(decoded[fullRange])
            }
        }
        decoded.replaceSubrange(fullRange, with: replacement)
    }
    return decoded
}

func chatLinkPreviewAllowsHost(_ url: URL) -> Bool {
    guard chatSafeWebURL(url.absoluteString) != nil,
          var rawHost = url.host?.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: ".")),
          rawHost != "localhost",
          !rawHost.hasSuffix(".localhost"),
          !rawHost.hasSuffix(".local"),
          !rawHost.contains("%")
    else { return false }
    if rawHost.hasPrefix("["), rawHost.hasSuffix("]") {
        rawHost.removeFirst()
        rawHost.removeLast()
    }
    guard let address = chatParsedIPAddress(rawHost) else { return true }
    return chatLinkPreviewAllowsAddress(address)
}

private enum ChatIPAddress {
    case v4([UInt8])
    case v6([UInt8])
}

private func chatParsedIPAddress(_ host: String) -> ChatIPAddress? {
    var ipv4 = in_addr()
    if host.withCString({ inet_aton($0, &ipv4) }) == 1 {
        return .v4(withUnsafeBytes(of: &ipv4) { Array($0) })
    }
    var ipv6 = in6_addr()
    if host.withCString({ inet_pton(AF_INET6, $0, &ipv6) }) == 1 {
        return .v6(withUnsafeBytes(of: &ipv6) { Array($0) })
    }
    return nil
}

private func chatLinkPreviewAllowsAddress(_ address: ChatIPAddress) -> Bool {
    switch address {
    case let .v4(bytes):
        guard bytes.count == 4 else { return false }
        let first = Int(bytes[0])
        let second = Int(bytes[1])
        let third = Int(bytes[2])
        return !(first == 0
            || first == 10
            || (first == 100 && (64...127).contains(second))
            || first == 127
            || (first == 169 && second == 254)
            || (first == 172 && (16...31).contains(second))
            || (first == 192 && second == 0 && (third == 0 || third == 2))
            || (first == 192 && second == 88 && third == 99)
            || (first == 192 && second == 168)
            || (first == 198 && (18...19).contains(second))
            || (first == 198 && second == 51 && third == 100)
            || (first == 203 && second == 0 && third == 113)
            || first >= 224)
    case let .v6(bytes):
        guard bytes.count == 16 else { return false }
        let globalUnicast = bytes[0] & 0xE0 == 0x20
        let special2001 = bytes.hasPrefix([0x20, 0x01, 0x00])
        let orchid = special2001 && (bytes[3] & 0xF0 == 0x10 || bytes[3] & 0xF0 == 0x20)
        return globalUnicast
            && !bytes.hasPrefix([0x20, 0x01, 0x00, 0x00])
            && !bytes.hasPrefix([0x20, 0x01, 0x00, 0x02])
            && !orchid
            && !bytes.hasPrefix([0x20, 0x01, 0x0D, 0xB8])
            && !bytes.hasPrefix([0x20, 0x02])
            && !(bytes.hasPrefix([0x3F, 0xFF]) && bytes[2] & 0xF0 == 0)
    }
}

private func chatLinkPreviewAllowsRemoteAddress(_ address: String) -> Bool {
    guard let parsed = chatParsedIPAddress(address) else { return false }
    return chatLinkPreviewAllowsAddress(parsed)
}

extension [UInt8] {
    fileprivate func hasPrefix(_ prefix: [UInt8]) -> Bool {
        self.count >= prefix.count && self.indices.prefix(prefix.count).allSatisfy { self[$0] == prefix[$0] }
    }
}

func chatLinkPreviewRedirectURL(
    response: HTTPURLResponse,
    request: URLRequest,
    redirectCount: Int,
    hostPolicy: (URL) -> Bool = chatLinkPreviewAllowsHost) -> URL?
{
    guard redirectCount < chatLinkPreviewMaxRedirects,
          let url = request.url,
          chatSafeWebURL(url.absoluteString) != nil,
          hostPolicy(url)
    else { return nil }
    return url
}

struct ChatLinkPreviewBodyAccumulator {
    private(set) var data = Data()

    mutating func append(_ chunk: Data) -> Bool {
        let remaining = chatLinkPreviewBodyMaxBytes - self.data.count
        guard remaining > 0 else { return true }
        self.data.append(chunk.prefix(remaining))
        return chunk.count >= remaining
    }
}

final class ChatLinkPreviewFetcher: @unchecked Sendable {
    typealias HostPolicy = @Sendable (URL) -> Bool
    typealias ConnectionPolicy = @Sendable ([String?]) -> Bool

    private let configuration: URLSessionConfiguration
    private let timeout: TimeInterval
    private let hostPolicy: HostPolicy
    private let connectionPolicy: ConnectionPolicy

    init(
        configuration: URLSessionConfiguration = .chatLinkPreview,
        timeout: TimeInterval = chatLinkPreviewTimeout,
        hostPolicy: @escaping HostPolicy = chatLinkPreviewAllowsHost,
        connectionPolicy: @escaping ConnectionPolicy = ChatLinkPreviewFetcher.publicConnectionsOnly)
    {
        self.configuration = configuration
        self.timeout = timeout
        self.hostPolicy = hostPolicy
        self.connectionPolicy = connectionPolicy
    }

    func fetch(_ originalURL: URL) async -> ChatLinkPreviewResult {
        guard chatSafeWebURL(originalURL.absoluteString) != nil, self.hostPolicy(originalURL) else {
            return .failed
        }
        let delegate = ChatLinkPreviewSessionDelegate(
            hostPolicy: self.hostPolicy,
            connectionPolicy: self.connectionPolicy)
        let session = URLSession(configuration: self.configuration, delegate: delegate, delegateQueue: nil)
        var request = URLRequest(url: originalURL, timeoutInterval: self.timeout)
        request.httpMethod = "GET"
        request.setValue(chatLinkPreviewAccept, forHTTPHeaderField: "Accept")
        request.httpShouldHandleCookies = false
        let task = session.dataTask(with: request)
        let deadline = Task {
            try? await Task.sleep(for: .seconds(self.timeout))
            guard !Task.isCancelled else { return }
            delegate.abort(task)
        }
        let response = await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                delegate.start(continuation)
                task.resume()
            }
        } onCancel: {
            delegate.abort(task)
        }
        deadline.cancel()
        session.finishTasksAndInvalidate()

        guard
            let response,
            let html = String(bytes: response.data, encoding: .utf8)
        else { return .failed }
        return switch parseChatOpenGraph(html: html, baseURL: response.url) {
        case let .loaded(metadata):
            .loaded(ChatLinkPreviewMetadata(
                url: originalURL,
                title: metadata.title,
                description: metadata.description,
                imageURL: metadata.imageURL))
        case .failed:
            .failed
        }
    }

    private static func publicConnectionsOnly(_ addresses: [String?]) -> Bool {
        !addresses.isEmpty && addresses.allSatisfy { address in
            address.map(chatLinkPreviewAllowsRemoteAddress) == true
        }
    }
}

extension URLSessionConfiguration {
    fileprivate static var chatLinkPreview: URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        configuration.timeoutIntervalForRequest = chatLinkPreviewTimeout
        configuration.timeoutIntervalForResource = chatLinkPreviewTimeout
        configuration.connectionProxyDictionary = [:]
        return configuration
    }
}

private struct ChatLinkPreviewResponse {
    let url: URL
    let data: Data
}

private final class ChatLinkPreviewSessionDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private let hostPolicy: ChatLinkPreviewFetcher.HostPolicy
    private let connectionPolicy: ChatLinkPreviewFetcher.ConnectionPolicy
    private var continuation: CheckedContinuation<ChatLinkPreviewResponse?, Never>?
    private var responseURL: URL?
    private var body = ChatLinkPreviewBodyAccumulator()
    private var redirectCount = 0
    private var remoteAddresses: [String?] = []
    private var bodyCapped = false
    private var failed = false
    private var completed = false

    init(
        hostPolicy: @escaping ChatLinkPreviewFetcher.HostPolicy,
        connectionPolicy: @escaping ChatLinkPreviewFetcher.ConnectionPolicy)
    {
        self.hostPolicy = hostPolicy
        self.connectionPolicy = connectionPolicy
    }

    func start(_ continuation: CheckedContinuation<ChatLinkPreviewResponse?, Never>) {
        let didAlreadyComplete = self.lock.withLock {
            if self.completed {
                return true
            }
            self.continuation = continuation
            return false
        }
        if didAlreadyComplete {
            continuation.resume(returning: nil)
        }
    }

    func abort(_ task: URLSessionTask) {
        task.cancel()
        self.complete(nil)
    }

    func urlSession(
        _: URLSession,
        task _: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void)
    {
        let nextURL = self.lock.withLock {
            let url = chatLinkPreviewRedirectURL(
                response: response,
                request: request,
                redirectCount: self.redirectCount,
                hostPolicy: self.hostPolicy)
            if url != nil { self.redirectCount += 1 }
            return url
        }
        completionHandler(nextURL == nil ? nil : request)
    }

    func urlSession(
        _: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void)
    {
        guard let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode),
              http.mimeType?.lowercased() == "text/html",
              let url = http.url
        else {
            self.lock.withLock { self.failed = true }
            completionHandler(.cancel)
            return
        }
        self.lock.withLock { self.responseURL = url }
        completionHandler(.allow)
    }

    func urlSession(_: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        let reachedCap = self.lock.withLock {
            let reachedCap = self.body.append(data)
            if reachedCap { self.bodyCapped = true }
            return reachedCap
        }
        if reachedCap { dataTask.cancel() }
    }

    func urlSession(_: URLSession, task _: URLSessionTask, didFinishCollecting metrics: URLSessionTaskMetrics) {
        // URLSession has no DNS hook. Pre-flight rejects unsafe literals; after connection,
        // every transaction's actual peer address is required and re-validated. The body is
        // discarded if Foundation omits metrics or reports any non-public address.
        self.lock.withLock {
            self.remoteAddresses.append(contentsOf: metrics.transactionMetrics.map(\.remoteAddress))
        }
    }

    func urlSession(_: URLSession, task _: URLSessionTask, didCompleteWithError error: (any Error)?) {
        let result = self.lock.withLock { () -> ChatLinkPreviewResponse? in
            guard !self.failed,
                  error == nil || self.bodyCapped,
                  let responseURL,
                  self.connectionPolicy(self.remoteAddresses)
            else { return nil }
            return ChatLinkPreviewResponse(url: responseURL, data: self.body.data)
        }
        self.complete(result)
    }

    private func complete(_ result: ChatLinkPreviewResponse?) {
        let continuation = self.lock.withLock { () -> CheckedContinuation<ChatLinkPreviewResponse?, Never>? in
            guard !self.completed else { return nil }
            self.completed = true
            defer { self.continuation = nil }
            return self.continuation
        }
        continuation?.resume(returning: result)
    }
}

@MainActor
final class ChatLinkPreviewStore {
    typealias Fetch = @Sendable (URL) async -> ChatLinkPreviewResult

    private let fetch: Fetch
    private let maxEntries: Int
    private var cache: [URL: ChatLinkPreviewResult] = [:]
    private var recency: [URL] = []

    init(maxEntries: Int = chatLinkPreviewCacheEntries, fetch: @escaping Fetch) {
        self.maxEntries = maxEntries
        self.fetch = fetch
    }

    func get(_ url: URL) async -> ChatLinkPreviewResult {
        if let cached = self.cache[url] {
            self.touch(url)
            return cached
        }
        let result = await self.fetch(url)
        self.cache[url] = result
        self.touch(url)
        while self.recency.count > self.maxEntries, let evicted = self.recency.first {
            self.recency.removeFirst()
            self.cache.removeValue(forKey: evicted)
        }
        return result
    }

    private func touch(_ url: URL) {
        self.recency.removeAll { $0 == url }
        self.recency.append(url)
    }
}

@MainActor
private let chatLinkPreviewStore = ChatLinkPreviewStore(fetch: ChatLinkPreviewFetcher().fetch)

@MainActor
struct ChatLinkPreview: View {
    @Environment(\.openURL) private var openURL
    let url: URL
    @State private var expanded = false
    @State private var result: ChatLinkPreviewResult?

    var body: some View {
        if self.expanded {
            self.expandedCard
                .task(id: self.url) {
                    guard self.result == nil else { return }
                    self.result = await chatLinkPreviewStore.get(self.url)
                }
        } else {
            self.collapsedChip
        }
    }

    private var collapsedChip: some View {
        Button {
            self.expanded = true
        } label: {
            HStack(spacing: 6) {
                Text("Preview · \(self.domain)")
                    .font(OpenClawChatTypography.captionSemiBold)
                    .foregroundStyle(OpenClawChatTheme.assistantText.opacity(0.65))
                    .lineLimit(1)
                Spacer(minLength: 0)
                Image(systemName: "chevron.down")
                    .foregroundStyle(OpenClawChatTheme.assistantText.opacity(0.65))
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(OpenClawChatTheme.subtleCard)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(OpenClawChatTheme.divider, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Expand link preview for \(self.domain)")
    }

    private var expandedCard: some View {
        Button {
            self.openURL(self.url)
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                Text(self.domain)
                    .font(OpenClawChatTypography.caption2)
                    .foregroundStyle(OpenClawChatTheme.assistantText.opacity(0.65))
                    .lineLimit(1)
                switch self.result {
                case nil:
                    Text("Loading preview…")
                        .font(OpenClawChatTypography.caption)
                        .foregroundStyle(OpenClawChatTheme.assistantText.opacity(0.65))
                case .failed:
                    Text("No preview available")
                        .font(OpenClawChatTypography.callout)
                        .foregroundStyle(OpenClawChatTheme.assistantText.opacity(0.65))
                case let .loaded(metadata):
                    if let title = metadata.title {
                        Text(title)
                            .font(OpenClawChatTypography.footnoteSemiBold)
                            .foregroundStyle(OpenClawChatTheme.assistantText)
                            .lineLimit(2)
                    }
                    if let description = metadata.description {
                        Text(description)
                            .font(OpenClawChatTypography.caption)
                            .foregroundStyle(OpenClawChatTheme.assistantText.opacity(0.65))
                            .lineLimit(1)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(OpenClawChatTheme.subtleCard)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(OpenClawChatTheme.divider, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open \(self.domain)")
    }

    private var domain: String {
        let host = self.url.host?.lowercased() ?? self.url.absoluteString
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }
}
