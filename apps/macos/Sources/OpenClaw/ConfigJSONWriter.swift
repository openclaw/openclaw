import Foundation
import OpenClawKit

/// Swift dictionaries do not retain JSON source order. Carry it from the document
/// being edited, including JSON5 files, rather than imposing a new agent order.
enum ConfigJSONWriter {
    static func data(withJSONObject root: [String: Any], preserving source: String) throws -> Data {
        let decoder = JSONDecoder()
        decoder.allowsJSON5 = true
        let original = try decoder.decode([String: OpenClawKit.AnyCodable].self, from: Data(source.utf8))
            .mapValues(\.foundationValue)
        var parser = Parser(source)
        let order = try parser.parse()
        return try Data(self.encode(root, order: order, original: original, depth: 0).utf8)
    }

    private indirect enum Order {
        case object([(String, Order)])
        case array([Order])
        case scalar
    }

    private static func encode(_ value: Any, order: Order, original: Any?, depth: Int) throws -> String {
        let indent = String(repeating: "  ", count: depth)
        let childIndent = indent + "  "
        if let object = value as? [String: Any] {
            let existing: [(String, Order)] = if case let .object(keys) = order {
                keys
            } else { [] }
            let retained = existing.filter { object[$0.0] != nil }
            let known = Set(retained.map(\.0))
            let keys = retained + object.keys.filter { !known.contains($0) }.sorted().map { ($0, Order.scalar) }
            let originalObject = original as? [String: Any]
            if keys.isEmpty { return "{}" }
            let lines = try keys.map { key, childOrder in
                let encodedKey = try self.scalar(key)
                let encodedValue = try self.encode(
                    object[key] ?? NSNull(), order: childOrder, original: originalObject?[key], depth: depth + 1)
                return "\(childIndent)\(encodedKey): \(encodedValue)"
            }
            return "{\n" + lines.joined(separator: ",\n") + "\n\(indent)}"
        }
        if let array = value as? [Any] {
            let existing: [Order] = if case let .array(items) = order {
                items
            } else { [] }
            if array.isEmpty { return "[]" }
            let originalArray = original as? [Any] ?? []
            var available: [OpenClawKit.AnyCodable: [Int]] = [:]
            for (index, item) in originalArray.enumerated() {
                available[OpenClawKit.AnyCodable(item), default: []].append(index)
            }
            // Match retained values first so a deletion or insertion does not lend
            // a surviving object another element's authored key order.
            var matches = array.map { item -> Int? in
                let key = OpenClawKit.AnyCodable(item)
                guard var indices = available[key], !indices.isEmpty else { return nil }
                let index = indices.removeFirst()
                available[key] = indices
                return index
            }
            let retainedIndices = Set(matches.compactMap(\.self))
            for index in matches.indices where matches[index] == nil {
                if array.count == originalArray.count, !retainedIndices.contains(index) {
                    matches[index] = index
                }
            }
            let lines = try array.enumerated().map { index, item in
                let prior = matches[index]
                let childOrder = prior.flatMap { $0 < existing.count ? existing[$0] : nil } ?? .scalar
                return try childIndent + self.encode(
                    item,
                    order: childOrder,
                    original: prior.map { originalArray[$0] },
                    depth: depth + 1)
            }
            return "[\n" + lines.joined(separator: ",\n") + "\n\(indent)]"
        }
        return try self.scalar(value)
    }

