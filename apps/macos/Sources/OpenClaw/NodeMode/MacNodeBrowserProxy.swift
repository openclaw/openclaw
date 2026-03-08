import Foundation
import OpenClawKit
import OpenClawProtocol

actor MacNodeBrowserProxy {
    static let shared = MacNodeBrowserProxy()

    private struct RequestParams: Decodable {
        let method: String?
        let path: String?
        let query: [String: OpenClawProtocol.AnyCodable]?
        let body: OpenClawProtocol.AnyCodable?
        let timeoutMs: Int?
        let profile: String?
    }

    private let connection: GatewayConnection

    init(
        connection: GatewayConnection = GatewayConnection(configProvider: {
            GatewayEndpointStore.localConfig()
        }))
    {
        self.connection = connection
    }

    func request(paramsJSON: String?) async throws -> String {
        let params = try Self.decodeRequestParams(from: paramsJSON)
        let method = (params.method ?? "GET").trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        let path = (params.path ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty else {
            throw NSError(domain: "MacNodeBrowserProxy", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "INVALID_REQUEST: path required",
            ])
        }

        var query = params.query?.mapValues { OpenClawKit.AnyCodable($0.value) } ?? [:]
        let profile = params.profile?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !profile.isEmpty, query["profile"] == nil {
            query["profile"] = OpenClawKit.AnyCodable(profile)
        }

        var gatewayParams: [String: OpenClawKit.AnyCodable] = [
            "method": OpenClawKit.AnyCodable(method),
            "path": OpenClawKit.AnyCodable(path),
        ]
        if !query.isEmpty {
            gatewayParams["query"] = OpenClawKit.AnyCodable(query)
        }
        if let body = params.body {
            gatewayParams["body"] = OpenClawKit.AnyCodable(body.value)
        }
        if let timeoutMs = params.timeoutMs, timeoutMs > 0 {
            gatewayParams["timeoutMs"] = OpenClawKit.AnyCodable(timeoutMs)
        }

        let data = try await self.connection.requestRaw(
            method: "browser.request",
            params: gatewayParams,
            timeoutMs: params.timeoutMs.map(Double.init))
        guard let payloadJSON = String(data: data, encoding: .utf8) else {
            throw NSError(domain: "MacNodeBrowserProxy", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "browser request returned invalid UTF-8",
            ])
        }
        return payloadJSON
    }

    private static func decodeRequestParams(from raw: String?) throws -> RequestParams {
        guard let raw else {
            throw NSError(domain: "MacNodeBrowserProxy", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "INVALID_REQUEST: paramsJSON required",
            ])
        }
        return try JSONDecoder().decode(RequestParams.self, from: Data(raw.utf8))
    }
}
