import Foundation

private let legacyDefaultsPrefix = "openclaw."
private let defaultsPrefix = "openclaw."

func migrateLegacyDefaults() {
    let defaults = UserDefaults.standard
    let snapshot = defaults.dictionaryRepresentation()
    for (key, value) in snapshot where key.hasPrefix(legacyDefaultsPrefix) {
        let suffix = key.dropFirst(legacyDefaultsPrefix.count)
        let newKey = defaultsPrefix + suffix
        if defaults.object(forKey: newKey) == nil {
            defaults.set(value, forKey: newKey)
        }
    }
}
