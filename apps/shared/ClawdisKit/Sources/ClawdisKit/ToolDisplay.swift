import Foundation

public struct ToolDisplaySummary: Sendable, Equatable {
    public let name: String
    public let emoji: String
    public let title: String
    public let label: String
    public let verb: String?
    public let detail: String?

    public var detailLine: String? {
        var parts: [String] = []
        if let verb, !verb.isEmpty { parts.append(verb) }
        if let detail, !detail.isEmpty { parts.append(detail) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    public var summaryLine: String {
        if let detailLine {
            return "\(emoji) \(label): \(detailLine)"
        }
        return "\(emoji) \(label)"
    }
}

public enum ToolDisplayRegistry {
    private struct ToolDisplayActionSpec: Decodable {
        let label: String?
        let detailKeys: [String]?
    }

    private struct ToolDisplaySpec: Decodable {
        let emoji: String?
        let title: String?
        let label: String?
        let detailKeys: [String]?
        let actions: [String: ToolDisplayActionSpec]?
    }

    private struct ToolDisplayConfig: Decodable {
        let version: Int?
        let fallback: ToolDisplaySpec?
        let tools: [String: ToolDisplaySpec]?
    }

    private static let config: ToolDisplayConfig = loadConfig()

    public static func resolve(name: String?, args: AnyCodable?, meta: String? = nil) -> ToolDisplaySummary {
        let trimmedName = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "tool"
        let key = trimmedName.lowercased()
        let spec = config.tools?[key]
        let fallback = config.fallback

        let emoji = spec?.emoji ?? fallback?.emoji ?? "🧩"
        let title = spec?.title ?? titleFromName(trimmedName)
        let label = spec?.label ?? trimmedName

        let actionRaw = valueForKeyPath(args, path: "action") as? String
        let action = actionRaw?.trimmingCharacters(in: .whitespacesAndNewlines)
        let actionSpec = action.flatMap { spec?.actions?[$0] }
        let verb = normalizeVerb(actionSpec?.label ?? action)

        var detail: String?
        if key == "read" {
            detail = readDetail(args)
        } else if key == "write" || key == "edit" || key == "attach" {
            detail = pathDetail(args)
        }

        let detailKeys = actionSpec?.detailKeys ?? spec?.detailKeys ?? fallback?.detailKeys ?? []
        if detail == nil {
            detail = firstValue(args, keys: detailKeys)
        }

        if detail == nil {
            detail = meta
        }

        if let detailValue = detail {
            detail = shortenHomeInString(detailValue)
        }

        return ToolDisplaySummary(
            name: trimmedName,
            emoji: emoji,
            title: title,
            label: label,
            verb: verb,
            detail: detail)
    }

    private static func loadConfig() -> ToolDisplayConfig {
        guard let url = ClawdisKitResources.bundle.url(forResource: "tool-display", withExtension: "json") else {
            return ToolDisplayConfig(version: nil, fallback: nil, tools: nil)
        }
        do {
            let data = try Data(contentsOf: url)
            return try JSONDecoder().decode(ToolDisplayConfig.self, from: data)
        } catch {
            return ToolDisplayConfig(version: nil, fallback: nil, tools: nil)
        }
    }

    private static func titleFromName(_ name: String) -> String {
        let cleaned = name.replacingOccurrences(of: "_", with: " ").trimmingCharacters(in: .whitespaces)
        guard !cleaned.isEmpty else { return "Tool" }
        return cleaned
            .split(separator: " ")
            .map { part in
                let upper = part.uppercased()
                if part.count <= 2 && part == upper { return String(part) }
                return String(upper.prefix(1)) + String(part.lowercased().dropFirst())
            }
            .joined(separator: " ")
    }

    private static func normalizeVerb(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty else { return nil }
        return trimmed.replacingOccurrences(of: "_", with: " ")
    }

    private static func readDetail(_ args: AnyCodable?) -> String? {
        guard let path = valueForKeyPath(args, path: "path") as? String else { return nil }
        let offset = valueForKeyPath(args, path: "offset") as? Double
        let limit = valueForKeyPath(args, path: "limit") as? Double
        if let offset, let limit {
            let end = offset + limit
            return "\(path):\(Int(offset))-\(Int(end))"
        }
        return path
    }

    private static func pathDetail(_ args: AnyCodable?) -> String? {
        return valueForKeyPath(args, path: "path") as? String
    }

    private static func firstValue(_ args: AnyCodable?, keys: [String]) -> String? {
        for key in keys {
            if let value = valueForKeyPath(args, path: key),
               let rendered = renderValue(value)
            {
                return rendered
            }
        }
        return nil
    }

    private static func renderValue(_ value: Any) -> String? {
        if let str = value as? String {
            let trimmed = str.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return nil }
            let first = trimmed.split(whereSeparator: \.isNewline).first.map(String.init) ?? trimmed
            if first.count > 160 { return String(first.prefix(157)) + "…" }
            return first
        }
        if let num = value as? Int { return String(num) }
        if let num = value as? Double { return String(num) }
        if let bool = value as? Bool { return bool ? "true" : "false" }
        if let array = value as? [Any] {
            let items = array.compactMap { renderValue($0) }
            guard !items.isEmpty else { return nil }
            let preview = items.prefix(3).joined(separator: ", ")
            return items.count > 3 ? "\(preview)…" : preview
        }
        if let dict = value as? [String: Any] {
            if let label = dict["name"].flatMap({ renderValue($0) }) { return label }
            if let label = dict["id"].flatMap({ renderValue($0) }) { return label }
        }
        return nil
    }

    private static func valueForKeyPath(_ args: AnyCodable?, path: String) -> Any? {
        guard let args else { return nil }
        let parts = path.split(separator: ".").map(String.init)
        var current: Any? = args.value
        for part in parts {
            if let dict = current as? [String: AnyCodable] {
                current = dict[part]?.value
            } else if let dict = current as? [String: Any] {
                current = dict[part]
            } else {
                return nil
            }
        }
        return current
    }

    private static func shortenHomeInString(_ value: String) -> String {
        let home = NSHomeDirectory()
        guard !home.isEmpty else { return value }
        return value.replacingOccurrences(of: home, with: "~")
    }
}
