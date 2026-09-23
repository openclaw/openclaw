import Foundation

public struct OpenClawChatSourceContext: Hashable, Sendable {
    public let gatewayURL: URL
    /// Percent-encoded mount shared by resource routing and dedicated-link matching.
    public let basePath: String
    public let publicOrigin: URL?
    public let automaticallyFetchFavicons: Bool

    public init(
        gatewayURL: URL,
        basePath: String,
        publicOrigin: URL? = nil,
        automaticallyFetchFavicons: Bool = false)
    {
        self.gatewayURL = gatewayURL
        self.basePath = basePath
        self.publicOrigin = publicOrigin
        self.automaticallyFetchFavicons = automaticallyFetchFavicons
    }
}

/// One connected route owns bootstrap discovery and its preference snapshot.
/// Native adapters supply authenticated, bounded requests tied to that route.
public actor OpenClawChatSourceResources {
    public typealias Request = @Sendable (URL, Int) async throws -> (Data, URLResponse)
    public typealias ConfigLoader = @Sendable () async -> Data?
    public typealias IsCurrent = @Sendable () async -> Bool

    public static let maximumFaviconBytes = 64 * 1024
    private let gatewayURL: URL
    private let nativeControlPageURL: URL?
    private let request: Request
    private let loadConfig: ConfigLoader
    private let isCurrent: IsCurrent
    private var revision: UInt64 = 0
    private struct ContextSnapshot: Sendable {
        let context: OpenClawChatSourceContext
        let resourceBaseURL: URL
    }

    private var contextTask: Task<ContextSnapshot?, Never>?
    private var faviconTasks: [URL: Task<Data?, Never>] = [:]
    private var faviconOrder: [URL] = []
    private static let maximumCachedFavicons = 32

    public init(
        gatewayURL: URL,
        nativeControlPageURL: URL? = nil,
        request: @escaping Request,
        loadConfig: @escaping ConfigLoader,
        isCurrent: @escaping IsCurrent)
    {
        self.gatewayURL = gatewayURL
        self.nativeControlPageURL = nativeControlPageURL
        self.request = request
        self.loadConfig = loadConfig
        self.isCurrent = isCurrent
    }

    public func invalidate() {
        self.revision &+= 1
        self.contextTask?.cancel()
        self.contextTask = nil
        for task in self.faviconTasks.values {
            task.cancel()
        }
        self.faviconTasks.removeAll()
        self.faviconOrder.removeAll()
    }

    public func loadContext() async -> OpenClawChatSourceContext? {
        await self.loadContextSnapshot()?.context
    }

    private func loadContextSnapshot() async -> ContextSnapshot? {
        guard await self.isCurrent(), !Task.isCancelled else { return nil }
        let revision = self.revision
        let task: Task<ContextSnapshot?, Never>
        if let existing = contextTask {
            task = existing
        } else {
            task = Task { await self.discoverContext() }
            self.contextTask = task
        }
        let context = await task.value
        guard await self.isCurrent(), self.revision == revision, !Task.isCancelled else { return nil }
        return context
    }

    public func loadFavicon(host: String) async -> Data? {
        let revision = self.revision
        guard let snapshot = await loadContextSnapshot(), snapshot.context.automaticallyFetchFavicons,
              let url = Self.faviconURL(host: host, baseURL: snapshot.resourceBaseURL),
              await isCurrent(), self.revision == revision, !Task.isCancelled
        else { return nil }
        let task: Task<Data?, Never>
        if let cached = self.faviconTasks[url] {
            task = cached
        } else {
            if self.faviconOrder.count >= Self.maximumCachedFavicons {
                let oldest = self.faviconOrder.removeFirst()
                self.faviconTasks.removeValue(forKey: oldest)?.cancel()
            }
            task = Task { await self.downloadFavicon(url: url, revision: revision) }
            self.faviconTasks[url] = task
            self.faviconOrder.append(url)
        }
        let data = await task.value
        guard await self.isCurrent(), self.revision == revision, !Task.isCancelled else { return nil }
        return data
    }

    private func downloadFavicon(url: URL, revision: UInt64) async -> Data? {
        guard await self.isCurrent(), self.revision == revision, !Task.isCancelled,
              let (data, response) = try? await self.request(url, Self.maximumFaviconBytes),
              await self.isCurrent(), self.revision == revision, !Task.isCancelled,
              let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode),
              http.mimeType?.lowercased().hasPrefix("image/") == true,
              !data.isEmpty, data.count <= Self.maximumFaviconBytes
        else { return nil }
        return data
    }

    /// Proxy and Gateway credentials share one HTTP header. Preserve the proxy
    /// attempt, then retry only an authentication rejection with the Gateway bearer.
    public static func performAuthenticatedRequest(
        _ request: URLRequest,
        bearer: String?,
        send: @Sendable (URLRequest) async throws -> (Data, URLResponse)) async throws -> (Data, URLResponse)
    {
        var request = request
        let configuredAuthorization = request.value(forHTTPHeaderField: "Authorization")
        let gatewayAuthorization = bearer.map { "Bearer " + $0 }
        if configuredAuthorization == nil {
            request.setValue(gatewayAuthorization, forHTTPHeaderField: "Authorization")
        }
        let result = try await send(request)
        guard let configuredAuthorization,
              let gatewayAuthorization, gatewayAuthorization != configuredAuthorization,
              let response = result.1 as? HTTPURLResponse,
              response.statusCode == 401 || response.statusCode == 403
        else { return result }
        try Task.checkCancellation()
        request.setValue(gatewayAuthorization, forHTTPHeaderField: "Authorization")
        return try await send(request)
    }

    private func discoverContext() async -> ContextSnapshot? {
        guard let gatewayURL = Self.httpURL(self.gatewayURL) else { return nil }
        let configData = await self.loadConfig()
        guard await self.isCurrent() else { return nil }
        let config = configData.flatMap { try? JSONDecoder().decode(ConfigSnapshot.self, from: $0) }
        if let config {
            let controlUI = config.runtimeConfig.gateway?.controlUi
            return self.contextSnapshot(
                gatewayURL: gatewayURL,
                basePath: controlUI?.basePath ?? "",
                publicOrigin: config.runtimeConfig.gateway?.publicOrigin.flatMap(Self.publicOrigin),
                automaticallyFetchFavicons: controlUI?.automaticallyFetchFavicons != false)
        }
        let bootstrapBase = self.controlPageURL(gatewayURL: gatewayURL) ?? gatewayURL
        guard let url = Self.appendResourcePath("/control-ui-config.json", to: bootstrapBase),
              await self.isCurrent(), !Task.isCancelled
        else { return nil }
        if let (data, response) = try? await self.request(url, 64 * 1024),
           let http = response as? HTTPURLResponse,
           (200..<300).contains(http.statusCode), http.mimeType == "application/json",
           let bootstrap = try? JSONDecoder().decode(Bootstrap.self, from: data)
        {
            guard await self.isCurrent(), !Task.isCancelled else { return nil }
            if let snapshot = self.contextSnapshot(
                gatewayURL: gatewayURL,
                basePath: bootstrap.basePath,
                automaticallyFetchFavicons: bootstrap.automaticallyFetchFavicons ?? false)
            {
                return snapshot
            }
        }
        guard await self.isCurrent() else { return nil }
        return self.contextSnapshot(gatewayURL: gatewayURL, basePath: "", automaticallyFetchFavicons: false)
    }

    private func contextSnapshot(
        gatewayURL: URL,
        basePath: String,
        publicOrigin: URL? = nil,
        automaticallyFetchFavicons: Bool) -> ContextSnapshot?
    {
        guard let basePath = Self.normalizedBasePath(basePath) else { return nil }
        let resourceBaseURL: URL? = if basePath.isEmpty,
                                       let controlPageURL = self.controlPageURL(gatewayURL: gatewayURL)
        {
            controlPageURL
        } else {
            Self.resourceURL(gatewayURL: gatewayURL, basePath: basePath, path: "")
        }
        guard let resourceBaseURL,
              let components = URLComponents(url: resourceBaseURL, resolvingAgainstBaseURL: false)
        else { return nil }
        let mount = components.percentEncodedPath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return ContextSnapshot(
            context: OpenClawChatSourceContext(
                gatewayURL: gatewayURL,
                basePath: mount.isEmpty ? "" : "/" + mount,
                publicOrigin: publicOrigin,
                automaticallyFetchFavicons: automaticallyFetchFavicons),
            resourceBaseURL: resourceBaseURL)
    }

    private func controlPageURL(gatewayURL: URL) -> URL? {
        guard let nativeControlPageURL, let url = Self.httpURL(nativeControlPageURL),
              url.scheme == gatewayURL.scheme, url.host?.lowercased() == gatewayURL.host?.lowercased(),
              (url.port ?? (url.scheme == "https" ? 443 : 80)) ==
              (gatewayURL.port ?? (gatewayURL.scheme == "https" ? 443 : 80))
        else { return nil }
        return url
    }

    static func httpURL(_ url: URL) -> URL? {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.host?.isEmpty == false, components.user == nil, components.password == nil
        else { return nil }
        switch components.scheme?.lowercased() {
        case "ws", "http": components.scheme = "http"
        case "wss", "https": components.scheme = "https"
        default: return nil
        }
        components.query = nil
        components.fragment = nil
        return components.url
    }

    private static func faviconURL(host: String, baseURL: URL) -> URL? {
        let host = host.lowercased()
        guard !host.isEmpty, host.utf8.count <= 253,
              host.unicodeScalars.allSatisfy({
                  CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789.-").contains($0)
              }),
              !host.hasPrefix("."), !host.hasSuffix("."), !host.contains("..")
        else { return nil }
        return Self.appendResourcePath("/__openclaw__/link-favicon/" + host, to: baseURL)
    }

    private static func appendResourcePath(_ path: String, to baseURL: URL) -> URL? {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else { return nil }
        while components.percentEncodedPath.hasSuffix("/") {
            components.percentEncodedPath.removeLast()
        }
        components.percentEncodedPath += path
        return components.url
    }

    private static func resourceURL(gatewayURL: URL, basePath: String, path: String) -> URL? {
        guard let basePath = normalizedBasePath(basePath),
              let url = httpURL(gatewayURL),
              var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else { return nil }
        components.path = basePath + path
        return components.url
    }

    private static func normalizedBasePath(_ raw: String) -> String? {
        let path = raw.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !path.contains("\\"), !path.contains("?"), !path.contains("#"), !path.contains("%"),
              !path.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              !path.split(separator: "/").contains(where: { $0 == "." || $0 == ".." })
        else { return nil }
        return path.isEmpty ? "" : "/" + path
    }

    private static func publicOrigin(_ raw: String) -> URL? {
        guard let url = URL(string: raw), let http = httpURL(url),
              ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              url.query == nil, url.fragment == nil
        else { return nil }
        return http
    }

    private struct Bootstrap: Decodable {
        let basePath: String
        let automaticallyFetchFavicons: Bool?
    }

    private struct ConfigSnapshot: Decodable {
        let runtimeConfig: RuntimeConfig
    }

    private struct RuntimeConfig: Decodable {
        let gateway: GatewayConfig?
    }

    private struct GatewayConfig: Decodable {
        let publicOrigin: String?
        let controlUi: ControlUIConfig?
    }

    private struct ControlUIConfig: Decodable {
        let basePath: String?
        let automaticallyFetchFavicons: Bool?
    }
}
