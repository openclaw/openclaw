import Foundation
import OpenClawKit

struct IOSAssistantMediaLoader: Sendable {
    typealias Request = @Sendable (URLRequest) async throws -> (Data, URLResponse)

    enum LoadError: Error, Equatable {
        case invalidSource
        case invalidResponse
        case requestFailed(statusCode: Int)
        case unsupportedMediaType
        case payloadTooLarge
    }

    static let maximumImageBytes = 10 * 1024 * 1024

    private let config: GatewayConnectConfig
    private let bearerToken: String?
    private let customHeaders: [String: String]
    private let request: Request

    init(config: GatewayConnectConfig) {
        let tls = config.tls ?? GatewayTLSParams(
            required: false,
            expectedFingerprint: nil,
            allowTOFU: false,
            storeKey: nil)
        let session = GatewayTLSPinningSession(params: tls)
        let request: Request = {
            try await session.data(for: $0, maximumBytes: Self.maximumImageBytes)
        }
        self.init(
            config: config,
            storedOperatorToken: AuthenticatedControlUI.storedOperatorToken(config: config),
            customHeaders: GatewaySettingsStore.loadGatewayCustomHeaders(
                gatewayStableID: config.effectiveStableID),
            request: request)
    }

    init(
        config: GatewayConnectConfig,
        storedOperatorToken: String?,
        customHeaders: [String: String],
        request: @escaping Request)
    {
        self.config = config
        self.bearerToken = Self.firstCredential(
            config.token,
            storedOperatorToken,
            config.password)
        self.customHeaders = GatewayCustomHeaders.sanitized(customHeaders)
        self.request = request
    }

    func load(path: String) async throws -> Data {
        let source = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !source.isEmpty,
              let url = AuthenticatedControlUI.pageURL(
                  config: config,
                  path: "/__openclaw__/assistant-media",
                  queryItems: [URLQueryItem(name: "source", value: source)])
        else { throw LoadError.invalidSource }

        var request = URLRequest(url: url)
        request.timeoutInterval = 20
        request.setValue("image/*", forHTTPHeaderField: "Accept")
        if url.scheme?.lowercased() == "https" {
            for (name, value) in self.customHeaders {
                request.setValue(value, forHTTPHeaderField: name)
            }
        }
        if let bearerToken {
            request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await self.request(request)
        } catch is GatewayBoundedDataError {
            throw LoadError.payloadTooLarge
        }
        guard let httpResponse = response as? HTTPURLResponse else {
            throw LoadError.invalidResponse
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            throw LoadError.requestFailed(statusCode: httpResponse.statusCode)
        }
        guard httpResponse.mimeType?.lowercased().hasPrefix("image/") == true else {
            throw LoadError.unsupportedMediaType
        }
        guard data.count <= Self.maximumImageBytes else {
            throw LoadError.payloadTooLarge
        }
        return data
    }

    private static func firstCredential(_ values: String?...) -> String? {
        values.lazy
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty }
    }
}
