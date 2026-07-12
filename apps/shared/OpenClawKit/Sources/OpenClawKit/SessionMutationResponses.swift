import Foundation

public struct OpenClawSessionsCompactResponse: Decodable, Sendable {
    public let ok: Bool
    public let reason: String?

    public static func requireSuccess(from data: Data) throws {
        let response = try JSONDecoder().decode(Self.self, from: data)
        guard response.ok else {
            throw OpenClawSessionsCompactError(reason: response.reason)
        }
    }
}

public struct OpenClawSessionsCompactError: Error, LocalizedError, Sendable {
    public let reason: String?

    public var errorDescription: String? {
        let detail = self.reason?.trimmingCharacters(in: .whitespacesAndNewlines)
        return detail?.isEmpty == false ? detail : "Session compaction failed"
    }

    public init(reason: String?) {
        self.reason = reason
    }
}
