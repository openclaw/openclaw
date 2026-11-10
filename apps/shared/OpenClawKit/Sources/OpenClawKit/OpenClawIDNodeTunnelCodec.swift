import CoreFoundation
import Foundation

public enum OpenClawIDNodeTunnelCodec {
    public struct ResponseHead: Sendable, Equatable {
        public let status: Int
        public let selectedProtocol: String?
        public let headers: [[String]]
    }

    public enum Message: Sendable, Equatable {
        case text(String)
        case binary(Data)
        case close(UInt16?, String)
    }

    public static func frame(
        _ payload: Data,
        limit: Int = OpenClawIDNodeTunnelProtocol.maximumFrameBytes) throws -> Data
    {
        guard payload.count <= limit, payload.count <= Int(UInt32.max) else {
            throw OpenClawIDNodeTransportError.oversizedFrame
        }
        let length = UInt32(payload.count)
        var result = Data([
            UInt8(truncatingIfNeeded: length >> 24), UInt8(truncatingIfNeeded: length >> 16),
            UInt8(truncatingIfNeeded: length >> 8), UInt8(truncatingIfNeeded: length),
        ])
        result.append(payload)
        return result
    }

    public static func requestHead(
        path: String, headers: [[String]] = [], method: String? = nil, protocols: [String] = []) throws -> Data
    {
        guard path.hasPrefix("/"), headers.allSatisfy({ $0.count == 2 }) else {
            throw OpenClawIDNodeTransportError.invalidHead
        }
        var object: [String: Any] = ["kind": method == nil ? "ws" : "http", "path": path, "headers": headers]
        if let method {
            guard !method.isEmpty, method.utf8.allSatisfy({
                (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) ||
                    Array("!#$%&'*+.^_`|~-".utf8).contains($0)
            }) else { throw OpenClawIDNodeTransportError.invalidHead }
            object["method"] = method
        } else {
            object["protocols"] = protocols
        }
        let bytes = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
        return try self.frame(bytes, limit: OpenClawIDNodeTunnelProtocol.maximumHeadBytes)
    }

    public static func responseHead(_ bytes: Data) throws -> ResponseHead {
        guard bytes.count <= OpenClawIDNodeTunnelProtocol.maximumHeadBytes,
              String(bytes: bytes, encoding: .utf8) != nil,
              let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              let number = object["status"] as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.rounded(.towardZero) == number.doubleValue,
              (100...599).contains(number.intValue)
        else { throw OpenClawIDNodeTransportError.invalidHead }
        if number.intValue == 101 {
            let value = object["protocol"]
            guard value == nil || value is NSNull || value is String else {
                throw OpenClawIDNodeTransportError.invalidHead
            }
            return ResponseHead(status: 101, selectedProtocol: value as? String, headers: [])
        }
        let headers: [[String]]
        if let raw = object["headers"], !(raw is NSNull) {
            guard let pairs = raw as? [[String]], pairs.allSatisfy({ $0.count == 2 }) else {
                throw OpenClawIDNodeTransportError.invalidHead
            }
            headers = pairs
        } else {
            headers = []
        }
        return ResponseHead(status: number.intValue, selectedProtocol: nil, headers: headers)
    }

    public static func message(_ message: Message) throws -> Data {
        var payload: Data
        switch message {
        case let .text(text): payload = Data([1]) + Data(text.utf8)
        case let .binary(bytes): payload = Data([2]) + bytes
        case let .close(code, reason):
            payload = Data([8])
            if let code {
                payload.append(contentsOf: [UInt8(truncatingIfNeeded: code >> 8), UInt8(truncatingIfNeeded: code)])
                payload.append(contentsOf: reason.utf8)
            }
        }
        return try self.frame(payload)
    }

    public static func decodeMessage(_ payload: Data) throws -> Message {
        guard let opcode = payload.first else { throw OpenClawIDNodeTransportError.unsupportedOpcode }
        let bytes = payload.dropFirst()
        switch opcode {
        case 1:
            guard let text = String(bytes: bytes, encoding: .utf8) else {
                throw OpenClawIDNodeTransportError.malformedFrame
            }
            return .text(text)
        case 2: return .binary(Data(bytes))
        case 8:
            if bytes.isEmpty { return .close(nil, "") }
            guard bytes.count >= 2 else { throw OpenClawIDNodeTransportError.truncatedFrame }
            let code = UInt16(bytes[bytes.startIndex]) << 8 | UInt16(bytes[bytes.startIndex + 1])
            return .close(code, String(decoding: bytes.dropFirst(2), as: UTF8.self))
        default: throw OpenClawIDNodeTransportError.unsupportedOpcode
        }
    }
}

/// One reader per stream. Read only the header before accepting a payload allocation;
/// the same reader switches from the smaller HEAD limit to WS/HTTP limits afterward.
actor OpenClawIDNodeFrameReader {
    let stream: any OpenClawIDNodeStream
    private var reading = false

    init(stream: any OpenClawIDNodeStream) {
        self.stream = stream
    }

    func next(limit: Int) async throws -> Data? {
        guard !self.reading else { throw OpenClawIDNodeTransportError.malformedFrame }
        self.reading = true
        defer { self.reading = false }
        do {
            guard let header = try await self.exactly(4, allowEOF: true) else { return nil }
            let length = header.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
            guard Int(length) <= limit else { throw OpenClawIDNodeTransportError.oversizedFrame }
            return try await self.exactly(Int(length), allowEOF: false)
        } catch {
            await self.stream.stop(code: 4)
            await self.stream.reset(code: 4)
            throw error
        }
    }

    private func exactly(_ count: Int, allowEOF: Bool) async throws -> Data? {
        var bytes = Data()
        while bytes.count < count {
            try Task.checkCancellation()
            guard let next = try await self.stream.read(maxBytes: min(
                count - bytes.count,
                OpenClawIDNodeTunnelProtocol.maximumHTTPDataBytes))
            else {
                if bytes.isEmpty, allowEOF { return nil }
                throw OpenClawIDNodeTransportError.truncatedFrame
            }
            guard !next.isEmpty, next.count <= count - bytes.count else {
                throw OpenClawIDNodeTransportError.malformedFrame
            }
            bytes.append(next)
        }
        return bytes
    }
}
