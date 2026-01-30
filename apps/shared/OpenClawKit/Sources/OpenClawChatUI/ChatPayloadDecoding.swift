<<<<<<< HEAD:apps/shared/MoltbotKit/Sources/MoltbotChatUI/ChatPayloadDecoding.swift
<<<<<<< HEAD
import ClawdbotProtocol
import ClawdbotKit
=======
import MoltbotKit
>>>>>>> upstream/main
=======
import OpenClawKit
>>>>>>> upstream/main:apps/shared/OpenClawKit/Sources/OpenClawChatUI/ChatPayloadDecoding.swift
import Foundation

enum ChatPayloadDecoding {
    static func decode<T: Decodable>(_ payload: AnyCodable, as _: T.Type = T.self) throws -> T {
        let data = try JSONEncoder().encode(payload)
        return try JSONDecoder().decode(T.self, from: data)
    }
}
