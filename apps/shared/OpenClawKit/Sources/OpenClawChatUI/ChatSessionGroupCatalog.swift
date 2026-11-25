import Foundation

/// Shared catalog order, with session categories retained when the catalog is unavailable or incomplete.
public enum OpenClawChatSessionGroupCatalog {
    public static func names(
        catalog: [OpenClawChatSessionGroup]?,
        local: [String],
        sessions: [OpenClawChatSessionEntry]) -> [String]
    {
        let ordered = catalog?.sorted {
            $0.position == $1.position ? $0.name < $1.name : $0.position < $1.position
        }.map(\.name) ?? local
        let categories = sessions.compactMap(\.category).sorted()
        var seen = Set<String>()
        return (ordered + categories).compactMap { name in
            let value = name.trimmingCharacters(in: .whitespacesAndNewlines)
            return !value.isEmpty && seen.insert(value).inserted ? value : nil
        }
    }

    public static func moving(_ name: String, by offset: Int, in names: [String]) -> [String] {
        guard let index = names.firstIndex(of: name), names.indices.contains(index + offset) else { return names }
        var result = names
        result.swapAt(index, index + offset)
        return result
    }
}
