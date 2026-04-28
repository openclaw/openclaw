import Foundation

enum ModelCatalogLoader {
    static var defaultPath: String {
        self.resolveDefaultPath()
    }

    private static let logger = Logger(subsystem: "ai.openclaw", category: "models")
    private nonisolated static let appSupportDir: URL = {
        let base = FileManager().urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return base.appendingPathComponent("OpenClaw", isDirectory: true)
    }()

    private static var cachePath: URL {
        self.appSupportDir.appendingPathComponent("model-catalog/models.generated.js", isDirectory: false)
    }

    static func load(from path: String) async throws -> [ModelChoice] {
        let expanded = (path as NSString).expandingTildeInPath
        guard let resolved = self.resolvePath(preferred: expanded) else {
            self.logger.error("model catalog load failed: file not found")
            throw NSError(
                domain: "ModelCatalogLoader",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Model catalog file not found"])
        }
        self.logger.debug("model catalog load start file=\(URL(fileURLWithPath: resolved.path).lastPathComponent)")
        let source = try String(contentsOfFile: resolved.path, encoding: .utf8)
        let rawModels = try self.parseModels(source: source)

        var choices: [ModelChoice] = []
        for (provider, value) in rawModels {
            guard let models = value as? [String: Any] else { continue }
            for (id, payload) in models {
                guard let dict = payload as? [String: Any] else { continue }
                let name = dict["name"] as? String ?? id
                let ctxWindow = dict["contextWindow"] as? Int
                choices.append(ModelChoice(id: id, name: name, provider: provider, contextWindow: ctxWindow))
            }
        }

        let sorted = choices.sorted { lhs, rhs in
            if lhs.provider == rhs.provider {
                return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
            }
            return lhs.provider.localizedCaseInsensitiveCompare(rhs.provider) == .orderedAscending
        }
        self.logger.debug("model catalog loaded providers=\(rawModels.count) models=\(sorted.count)")
        if resolved.shouldCache {
            self.cacheCatalog(sourcePath: resolved.path)
        }
        return sorted
    }

    private static func resolveDefaultPath() -> String {
        let cache = self.cachePath.path
        if FileManager().isReadableFile(atPath: cache) { return cache }
        if let bundlePath = self.bundleCatalogPath() { return bundlePath }
        if let nodePath = self.nodeModulesCatalogPath() { return nodePath }
        return cache
    }

    private static func resolvePath(preferred: String) -> (path: String, shouldCache: Bool)? {
        if FileManager().isReadableFile(atPath: preferred) {
            return (preferred, preferred != self.cachePath.path)
        }

        if let bundlePath = self.bundleCatalogPath(), bundlePath != preferred {
            self.logger.warning("model catalog path missing; falling back to bundled catalog")
            return (bundlePath, true)
        }

        let cache = self.cachePath.path
        if cache != preferred, FileManager().isReadableFile(atPath: cache) {
            self.logger.warning("model catalog path missing; falling back to cached catalog")
            return (cache, false)
        }

        if let nodePath = self.nodeModulesCatalogPath(), nodePath != preferred {
            self.logger.warning("model catalog path missing; falling back to node_modules catalog")
            return (nodePath, true)
        }

        return nil
    }

    private static func bundleCatalogPath() -> String? {
        guard let url = Bundle.main.url(forResource: "models.generated", withExtension: "js") else {
            return nil
        }
        return url.path
    }

    private static func nodeModulesCatalogPath() -> String? {
        let roots = [
            URL(fileURLWithPath: CommandResolver.projectRootPath()),
            URL(fileURLWithPath: FileManager().currentDirectoryPath),
        ]
        for root in roots {
            let candidate = root
                .appendingPathComponent("node_modules/@mariozechner/pi-ai/dist/models.generated.js")
            if FileManager().isReadableFile(atPath: candidate.path) {
                return candidate.path
            }
        }
        return nil
    }

    private static func cacheCatalog(sourcePath: String) {
        let destination = self.cachePath
        do {
            try FileManager().createDirectory(
                at: destination.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            if FileManager().fileExists(atPath: destination.path) {
                try FileManager().removeItem(at: destination)
            }
            try FileManager().copyItem(atPath: sourcePath, toPath: destination.path)
            self.logger.debug("model catalog cached file=\(destination.lastPathComponent)")
        } catch {
            self.logger.warning("model catalog cache failed: \(error.localizedDescription)")
        }
    }

    private static func parseModels(source: String) throws -> [String: Any] {
        guard let exportRange = source.range(
            of: #"export\s+const\s+MODELS\s*="#,
            options: .regularExpression)
        else {
            return [:]
        }
        guard let firstBrace = source[exportRange.upperBound...].firstIndex(of: "{") else {
            throw ModelCatalogParseError.expectedObject
        }
        var parser = ModelCatalogObjectParser(source: String(source[firstBrace...]))
        return try parser.parseObject()
    }
}

private enum ModelCatalogParseError: Error {
    case expectedObject
    case expectedKey
    case expectedColon
    case expectedValue
    case unterminatedString
    case invalidNumber
    case unexpectedToken
}

private struct ModelCatalogObjectParser {
    private let source: String
    private var index: String.Index

    init(source: String) {
        self.source = source
        self.index = source.startIndex
    }

    mutating func parseObject() throws -> [String: Any] {
        try self.consume("{", or: .expectedObject)
        var result: [String: Any] = [:]

        while true {
            self.skipWhitespaceAndComments()
            if self.consumeIf("}") {
                return result
            }

            let key = try self.parseKey()
            self.skipWhitespaceAndComments()
            try self.consume(":", or: .expectedColon)
            let value = try self.parseValue()
            self.skipTypeAssertion()
            result[key] = value

            self.skipWhitespaceAndComments()
            if self.consumeIf(",") {
                continue
            }
            if self.consumeIf("}") {
                return result
            }
            throw ModelCatalogParseError.unexpectedToken
        }
    }

    private mutating func parseArray() throws -> [Any] {
        try self.consume("[", or: .expectedValue)
        var result: [Any] = []

        while true {
            self.skipWhitespaceAndComments()
            if self.consumeIf("]") {
                return result
            }

            result.append(try self.parseValue())
            self.skipTypeAssertion()
            self.skipWhitespaceAndComments()
            if self.consumeIf(",") {
                continue
            }
            if self.consumeIf("]") {
                return result
            }
            throw ModelCatalogParseError.unexpectedToken
        }
    }

    private mutating func parseValue() throws -> Any {
        self.skipWhitespaceAndComments()
        guard let char = self.current else {
            throw ModelCatalogParseError.expectedValue
        }

        switch char {
        case "{":
            return try self.parseObject()
        case "[":
            return try self.parseArray()
        case "\"", "'":
            return try self.parseString()
        case "-", "0"..."9":
            return try self.parseNumber()
        default:
            let identifier = try self.parseIdentifier()
            switch identifier {
            case "true":
                return true
            case "false":
                return false
            case "null", "undefined":
                return NSNull()
            default:
                return identifier
            }
        }
    }

    private mutating func parseKey() throws -> String {
        self.skipWhitespaceAndComments()
        guard let char = self.current else {
            throw ModelCatalogParseError.expectedKey
        }
        if char == "\"" || char == "'" {
            return try self.parseString()
        }
        return try self.parseIdentifier()
    }

    private mutating func parseIdentifier() throws -> String {
        self.skipWhitespaceAndComments()
        let start = self.index
        while let char = self.current, self.isIdentifierCharacter(char) {
            self.advance()
        }
        guard start != self.index else {
            throw ModelCatalogParseError.expectedKey
        }
        return String(self.source[start..<self.index])
    }

    private mutating func parseString() throws -> String {
        guard let quote = self.current, quote == "\"" || quote == "'" else {
            throw ModelCatalogParseError.expectedValue
        }
        self.advance()

        var result = ""
        while let char = self.current {
            self.advance()
            if char == quote {
                return result
            }
            if char == "\\" {
                result.append(try self.parseEscapedCharacter())
            } else {
                result.append(char)
            }
        }
        throw ModelCatalogParseError.unterminatedString
    }

    private mutating func parseEscapedCharacter() throws -> Character {
        guard let char = self.current else {
            throw ModelCatalogParseError.unterminatedString
        }
        self.advance()

        switch char {
        case "\"", "'", "\\", "/":
            return char
        case "b":
            return "\u{08}"
        case "f":
            return "\u{0c}"
        case "n":
            return "\n"
        case "r":
            return "\r"
        case "t":
            return "\t"
        case "u":
            return try self.parseUnicodeEscape()
        default:
            return char
        }
    }

    private mutating func parseUnicodeEscape() throws -> Character {
        var hex = ""
        for _ in 0..<4 {
            guard let char = self.current else {
                throw ModelCatalogParseError.unterminatedString
            }
            hex.append(char)
            self.advance()
        }
        guard let value = UInt32(hex, radix: 16),
              let scalar = UnicodeScalar(value)
        else {
            throw ModelCatalogParseError.unterminatedString
        }
        return Character(scalar)
    }

    private mutating func parseNumber() throws -> Any {
        let start = self.index
        if self.current == "-" {
            self.advance()
        }
        while let char = self.current, ("0"..."9").contains(char) {
            self.advance()
        }
        var isFloatingPoint = false
        if self.current == "." {
            isFloatingPoint = true
            self.advance()
            while let char = self.current, ("0"..."9").contains(char) {
                self.advance()
            }
        }
        if self.current == "e" || self.current == "E" {
            isFloatingPoint = true
            self.advance()
            if self.current == "-" || self.current == "+" {
                self.advance()
            }
            while let char = self.current, ("0"..."9").contains(char) {
                self.advance()
            }
        }

        let raw = String(self.source[start..<self.index])
        if !isFloatingPoint, let int = Int(raw) {
            return int
        }
        if let double = Double(raw) {
            return double
        }
        throw ModelCatalogParseError.invalidNumber
    }

    private mutating func skipTypeAssertion() {
        while true {
            self.skipWhitespaceAndComments()
            if self.consumeKeyword("satisfies") || self.consumeKeyword("as") {
                self.skipTypeExpression()
            } else {
                return
            }
        }
    }

    private mutating func skipTypeExpression() {
        while let char = self.current {
            if char == "," || char == "}" || char == "]" {
                return
            }
            self.advance()
        }
    }

    private mutating func skipWhitespaceAndComments() {
        while true {
            while let char = self.current, char.isWhitespace {
                self.advance()
            }
            if self.consumeIf("//") {
                while let char = self.current, char != "\n" {
                    self.advance()
                }
                continue
            }
            if self.consumeIf("/*") {
                while self.index < self.source.endIndex, !self.consumeIf("*/") {
                    self.advance()
                }
                continue
            }
            return
        }
    }

    private mutating func consume(_ token: String, or error: ModelCatalogParseError) throws {
        self.skipWhitespaceAndComments()
        guard self.consumeIf(token) else {
            throw error
        }
    }

    private mutating func consumeIf(_ token: String) -> Bool {
        guard self.source[index...].hasPrefix(token) else {
            return false
        }
        self.index = self.source.index(self.index, offsetBy: token.count)
        return true
    }

    private mutating func consumeKeyword(_ keyword: String) -> Bool {
        guard self.source[index...].hasPrefix(keyword) else {
            return false
        }
        let end = self.source.index(self.index, offsetBy: keyword.count)
        if end < self.source.endIndex, self.isIdentifierCharacter(self.source[end]) {
            return false
        }
        self.index = end
        return true
    }

    private var current: Character? {
        guard self.index < self.source.endIndex else {
            return nil
        }
        return self.source[self.index]
    }

    private mutating func advance() {
        self.index = self.source.index(after: self.index)
    }

    private func isIdentifierCharacter(_ char: Character) -> Bool {
        char.isLetter || char.isNumber || char == "_" || char == "$"
    }
}