    private static func scalar(_ value: Any) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])
        guard let text = String(bytes: data, encoding: .utf8) else {
            throw CocoaError(.fileReadInapplicableStringEncoding)
        }
        return text
    }

    /// Foundation owns JSON5 validation and key decoding. This scanner records
    /// only container order; it never interprets or replaces config values.
    /// Syntax uses scalars so combining marks cannot absorb quote delimiters.
    private struct Parser {
        let scalars: [Unicode.Scalar]
        var index = 0

        init(_ source: String) {
            self.scalars = Array(source.unicodeScalars)
        }

        private var current: Unicode.Scalar? {
            self.index < self.scalars.count ? self.scalars[self.index] : nil
        }

        private func failure() -> Error {
            NSError(domain: "ConfigJSONWriter", code: 1, userInfo: [
                NSLocalizedDescriptionKey:
                    "Cannot preserve configuration key order. Reload the configuration before saving.",
            ])
        }

        mutating func parse() throws -> Order {
            // Do not silently sort a source whose order cannot be recovered.
            let order = try self.value()
            try self.skipTrivia()
            guard self.current == nil else { throw self.failure() }
            return order
        }

        private mutating func skipTrivia() throws {
            while let char = self.current {
                if char.properties.isWhitespace || char == "\u{FEFF}" {
                    self.index += 1
                } else if char == "/", self.index + 1 < self.scalars.count {
                    let next = self.scalars[self.index + 1]
                    if next == "/" {
                        self.index += 2
                        while let char = self.current, !CharacterSet.newlines.contains(char) {
                            self.index += 1
                        }
                    } else if next == "*" {
                        self.index += 2
                        while self.index + 1 < self.scalars.count,
                              !(self.scalars[self.index] == "*" && self.scalars[self.index + 1] == "/")
                        {
                            self.index += 1
                        }
                        guard self.index + 1 < self.scalars.count else { throw self.failure() }
                        self.index += 2
                    } else {
                        return
                    }
                } else {
                    return
                }
            }
        }

        private mutating func quoted() throws -> String {
            guard let quote = self.current else { throw self.failure() }
            let start = self.index
            self.index += 1
            while let char = self.current {
                self.index += 1
                if char == "\\" {
                    guard self.current != nil else { throw self.failure() }
                    self.index += 1
                } else if char == quote {
                    return String(String.UnicodeScalarView(self.scalars[start..<self.index]))
                }
            }
            throw self.failure()
        }

        private mutating func key() throws -> String {
            try self.skipTrivia()
            let token: String
            if self.current == "\"" || self.current == "'" {
                token = try self.quoted()
            } else {
                let start = self.index
                while let char = self.current, char != ":", char != "/", !char.properties.isWhitespace {
                    self.index += 1
                }
                guard self.index > start else { throw self.failure() }
                token = "\"" + String(String.UnicodeScalarView(self.scalars[start..<self.index])) + "\""
            }
            let decoder = JSONDecoder()
            decoder.allowsJSON5 = true
            return try decoder.decode(String.self, from: Data(token.utf8))
        }

        private mutating func value() throws -> Order {
            try self.skipTrivia()
            if self.current == "{" {
                self.index += 1
                var keys: [(String, Order)] = []
                try self.skipTrivia()
                while self.current != "}" {
                    let key = try self.key()
                    try self.skipTrivia()
                    guard self.current == ":" else { throw self.failure() }
                    self.index += 1
                    let order = try self.value()
                    // A repeated property retains its original position.
                    if let existing = keys.firstIndex(where: { $0.0 == key }) {
                        keys[existing] = (key, order)
                    } else {
                        keys.append((key, order))
                    }
                    try self.skipTrivia()
                    if self.current == "}" { break }
                    guard self.current == "," else { throw self.failure() }
                    self.index += 1
                    try self.skipTrivia()
                }
                self.index += 1
                return .object(keys)
            }
            if self.current == "[" {
                self.index += 1
                var items: [Order] = []
                try self.skipTrivia()
                while self.current != "]" {
                    try items.append(self.value())
                    try self.skipTrivia()
                    if self.current == "]" { break }
                    guard self.current == "," else { throw self.failure() }
                    self.index += 1
                    try self.skipTrivia()
                }
                self.index += 1
                return .array(items)
            }
            if self.current == "\"" || self.current == "'" {
                _ = try self.quoted()
            } else {
                let start = self.index
                while let char = self.current, ![",", "}", "]", "/"].contains(char), !char.properties.isWhitespace {
                    self.index += 1
                }
                guard self.index > start else { throw self.failure() }
            }
            return .scalar
        }
    }
}
