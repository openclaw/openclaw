#if os(iOS) || os(macOS)
import CryptoKit
import Foundation

/// RFC 6455 failures carry only a public close code, never input or credentials.
public struct OpenClawIDBridgeWebSocketError: Error {
    public let code: UInt16
    public static let framing = Self(code: 1002)
    public static let encoding = Self(code: 1007)
    public static let tooLarge = Self(code: 1009)
}

/// Local RFC 6455 framing is separate from the tunnel's length-prefixed messages.
public enum OpenClawIDBridgeWebSocketCodec {
    /// The tunnel adds one opcode byte to each message payload.
    public static let maximumMessageBytes = OpenClawIDNodeTunnelProtocol.maximumFrameBytes - 1

    public struct Header: Sendable, Equatable {
        public let final: Bool
        public let opcode: UInt8
        public let length: Int

        /// Parses only the fixed/extended header, before allocating a payload. Clients
        /// must mask; no extensions were negotiated, so RSV bits must all be zero.
        public static func parse(_ bytes: Data) throws -> Self {
            let bytes = [UInt8](bytes)
            guard bytes.count >= 2, bytes[0] & 0x70 == 0, bytes[1] & 0x80 != 0 else {
                throw OpenClawIDBridgeWebSocketError.framing
            }
            let opcode = bytes[0] & 0x0F
            let final = bytes[0] & 0x80 != 0
            let tag = bytes[1] & 0x7F
            guard [0, 1, 2, 8, 9, 10].contains(opcode),
                  opcode < 8 || (final && tag <= 125)
            else { throw OpenClawIDBridgeWebSocketError.framing }
            let extra = tag == 127 ? 8 : (tag == 126 ? 2 : 0)
            guard bytes.count == 2 + extra else { throw OpenClawIDBridgeWebSocketError.framing }
            let length = extra == 0 ? UInt64(tag) : bytes.dropFirst(2).reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
            guard length < (UInt64(1) << 63), tag != 126 || length >= 126, tag != 127 || length >= 65536 else {
                throw OpenClawIDBridgeWebSocketError.framing
            }
            guard length <= UInt64(OpenClawIDBridgeWebSocketCodec.maximumMessageBytes) else {
                throw OpenClawIDBridgeWebSocketError.tooLarge
            }
            return Self(final: final, opcode: opcode, length: Int(length))
        }
    }

    public enum Event: Sendable, Equatable {
        case text(String), binary(Data), ping(Data), pong, close(Data)
    }

    /// Maintains at most one fragmented message. Control frames can interleave without
    /// changing its opcode; the cumulative limit is checked before reading each payload.
    public struct Messages {
        private var opcode: UInt8?
        private var pending = Data()

        public init() {}

        public func validate(_ header: Header) throws {
            if header.opcode >= 8 { return }
            guard (header.opcode == 0) == (self.opcode != nil) else {
                throw OpenClawIDBridgeWebSocketError.framing
            }
            guard header.length <= OpenClawIDBridgeWebSocketCodec.maximumMessageBytes - self.pending.count else {
                throw OpenClawIDBridgeWebSocketError.tooLarge
            }
        }

        public mutating func consume(_ header: Header, payload: Data) throws -> Event? {
            try self.validate(header)
            guard payload.count == header.length else { throw OpenClawIDBridgeWebSocketError.framing }
            switch header.opcode {
            case 8:
                try OpenClawIDBridgeWebSocketCodec.validateClose(payload)
                return .close(payload)
            case 9: return .ping(payload)
            case 10: return .pong
            default:
                let opcode = self.opcode ?? header.opcode
                self.pending.append(payload)
                if !header.final { self.opcode = opcode
                    return nil
                }
                let bytes = self.pending
                self.pending = Data()
                self.opcode = nil
                if opcode == 2 { return .binary(bytes) }
                guard let text = String(bytes: bytes, encoding: .utf8) else {
                    throw OpenClawIDBridgeWebSocketError.encoding
                }
                return .text(text)
            }
        }
    }

    /// Validates a WebSocket upgrade, without making any tunnel side effect.
    /// `path` is the only WebSocket target the caller serves: the worker route for the node
    /// bridge, the Gateway root for the operator dashboard proxy.
    public static func upgrade(
        _ request: OpenClawIDBridgeRequest,
        path: String = "/__openclaw__/worker") throws -> Data
    {
        let target = request.path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first
        let keys = request.values("sec-websocket-key")
        let connection = request.values("connection").flatMap {
            $0.lowercased().split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        }
        guard request.method == "GET", target.map(String.init) == path, request.body == .length(0),
              request.values("upgrade").map({ $0.lowercased() }) == ["websocket"], connection.contains("upgrade"),
              request.values("sec-websocket-version") == ["13"], keys.count == 1,
              let decoded = Data(base64Encoded: keys[0]), decoded.count == 16, decoded.base64EncodedString() == keys[0],
              request.values("sec-websocket-protocol").isEmpty, request.values("expect").isEmpty
        else { throw OpenClawIDBridgeWebSocketError.framing }
        // SHA-1 here is the mandated RFC 6455 accept transform, not authentication.
        let digest = Insecure.SHA1.hash(data: Data((keys[0] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))
        let accept = Data(digest).base64EncodedString()
        return Data(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
                "Connection: Upgrade\r\nSec-WebSocket-Accept: \(accept)\r\n\r\n").utf8)
    }

    /// Server frames are unmasked, final and minimally length-encoded.
    public static func frame(opcode: UInt8, payload: Data) throws -> Data {
        guard [1, 2, 8, 9, 10].contains(opcode), opcode < 8 || payload.count <= 125 else {
            throw OpenClawIDBridgeWebSocketError.framing
        }
        guard payload.count <= self.maximumMessageBytes else { throw OpenClawIDBridgeWebSocketError.tooLarge }
        if opcode == 8 { try self.validateClose(payload) }
        var result = Data([0x80 | opcode])
        if payload.count < 126 { result.append(UInt8(payload.count)) } else {
            let width = payload.count <= 65535 ? 2 : 8
            result.append(width == 2 ? 126 : 127)
            for shift in stride(from: (width - 1) * 8, through: 0, by: -8) {
                result.append(UInt8(truncatingIfNeeded: UInt64(payload.count) >> shift))
            }
        }
        result.append(payload)
        return result
    }

    public static func unmask(_ payload: Data, key: Data) throws -> Data {
        guard key.count == 4 else { throw OpenClawIDBridgeWebSocketError.framing }
        let key = [UInt8](key)
        var result = payload
        result.withUnsafeMutableBytes { (bytes: UnsafeMutableRawBufferPointer) in
            for index in bytes.indices {
                bytes[index] ^= key[index % 4]
            }
        }
        return result
    }

    /// Reserved/no-status codes are never serialized, and close reasons must be UTF-8.
    public static func validateClose(_ payload: Data) throws {
        guard payload.count <= 125, payload.count != 1 else { throw OpenClawIDBridgeWebSocketError.framing }
        if payload.isEmpty { return }
        let code = UInt16(payload[payload.startIndex]) << 8 | UInt16(payload[payload.startIndex + 1])
        guard (1000...1003).contains(code) || (1007...1014).contains(code) || (3000...4999).contains(code) else {
            throw OpenClawIDBridgeWebSocketError.framing
        }
        guard String(bytes: payload.dropFirst(2), encoding: .utf8) != nil else {
            throw OpenClawIDBridgeWebSocketError.encoding
        }
    }
}
#endif
