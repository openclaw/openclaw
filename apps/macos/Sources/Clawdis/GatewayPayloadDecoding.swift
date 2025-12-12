import ClawdisProtocol
import Foundation

enum GatewayPayloadDecoding {
    static func decode<T: Decodable>(_ payload: ClawdisProtocol.AnyCodable, as _: T.Type = T.self) throws -> T {
        let data = try JSONEncoder().encode(payload)
        return try JSONDecoder().decode(T.self, from: data)
    }

    static func decodeIfPresent<T: Decodable>(_ payload: ClawdisProtocol.AnyCodable?, as _: T.Type = T.self) throws
        -> T?
    {
        guard let payload else { return nil }
        return try decode(payload, as: T.self)
    }
}
