import Foundation

struct GatewaySetupPayload: Codable {
    var url: String?
    var host: String?
    var port: Int?
    var tls: Bool?
    var token: String?
    var password: String?
}

enum GatewaySetupCode {
    static func decode(raw: String) -> GatewaySetupPayload? {
        if let payload = decodeFromJSON(raw) {
            return payload
        }
        if let decoded = decodeBase64Payload(raw),
           let payload = decodeFromJSON(decoded)
        {
            return payload
        }
        return nil
    }

    private static func decodeFromJSON(_ json: String) -> GatewaySetupPayload? {
        guard let data = json.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(GatewaySetupPayload.self, from: data)
    }

    private static func decodeBase64Payload(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let normalized = trimmed
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let padding = normalized.count % 4
        let padded = padding == 0 ? normalized : normalized + String(repeating: "=", count: 4 - padding)
        guard let data = Data(base64Encoded: padded) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

