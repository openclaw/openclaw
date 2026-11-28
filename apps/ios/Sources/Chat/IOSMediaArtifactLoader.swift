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

    // The Gateway's smallest rendition is a 480 px WebP capped at 96 KiB. A miss never requests the original.
    static let tilePreviewWidth = 480
    private static let tilePreviewBytes = 96 * 1024

    func tileThumbnail(from response: ArtifactsDownloadResult, expectedGatewayID: String) async throws -> Data {
        guard response.artifact.type == "image" else { throw LoadError.unsupportedMediaType }
        let preview: ArtifactsDownloadResult
        if let data = response.data {
            guard response.artifact.mimetype == "image/webp", response.encoding == "base64" else {
                throw LoadError.invalidResponse
            }
            guard data.utf8.count <= Self.tilePreviewBytes / 3 * 4 else { throw LoadError.payloadTooLarge }
            preview = response
        } else {
            // A managed ticket covers both representations of the same artifact. Preserve its encoded scope and grant.
            guard let path = response.url, var parts = URLComponents(string: path),
                  parts.percentEncodedPath.hasPrefix("/api/chat/media/outgoing/"),
                  parts.percentEncodedPath.hasSuffix("/full") else { throw LoadError.invalidSource }
            parts.percentEncodedPath = String(parts.percentEncodedPath.dropLast(4)) + "thumbnail"
            var query = (parts.queryItems ?? []).filter { $0.name != "width" }
            query.append(URLQueryItem(name: "width", value: String(Self.tilePreviewWidth)))
            parts.queryItems = query
            preview = ArtifactsDownloadResult(artifact: response.artifact, url: parts.string)
        }
        guard case let .data(media) = try await self.load(
            response: preview, kind: .image, expectedGatewayID: expectedGatewayID, maximumBytes: Self.tilePreviewBytes),
            media.mimeType == "image/webp", media.data.count <= Self.tilePreviewBytes
        else {
            throw LoadError.invalidResponse
        }
        return media.data
    }

    func load(
        response: ArtifactsDownloadResult,
        kind: OpenClawChatMediaKind,
        playback: OpenClawChatPlaybackMode? = nil,
        expectedGatewayID: String,
        maximumBytes: Int? = nil) async throws -> OpenClawChatLoadedMedia
    {
        try await OpenClawChatMediaArtifactLoader.load(response: response, kind: kind, playback: playback) { path in
            guard let connection = await self.connectionProvider(),
                  connection.gatewayID == expectedGatewayID,
                  let url = OpenClawChatMediaURL.resolve(
                      gatewayURL: connection.config.url,
                      ticketedPath: path,
                      playback: playback)
            else { throw LoadError.invalidSource }

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
                    let operation = self.requestFactory(tls, maximumBytes ?? kind.maximumDownloadBytes)
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
                return (data, http)
            })
        }
    }
}
