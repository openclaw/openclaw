import Foundation

/// Strict JSON for the protocol's integer-only signed schemas, with RFC 8785 key/string encoding.
/// Floating-point values are intentionally refused: none of the supported signed schemas permits them.
indirect enum OpenClawIDCanonicalJSON: Sendable, Equatable {
    case object([String: Self]), array([Self]), string(String), integer(Int64), bool(Bool), null

    static func parse(_ data: Data) throws -> Self {
        guard data.count <= 1_048_576, let text = String(bytes: data, encoding: .utf8) else {
            throw OpenClawIDNodeEnrollmentError.malformed
        }
        var parser = Parser(bytes: Array(text.utf8))
        let result = try parser.value(depth: 0)
        parser.space()
        guard parser.index == parser.bytes.count else { throw OpenClawIDNodeEnrollmentError.malformed }
        return result
    }

    var encoded: Data {
        Data(self.canonical.utf8)
    }

    var canonical: String {
        switch self {
        case let .object(fields):
            let keys = fields.keys.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
            return "{" + keys.map { Self.quote($0) + ":" + fields[$0]!.canonical }.joined(separator: ",") + "}"
        case let .array(items): return "[" + items.map(\.canonical).joined(separator: ",") + "]"
        case let .string(value): return Self.quote(value)
        case let .integer(value): return String(value)
        case let .bool(value): return value ? "true" : "false"
        case .null: return "null"
        }
    }

    func fields(_ names: Set<String>, optional: Set<String> = []) throws -> [String: Self] {
        guard case let .object(fields) = self, names.isSubset(of: Set(fields.keys)),
              Set(fields.keys).isSubset(of: names.union(optional))
        else {
            throw OpenClawIDNodeEnrollmentError.malformed
        }
        return fields
    }

    func text() throws -> String {
        guard case let .string(value) = self else { throw OpenClawIDNodeEnrollmentError.malformed }
        return value
    }

    func number(minimum: Int64 = 0) throws -> Int64 {
        guard case let .integer(value) = self, value >= minimum, value <= 9_007_199_254_740_991 else {
            throw OpenClawIDNodeEnrollmentError.malformed
        }
        return value
    }

    func list(maximum: Int = 256) throws -> [Self] {
        guard case let .array(value) = self, value.count <= maximum else {
            throw OpenClawIDNodeEnrollmentError.malformed
        }
        return value
    }

    private static func quote(_ value: String) -> String {
        var result = "\""
        for scalar in value.unicodeScalars {
            switch scalar.value {
            case 34: result += "\\\""
            case 92: result += "\\\\"
            case 8: result += "\\b"
            case 9: result += "\\t"
            case 10: result += "\\n"
            case 12: result += "\\f"
            case 13: result += "\\r"
            case 0...31: result += String(format: "\\u%04x", scalar.value)
            default: result.unicodeScalars.append(scalar)
            }
        }
        return result + "\""
    }

    /// A bounded parser is needed because JSONDecoder/JSONSerialization discard duplicate members.
    private struct Parser {
        let bytes: [UInt8]
        var index = 0

        mutating func space() {
            while self.index < self.bytes.count, [9, 10, 13, 32].contains(self.bytes[self.index]) {
                self.index += 1
            }
        }

        mutating func consume(_ byte: UInt8) -> Bool {
            self.space()
            guard self.index < self.bytes.count, self.bytes[self.index] == byte else { return false }
            self.index += 1
            return true
        }

        mutating func value(depth: Int) throws -> OpenClawIDCanonicalJSON {
            self.space()
            guard depth <= 32, self.index < self.bytes.count else { throw OpenClawIDNodeEnrollmentError.malformed }
            switch self.bytes[self.index] {
            case 123:
                self.index += 1
                var fields: [String: OpenClawIDCanonicalJSON] = [:]
                if self.consume(125) { return .object(fields) }
                repeat {
                    let key = try string()
                    guard fields[key] == nil, self.consume(58) else { throw OpenClawIDNodeEnrollmentError.malformed }
                    fields[key] = try self.value(depth: depth + 1)
                    if self.consume(125) { return .object(fields) }
                } while self.consume(44)
            case 91:
                self.index += 1
                var items: [OpenClawIDCanonicalJSON] = []
                if self.consume(93) { return .array(items) }
                repeat {
                    guard items.count < 4096 else { throw OpenClawIDNodeEnrollmentError.malformed }
                    try items.append(self.value(depth: depth + 1))
                    if self.consume(93) { return .array(items) }
                } while self.consume(44)
            case 34: return try .string(self.string())
            case 116: return try self.literal("true", result: .bool(true))
            case 102: return try self.literal("false", result: .bool(false))
            case 110: return try self.literal("null", result: .null)
            default:
                let start = self.index
                if self.bytes[self.index] == 45 { self.index += 1 }
                while self.index < self.bytes.count, (48...57).contains(self.bytes[self.index]) {
                    self.index += 1
                }
                guard let text = String(bytes: bytes[start..<self.index], encoding: .utf8) else {
                    throw OpenClawIDNodeEnrollmentError.malformed
                }
                let digits = text.hasPrefix("-") ? String(text.dropFirst()) : text
                guard !digits.isEmpty, digits.count == 1 || !digits.hasPrefix("0"),
                      let number = Int64(text), number >= -9_007_199_254_740_991, number <= 9_007_199_254_740_991
                else { throw OpenClawIDNodeEnrollmentError.malformed }
                return .integer(number)
            }
            throw OpenClawIDNodeEnrollmentError.malformed
        }

        mutating func literal(_ text: String, result: OpenClawIDCanonicalJSON) throws -> OpenClawIDCanonicalJSON {
            let expected = Array(text.utf8)
            guard self.index + expected.count <= self.bytes.count,
                  Array(self.bytes[self.index..<(self.index + expected.count)]) == expected
            else { throw OpenClawIDNodeEnrollmentError.malformed }
            self.index += expected.count
            return result
        }

        mutating func string() throws -> String {
            guard self.consume(34) else { throw OpenClawIDNodeEnrollmentError.malformed }
            var result = Data()
            while self.index < self.bytes.count {
                let byte = self.bytes[self.index]
                self.index += 1
                if byte == 34 {
                    guard let text = String(bytes: result, encoding: .utf8) else {
                        throw OpenClawIDNodeEnrollmentError.malformed
                    }
                    return text
                }
                guard byte >= 32 else { throw OpenClawIDNodeEnrollmentError.malformed }
                if byte != 92 { result.append(byte)
                    continue
                }
                guard self.index < self.bytes.count else { throw OpenClawIDNodeEnrollmentError.malformed }
                let escaped = self.bytes[self.index]
                self.index += 1
                switch escaped {
                case 34, 47, 92: result.append(escaped)
                case 98: result.append(8)
                case 102: result.append(12)
                case 110: result.append(10)
                case 114: result.append(13)
                case 116: result.append(9)
                case 117:
                    var scalar = try hexScalar()
                    if (0xD800...0xDBFF).contains(scalar) {
                        guard self.index + 2 <= self.bytes.count, self.bytes[self.index] == 92,
                              self.bytes[self.index + 1] == 117
                        else {
                            throw OpenClawIDNodeEnrollmentError.malformed
                        }
                        self.index += 2
                        let low = try hexScalar()
                        guard (0xDC00...0xDFFF).contains(low) else { throw OpenClawIDNodeEnrollmentError.malformed }
                        scalar = 0x10000 + ((scalar - 0xD800) << 10) + low - 0xDC00
                    }
                    guard let unicode = UnicodeScalar(scalar) else { throw OpenClawIDNodeEnrollmentError.malformed }
                    result.append(contentsOf: String(unicode).utf8)
                default: throw OpenClawIDNodeEnrollmentError.malformed
                }
            }
            throw OpenClawIDNodeEnrollmentError.malformed
        }

        mutating func hexScalar() throws -> UInt32 {
            guard self.index + 4 <= self.bytes.count else { throw OpenClawIDNodeEnrollmentError.malformed }
            let digits = self.bytes[self.index..<(self.index + 4)]
            guard digits.allSatisfy({ (48...57).contains($0) || (65...70).contains($0) || (97...102).contains($0) }),
                  let text = String(bytes: digits, encoding: .utf8),
                  let value = UInt32(text, radix: 16)
            else { throw OpenClawIDNodeEnrollmentError.malformed }
            self.index += 4
            return value
        }
    }
}
