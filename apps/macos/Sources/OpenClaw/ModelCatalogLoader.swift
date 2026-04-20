import Foundation

enum ModelCatalogLoader {
    private enum ContainerKind {
        case object
        case array
    }

    private struct ContainerState {
        let kind: ContainerKind
        var expectsObjectKey: Bool
    }

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
        guard let exportRange = self.modelsExportRange(in: source) else {
            return [:]
        }
        guard let objectLiteral = self.extractModelsObjectLiteral(from: source, exportRange: exportRange) else {
            self.logger.error("model catalog parse failed: malformed MODELS export")
            throw self.invalidCatalogError()
        }
        // Keep the loader data-only: normalize the known object-literal subset and let JSON parsing
        // reject anything expression-like instead of executing user-controlled JavaScript.
        let normalized = self.normalizeObjectLiteralForJSON(objectLiteral)
        guard let data = normalized.data(using: .utf8) else {
            self.logger.error("model catalog parse failed: unsupported syntax")
            throw self.invalidCatalogError()
        }
        let object: Any
        do {
            object = try JSONSerialization.jsonObject(with: data)
        } catch {
            self.logger.error("model catalog parse failed: unsupported syntax")
            throw self.invalidCatalogError()
        }
        guard let root = object as? [String: Any] else {
            self.logger.error("model catalog parse failed: MODELS root is not an object")
            throw self.invalidCatalogError()
        }
        return root
    }

    private static func modelsExportRange(in source: String) -> Range<String.Index>? {
        source.range(of: "export const MODELS")
    }

    private static func extractModelsObjectLiteral(
        from source: String,
        exportRange: Range<String.Index>) -> String?
    {
        guard let firstBrace = source[exportRange.upperBound...].firstIndex(of: "{"),
              let lastBrace = self.findMatchingClosingBrace(in: source, openingBrace: firstBrace)
        else {
            return nil
        }
        return String(source[firstBrace...lastBrace])
    }

    private static func findMatchingClosingBrace(in source: String, openingBrace: String.Index) -> String.Index? {
        var depth = 0
        var activeQuote: Character?
        var isEscaping = false
        var index = openingBrace
        while index < source.endIndex {
            let ch = source[index]
            if let quote = activeQuote {
                if isEscaping {
                    isEscaping = false
                } else if ch == "\\" {
                    isEscaping = true
                } else if ch == quote {
                    activeQuote = nil
                }
            } else {
                if ch == "\"" || ch == "'" || ch == "`" {
                    activeQuote = ch
                } else if ch == "{" {
                    depth += 1
                } else if ch == "}" {
                    depth -= 1
                    if depth == 0 {
                        return index
                    }
                }
            }
            index = source.index(after: index)
        }
        return nil
    }

    private static func normalizeObjectLiteralForJSON(_ objectLiteral: String) -> String {
        var body = ""
        var containers: [ContainerState] = []
        var activeQuote: Character?
        var isEscaping = false
        var index = objectLiteral.startIndex

        while index < objectLiteral.endIndex {
            let ch = objectLiteral[index]
            if let quote = activeQuote {
                body.append(ch)
                if isEscaping {
                    isEscaping = false
                } else if ch == "\\" {
                    isEscaping = true
                } else if ch == quote {
                    activeQuote = nil
                }
                index = objectLiteral.index(after: index)
                continue
            }

            if ch == "\"" || ch == "'" || ch == "`" {
                activeQuote = ch
                body.append(ch)
                index = objectLiteral.index(after: index)
                continue
            }

            if let assertionEnd = self.typeAssertionEnd(in: objectLiteral, at: index, containers: containers) {
                index = assertionEnd
                continue
            }

            if self.isNumericSeparator(in: objectLiteral, at: index) {
                index = objectLiteral.index(after: index)
                continue
            }

            if let bareKey = self.readBareObjectKey(in: objectLiteral, at: index, containers: containers) {
                body.append("\"\(bareKey.identifier)\"")
                index = bareKey.endIndex
                continue
            }

            switch ch {
            case "{":
                containers.append(ContainerState(kind: .object, expectsObjectKey: true))
                body.append(ch)
            case "[":
                containers.append(ContainerState(kind: .array, expectsObjectKey: false))
                body.append(ch)
            case "}":
                if !containers.isEmpty {
                    containers.removeLast()
                }
                body.append(ch)
            case "]":
                if !containers.isEmpty {
                    containers.removeLast()
                }
                body.append(ch)
            case ":":
                if let lastIndex = containers.indices.last, containers[lastIndex].kind == .object {
                    containers[lastIndex].expectsObjectKey = false
                }
                body.append(ch)
            case ",":
                if let next = self.nextNonWhitespaceIndex(in: objectLiteral, after: index),
                   objectLiteral[next] == "}" || objectLiteral[next] == "]"
                {
                    index = objectLiteral.index(after: index)
                    continue
                }
                if let lastIndex = containers.indices.last, containers[lastIndex].kind == .object {
                    containers[lastIndex].expectsObjectKey = true
                }
                body.append(ch)
            default:
                body.append(ch)
            }

            index = objectLiteral.index(after: index)
        }

        return body
    }

    private static func nextNonWhitespaceIndex(in source: String, after index: String.Index) -> String.Index? {
        var cursor = source.index(after: index)
        while cursor < source.endIndex {
            if !source[cursor].isWhitespace {
                return cursor
            }
            cursor = source.index(after: cursor)
        }
        return nil
    }

    private static func previousNonWhitespaceIndex(in source: String, before index: String.Index) -> String.Index? {
        guard index > source.startIndex else { return nil }
        var cursor = source.index(before: index)
        while true {
            if !source[cursor].isWhitespace {
                return cursor
            }
            guard cursor > source.startIndex else { return nil }
            cursor = source.index(before: cursor)
        }
    }

    private static func isIdentifierStart(_ ch: Character) -> Bool {
        ch == "_" || ch.isLetter
    }

    private static func isIdentifierBody(_ ch: Character) -> Bool {
        self.isIdentifierStart(ch) || ch.isNumber
    }

    private static func readBareObjectKey(
        in source: String,
        at index: String.Index,
        containers: [ContainerState]) -> (identifier: String, endIndex: String.Index)?
    {
        guard let top = containers.last,
              top.kind == .object,
              top.expectsObjectKey,
              self.isIdentifierStart(source[index])
        else {
            return nil
        }

        var end = source.index(after: index)
        while end < source.endIndex, self.isIdentifierBody(source[end]) {
            end = source.index(after: end)
        }

        var cursor = end
        while cursor < source.endIndex, source[cursor].isWhitespace {
            cursor = source.index(after: cursor)
        }
        guard cursor < source.endIndex, source[cursor] == ":" else { return nil }
        return (String(source[index..<end]), end)
    }

    private static func typeAssertionEnd(
        in source: String,
        at index: String.Index,
        containers: [ContainerState]) -> String.Index?
    {
        if let top = containers.last, top.kind == .object, top.expectsObjectKey {
            return nil
        }
        guard let previous = self.previousNonWhitespaceIndex(in: source, before: index),
              source[previous] != ":"
        else {
            return nil
        }

        let keywordLength: Int
        if self.hasKeyword("as", in: source, at: index) {
            keywordLength = 2
        } else if self.hasKeyword("satisfies", in: source, at: index) {
            keywordLength = 9
        } else {
            return nil
        }

        var cursor = source.index(index, offsetBy: keywordLength)
        guard cursor < source.endIndex, source[cursor].isWhitespace else { return nil }
        while cursor < source.endIndex {
            let ch = source[cursor]
            if ch == "," || ch == "}" || ch == "]" || ch.isNewline {
                return cursor
            }
            cursor = source.index(after: cursor)
        }
        return cursor
    }

    private static func hasKeyword(_ keyword: String, in source: String, at index: String.Index) -> Bool {
        guard source[index...].hasPrefix(keyword) else { return false }
        let end = source.index(index, offsetBy: keyword.count)
        let hasLeftBoundary: Bool
        if index == source.startIndex {
            hasLeftBoundary = true
        } else {
            let previous = source[source.index(before: index)]
            hasLeftBoundary = !self.isIdentifierBody(previous)
        }
        let hasRightBoundary = end == source.endIndex || !self.isIdentifierBody(source[end])
        return hasLeftBoundary && hasRightBoundary
    }

    private static func isNumericSeparator(in source: String, at index: String.Index) -> Bool {
        guard source[index] == "_",
              index > source.startIndex
        else {
            return false
        }
        let previous = source[source.index(before: index)]
        let next = source.index(after: index)
        guard next < source.endIndex else { return false }
        return previous.isNumber && source[next].isNumber
    }

    private static func invalidCatalogError() -> NSError {
        NSError(
            domain: "ModelCatalogLoader",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "Failed to parse models.generated.ts"])
    }
}
