import Foundation
import JavaScriptCore

enum ModelCatalogLoader {
    static let defaultPath: String = FileManager().homeDirectoryForCurrentUser
        .appendingPathComponent("Projects/pi-mono/packages/ai/src/models.generated.ts").path
    private static let logger = Logger(subsystem: "com.clawdbot", category: "models")

    static func load(from path: String) async throws -> [ModelChoice] {
        let expanded = (path as NSString).expandingTildeInPath
        self.logger.debug("model catalog load start file=\(URL(fileURLWithPath: expanded).lastPathComponent)")
        let source = try String(contentsOfFile: expanded, encoding: .utf8)
        let sanitized = self.sanitize(source: source)

        let ctx = JSContext()
        ctx?.exceptionHandler = { _, exception in
            if let exception {
                self.logger.warning("model catalog JS exception: \(exception)")
            }
        }
        ctx?.evaluateScript(sanitized)
        guard let rawModels = ctx?.objectForKeyedSubscript("MODELS")?.toDictionary() as? [String: Any] else {
            self.logger.error("model catalog parse failed: MODELS missing")
            throw NSError(
                domain: "ModelCatalogLoader",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Failed to parse models.generated.ts"])
        }

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
        return sorted
    }

    private static func sanitize(source: String) -> String {
        guard let exportRange = source.range(of: "export const MODELS"),
              let firstBrace = source[exportRange.upperBound...].firstIndex(of: "{"),
              let lastBrace = source.lastIndex(of: "}")
        else {
            return "var MODELS = {}"
        }
        var body = String(source[firstBrace...lastBrace])
        body = body.replacingOccurrences(
            of: #"(?m)\bsatisfies\s+[^,}\n]+"#,
            with: "",
            options: .regularExpression)
        body = body.replacingOccurrences(
            of: #"(?m)\bas\s+[^;,\n]+"#,
            with: "",
            options: .regularExpression)
        return "var MODELS = \(body);"
    }
}
