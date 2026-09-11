import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol

struct IOSMediaArtifactLoader: Sendable {
    struct Connection: Sendable {
        let gatewayURL: URL
        let tls: GatewayTLSParams?
        let gatewayID: String
        let customHeaders: [String: String]
        let nativeBinding: IOSNativeActionBinding?

        init(config: GatewayConnectConfig, gatewayID: String, customHeaders: [String: String]) {
            self.gatewayURL = config.url
            self.tls = config.tls
            self.gatewayID = gatewayID
            self.customHeaders = customHeaders
            self.nativeBinding = nil
        }

        init(binding: IOSNativeActionBinding, context: GatewayAdmittedHTTPContext) {
            self.gatewayURL = context.gatewayURL
            self.tls = GatewayTLSParams(
                required: true,
                expectedFingerprint: context.tlsFingerprintSHA256,
                allowTOFU: false,
                storeKey: nil)
            self.gatewayID = binding.session.owner.gatewayID
            self.customHeaders = context.customHeaders
            self.nativeBinding = binding
        }
    }

    enum LoadError: Error, Equatable {
        case invalidSource
        case invalidResponse
        case requestFailed(statusCode: Int)
        case unsupportedMediaType
        case payloadTooLarge
    }

    typealias Request = @Sendable (URLRequest) async throws -> (Data, URLResponse)
    typealias RequestFactory = @Sendable (Connection, Int) -> Request
    typealias ConnectionProvider = @MainActor @Sendable () -> Connection?

    static let maximumImageBytes = 12 * 1024 * 1024
    static let maximumAudioBytes = 16 * 1024 * 1024
    static let maximumVideoBytes = 16 * 1024 * 1024
    private let connectionProvider: ConnectionProvider
    private let requestFactory: RequestFactory

    init(connectionProvider: @escaping ConnectionProvider) {
        self.init(connectionProvider: connectionProvider) { connection, maximumBytes in
            let tls = connection.tls ?? GatewayTLSParams(
                required: false,
                expectedFingerprint: nil,
                allowTOFU: false,
                storeKey: nil)
            let session = GatewayTLSPinningSession(
                params: tls,
                allowsRedirects: connection.nativeBinding == nil,
                allowsStoredCredentials: connection.nativeBinding == nil)
            return { request in
                defer { session.finishTasksAndInvalidate() }
                return try await session.data(for: request, maximumBytes: maximumBytes)
            }
        }
    }

    init(
        connectionProvider: @escaping ConnectionProvider,
        requestFactory: @escaping RequestFactory)
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
        let maximumBytes = Self.maximumBytes(for: kind)
        let declaredMIME = response.artifact.mimetype?.lowercased()
        if playback != .transcode,
           let encoded = response.data?.trimmingCharacters(in: .whitespacesAndNewlines),
           !encoded.isEmpty
        {
            guard response.encoding == "base64",
                  let declaredMIME,
                  declaredMIME.hasPrefix(kind.mimeTypePrefix),
                  let data = Data(base64Encoded: encoded)
            else { throw LoadError.invalidResponse }
            guard data.count <= maximumBytes else { throw LoadError.payloadTooLarge }
            return .data(OpenClawChatMediaData(data: data, mimeType: declaredMIME))
        }

        let path = response.url?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard let connection = await self.connectionProvider(),
              connection.gatewayID.utf8.elementsEqual(expectedGatewayID.utf8),
              let url = OpenClawChatMediaURL.resolve(
                  gatewayURL: connection.gatewayURL,
                  ticketedPath: path,
                  playback: playback)
        else { throw LoadError.invalidSource }
        try await connection.nativeBinding?.requireAvailable()

        let headers = url.scheme?.lowercased() == "https"
            ? GatewayCustomHeaders.sanitized(connection.customHeaders)
            : [:]
        // AVPlayer cannot use the app's pinned TLS delegate or immutable proxy
        // headers. Those routes take the bounded authenticated download path.
        let canStreamDirectly = kind == .video &&
            url.scheme?.lowercased() == "https" &&
            connection.nativeBinding == nil &&
            connection.tls == nil &&
            headers.isEmpty &&
            declaredMIME?.hasPrefix(kind.mimeTypePrefix) == true
        if canStreamDirectly, playback != .transcode, let declaredMIME {
            return .stream(OpenClawChatMediaStream(
                url: url,
                mimeType: declaredMIME,
                sizeBytes: response.artifact.sizebytes))
        }

        var request = URLRequest(url: url)
        request.timeoutInterval = kind == .video ? 60 : 20
        request.setValue("\(kind.rawValue)/*", forHTTPHeaderField: "Accept")
        if canStreamDirectly {
            request.setValue("bytes=0-0", forHTTPHeaderField: "Range")
        }
        for (name, value) in headers {
            request.setValue(value, forHTTPHeaderField: name)
        }
        let data: Data
        let urlResponse: URLResponse
        do {
            (data, urlResponse) = try await self.requestFactory(connection, maximumBytes)(request)
        } catch is GatewayBoundedDataError {
            throw LoadError.payloadTooLarge
        }
        if let binding = connection.nativeBinding, await !binding.isCurrent() {
            throw CancellationError()
        }
        guard let http = urlResponse as? HTTPURLResponse else { throw LoadError.invalidResponse }
        if http.statusCode == 202 {
            return .preparing
        }
        guard (200..<300).contains(http.statusCode) else {
            throw LoadError.requestFailed(statusCode: http.statusCode)
        }
        guard let mimeType = http.mimeType?.lowercased(),
              mimeType.hasPrefix(kind.mimeTypePrefix)
        else { throw LoadError.unsupportedMediaType }
        if canStreamDirectly {
            return .stream(OpenClawChatMediaStream(
                url: url,
                mimeType: mimeType,
                sizeBytes: response.artifact.sizebytes))
        }
        guard data.count <= maximumBytes else { throw LoadError.payloadTooLarge }
        return .data(OpenClawChatMediaData(data: data, mimeType: mimeType))
    }

    private static func maximumBytes(for kind: OpenClawChatMediaKind) -> Int {
        switch kind {
        case .image: self.maximumImageBytes
        case .audio: self.maximumAudioBytes
        case .video: self.maximumVideoBytes
        }
    }
}
