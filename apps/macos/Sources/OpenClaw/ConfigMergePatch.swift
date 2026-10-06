import Foundation
import OpenClawKit

/// Match the Gateway's RFC 7396 patch contract. Explicit array replacement
/// retains a document edit's intent instead of invoking ID-keyed array upserts.
enum ConfigMergePatch {
    struct Result {
        var root: [String: Any] = [:]
        var replacePaths: [String] = []
    }

    static func between(_ baseline: [String: Any], and edited: [String: Any], path: String = "") -> Result {
        var result = Result()
        for key in Set(baseline.keys).union(edited.keys).sorted() {
            let childPath = path.isEmpty ? key : "\(path).\(key)"
            guard let next = edited[key] else {
                result.root[key] = NSNull()
                result.replacePaths += self.arrayPaths(in: baseline[key], path: childPath)
                continue
            }
            let previous = baseline[key]
            if let previous, OpenClawKit.AnyCodable(previous) == OpenClawKit.AnyCodable(next) { continue }
            if let previous = previous as? [String: Any], let next = next as? [String: Any] {
                let child = self.between(previous, and: next, path: childPath)
                result.root[key] = child.root
                result.replacePaths += child.replacePaths
            } else {
                result.root[key] = next
                result.replacePaths += self.arrayPaths(in: previous, path: childPath)
            }
        }
        return result
    }

    private static func arrayPaths(in value: Any?, path: String) -> [String] {
        if value is [Any] { return [path] }
        guard let object = value as? [String: Any] else { return [] }
        return object.keys.sorted().flatMap { self.arrayPaths(in: object[$0], path: "\(path).\($0)") }
    }
}
