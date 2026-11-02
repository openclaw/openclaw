import Foundation

/// Persists custom session group names so a group without members survives
/// refreshes and stays usable as a move target. Mirrors the web sidebar's
/// localStorage-backed list; assigned groups still persist server-side via
/// the session category field.
enum SessionGroupStore {
    static let defaultsKey = "openclaw:sessions:custom-groups"

    static func load(defaults: UserDefaults = .standard) -> [String] {
        self.normalized(defaults.stringArray(forKey: self.defaultsKey) ?? [])
    }

    static func save(_ groups: [String], defaults: UserDefaults = .standard) {
        defaults.set(self.normalized(groups), forKey: self.defaultsKey)
    }

    static func clear(defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: self.defaultsKey)
    }

    /// Which groups are folded on this device. Like the web sidebar's collapsed sections, never sent to the Gateway.
    static let collapsedKey = "openclaw:sessions:collapsed-groups"

    static func loadCollapsed(defaults: UserDefaults = .standard) -> Set<String> {
        Set(defaults.stringArray(forKey: self.collapsedKey) ?? [])
    }

    static func saveCollapsed(_ names: Set<String>, defaults: UserDefaults = .standard) {
        defaults.set(names.sorted(), forKey: self.collapsedKey)
    }

    static func remember(_ name: String, defaults: UserDefaults = .standard) {
        self.save(self.adding(self.load(defaults: defaults), name), defaults: defaults)
    }

    static func normalized(_ groups: [String]) -> [String] {
        var seen = Set<String>()
        return groups
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    static func adding(_ groups: [String], _ name: String) -> [String] {
        self.normalized(groups + [name])
    }

    /// Web parity: replace the old name in place when stored; otherwise append
    /// the new name so renaming a live-only group still persists it.
    static func renaming(_ groups: [String], from oldName: String, to newName: String) -> [String] {
        let renamed = groups.contains(oldName)
            ? groups.map { $0 == oldName ? newName : $0 }
            : groups + [newName]
        return self.normalized(renamed)
    }

    static func removing(_ groups: [String], _ name: String) -> [String] {
        self.normalized(groups.filter { $0 != name })
    }
}
