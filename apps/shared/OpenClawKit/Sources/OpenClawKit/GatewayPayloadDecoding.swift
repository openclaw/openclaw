import Foundation
import OpenClawProtocol

public enum GatewayPayloadDecoding {
    /// Keep potentially large RPC responses off the caller's actor without detaching its task.
    @concurrent
    public static func decode<T: Decodable & Sendable>(_ type: T.Type, from data: Data) async throws -> T {
        try Task.checkCancellation()
        let value = try JSONDecoder().decode(type, from: data)
        try Task.checkCancellation()
        return value
    }

    public static func decode<T: Decodable>(
        _ payload: AnyCodable,
        as _: T.Type = T.self) throws -> T
    {
        let data = try JSONEncoder().encode(payload)
        return try JSONDecoder().decode(T.self, from: data)
    }
}
