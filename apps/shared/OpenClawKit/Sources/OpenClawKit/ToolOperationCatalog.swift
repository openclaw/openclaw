import Foundation

/// The Control UI's English wording for tool rows, generated from its locale catalogs
/// (`scripts/tool-operations.ts`). Swift reads it; the web owns it.
public enum ToolOperationCatalog {
    /// Read once from the bundle and never written, so sharing it across threads is safe.
    public nonisolated(unsafe) static let labels: [String: Any] = {
        guard let url = ToolDisplayRegistry.resourceBundle.url(forResource: "tool-operations", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return [:] }
        return root["labels"] as? [String: Any] ?? [:]
    }()

    /// The string at a dotted path, with `{name}` placeholders filled. Nil when the catalog has no such entry.
    public static func text(_ path: String, _ values: [String: String] = [:]) -> String? {
        var node: Any? = self.labels
        for part in path.split(separator: ".") {
            node = (node as? [String: Any])?[String(part)]
        }
        guard var text = node as? String else { return nil }
        for (key, value) in values {
            text = text.replacingOccurrences(of: "{\(key)}", with: value)
        }
        return text
    }

    public static func entry(_ path: String) -> [String: Any]? {
        var node: Any? = self.labels
        for part in path.split(separator: ".") {
            node = (node as? [String: Any])?[String(part)]
        }
        return node as? [String: Any]
    }
}
