import Foundation

public protocol GatewaySetupShortCodeHTTPClient: Sendable {
    func data(for request: URLRequest) async throws -> (Data, URLResponse)
}

extension URLSession: GatewaySetupShortCodeHTTPClient {}

public enum GatewaySetupShortCode {
    private static let alphabet = Set("ABCDEFGHJKLMNPQRSTUVWXYZ23456789")
    private static let codeLength = 8

    public static func normalize(_ value: String) -> String? {
        let normalized = value
            .uppercased()
            .replacingOccurrences(of: #"\s+"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: "-", with: "")
        guard normalized.count == self.codeLength else { return nil }
        guard normalized.allSatisfy({ self.alphabet.contains($0) }) else { return nil }
        return normalized
    }

    public static func looksLikeShortCode(_ value: String) -> Bool {
        self.normalize(value) != nil
    }
}

public struct GatewaySetupShortCodeRedeemer: Sendable {
    public enum RedeemError: Error, Equatable, LocalizedError {
        case invalidCode
        case invalidGateway
        case invalidResponse
        case invalidOrExpired
        case rejected(statusCode: Int)

        public var errorDescription: String? {
            switch self {
            case .invalidCode:
                "Setup short code is not valid."
            case .invalidGateway:
                "Choose a reachable Gateway before using a setup short code."
            case .invalidResponse:
                "Gateway returned an invalid setup response."
            case .invalidOrExpired:
                "Setup short code is invalid or expired."
            case let .rejected(statusCode):
                "Gateway rejected the setup short code (HTTP \(statusCode))."
            }
        }
    }

    private struct RedeemRequest: Encodable {
        let code: String
    }

    private struct RedeemResponse: Decodable {
        let ok: Bool
        let payload: SetupPayload?
    }

    private struct SetupPayload: Decodable {
        let url: String
        let bootstrapToken: String
        let token: String?
        let password: String?
    }

    public let client: GatewaySetupShortCodeHTTPClient

    public init(client: GatewaySetupShortCodeHTTPClient = URLSession.shared) {
        self.client = client
    }

    public func redeem(
        _ rawCode: String,
        through gateway: GatewayConnectDeepLink) async throws -> GatewayConnectDeepLink
    {
        guard let code = GatewaySetupShortCode.normalize(rawCode) else {
            throw RedeemError.invalidCode
        }
        guard let url = Self.redemptionURL(for: gateway) else {
            throw RedeemError.invalidGateway
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(RedeemRequest(code: code))

        let (data, response) = try await self.client.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw RedeemError.invalidResponse
        }
        if http.statusCode == 404 || http.statusCode == 400 {
            throw RedeemError.invalidOrExpired
        }
        guard (200..<300).contains(http.statusCode) else {
            throw RedeemError.rejected(statusCode: http.statusCode)
        }
        let decoded = try JSONDecoder().decode(RedeemResponse.self, from: data)
        guard decoded.ok, let payload = decoded.payload else {
            throw RedeemError.invalidResponse
        }
        guard let link = GatewayConnectDeepLink.fromGatewayURL(
            payload.url,
            bootstrapToken: payload.bootstrapToken,
            token: payload.token,
            password: payload.password)
        else {
            throw RedeemError.invalidResponse
        }
        return link
    }

    public static func redemptionURL(for gateway: GatewayConnectDeepLink) -> URL? {
        guard let websocketURL = gateway.websocketURL,
              GatewayConnectDeepLink.fromGatewayURL(websocketURL.absoluteString) != nil,
              var components = URLComponents(url: websocketURL, resolvingAgainstBaseURL: false)
        else {
            return nil
        }
        switch components.scheme?.lowercased() {
        case "ws":
            components.scheme = "http"
        case "wss":
            components.scheme = "https"
        default:
            return nil
        }
        components.path = "/api/v1/pairing/setup-code/redeem"
        components.query = nil
        components.fragment = nil
        return components.url
    }
}
