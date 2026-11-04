import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol

struct IOSMediaArtifactLoader: Sendable {
    struct Connection: Sendable {
        let config: GatewayConnectConfig
        let gatewayID: String
        let customHeaders: [String: String]
    }

    typealias LoadError = OpenClawChatMediaArtifactLoader.LoadError

    typealias Request = @Sendable (URLRequest) async throws -> (Data, URLResponse)
    typealias RequestFactory = @Sendable (GatewayTLSParams, Int) -> Request
    typealias ConnectionProvider = @MainActor @Sendable () -> Connection?

    private let connectionProvider: ConnectionProvider
    private let requestFactory: RequestFactory

    init(
        connectionProvider: @escaping ConnectionProvider,
        requestFactory: @escaping RequestFactory = { tls, maximumBytes in
            let session = GatewayTLSPinningSession(
                params: tls, allowsRedirects: false, allowsStoredCredentials: false)
            return { request in
                defer { session.finishTasksAndInvalidate() }
                return try await session.data(for: request, maximumBytes: maximumBytes)
            }
        })
    {
        self.connectionProvider = connectionProvider
        self.requestFactory = requestFactory
    }

    func load(
        response: ArtifactsDownloadResult,
        kind: OpenClawChatMediaKind,
        playback: OpenClawChatPlaybackMode? = nil,
        expectedGatewayID: String) async throws -> OpenClawChatLoadedMedia
    {
        try await OpenClawChatMediaArtifactLoader.load(response: response, kind: kind, playback: playback) { path in
            try await self.source(
                path: path, kind: kind, playback: playback, expectedGatewayID: expectedGatewayID)
        }
    }

    /// Original bytes for catalog preview/export. Unlike chat playback, this never streams.
    func loadArtifact(
        response: ArtifactsDownloadResult,
        managed: Bool,
        expectedGatewayID: String,
        isCurrent: @escaping @Sendable () async -> Bool) async throws -> OpenClawChatMediaData
    {
        guard await isCurrent() else { throw CancellationError() }
        if let size = response.artifact.sizebytes, size > OpenClawChatMediaKind.file.maximumDownloadBytes {
            throw LoadError.payloadTooLarge
        }
        let declaredMIME = response.artifact.mimetype?.split(separator: ";", maxSplits: 1).first?
            .trimmingCharacters(in: .whitespaces).lowercased() ?? "application/octet-stream"
        let loaded = try await OpenClawChatMediaArtifactLoader.load(
            response: response, kind: .file, playback: nil)
        { path in
            let source = try await self.source(
                path: path,
                kind: .file,
                playback: nil,
                expectedGatewayID: expectedGatewayID,
                artifactDownload: !managed,
                isCurrent: isCurrent)
            return (source.url, false, { request in
                let (data, http) = try await source.download(request)
                if !managed, (200..<300).contains(http.statusCode) {
                    let disposition = http.value(forHTTPHeaderField: "Content-Disposition")?
                        .split(separator: ";", maxSplits: 1).first?
                        .trimmingCharacters(in: .whitespaces).lowercased()
                    guard disposition == "attachment", http.mimeType?.lowercased() == declaredMIME else {
                        throw LoadError.invalidResponse
                    }
                }
                return (data, http)
            })
        }
        guard await isCurrent() else { throw CancellationError() }
        guard case let .data(file) = loaded else { throw LoadError.invalidResponse }
        return file
    }

    private func source(
        path: String,
        kind: OpenClawChatMediaKind,
        playback: OpenClawChatPlaybackMode?,
        expectedGatewayID: String,
        artifactDownload: Bool = false,
        isCurrent: @escaping @Sendable () async -> Bool = { true }) async throws -> OpenClawChatMediaArtifactLoader
        .Source
    {
        guard await isCurrent() else { throw CancellationError() }
        guard let connection = await self.connectionProvider(), connection.gatewayID == expectedGatewayID else {
            throw LoadError.invalidSource
        }
        let resolvedURL = artifactDownload
            ? OpenClawChatMediaURL.resolveArtifactDownload(gatewayURL: connection.config.url, ticketedPath: path)
            : OpenClawChatMediaURL.resolve(gatewayURL: connection.config.url, ticketedPath: path, playback: playback)
        guard let url = resolvedURL else { throw LoadError.invalidSource }
        let ingress = connection.config.ingressAuthorization
        let headers: [String: String] = if let ingress {
            try await ingress.headers(url)
        } else {
            url.scheme?.lowercased() == "https"
                ? GatewayCustomHeaders.sanitized(connection.customHeaders)
                : [:]
        }
        // AVPlayer cannot use the app's pinned TLS delegate or immutable proxy
        // headers. Those routes take the bounded authenticated download path.
        let allowsStreaming = connection.config.tls == nil && ingress == nil && headers.isEmpty
        return (url, allowsStreaming, { request in
            var request = request
            for (name, value) in headers {
                request.setValue(value, forHTTPHeaderField: name)
            }
            let tls = connection.config.tls ?? GatewayTLSParams(
                required: false,
                expectedFingerprint: nil,
                allowTOFU: false,
                storeKey: nil)
            let data: Data
            let urlResponse: URLResponse
            do {
                let operation = self.requestFactory(tls, kind.maximumDownloadBytes)
                guard await isCurrent() else { throw CancellationError() }
                if let ingress {
                    (data, urlResponse) = try await ingress.load(request, operation)
                } else {
                    (data, urlResponse) = try await operation(request)
                }
            } catch is GatewayBoundedDataError {
                throw LoadError.payloadTooLarge
            }
            guard let http = urlResponse as? HTTPURLResponse, http.url == request.url else {
                throw LoadError.invalidResponse
            }
            // The capability belongs to the captured ingress revision. A late download
            // must not publish after expiry or replacement by another Access account.
            try await ingress?.checkResponse(http)
            guard await isCurrent() else { throw CancellationError() }
            return (data, http)
        })
    }
}
