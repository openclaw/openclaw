import Foundation

private let legacyDefaultsPrefix = "openclaw."
private let defaultsPrefix = "openclaw."

func migrateLegacyDefaults(
    standard: UserDefaults = .standard,
    isAppBundle: Bool = Bundle.main.bundleURL.pathExtension == "app",
    stableSuite: UserDefaults? = UserDefaults(suiteName: launchdLabel),
    legacySuite: UserDefaults? = UserDefaults(suiteName: legacyLaunchdLabel))
{
    let snapshot = standard.dictionaryRepresentation()
    for (key, value) in snapshot where key.hasPrefix(legacyDefaultsPrefix) {
        let suffix = key.dropFirst(legacyDefaultsPrefix.count)
        let newKey = defaultsPrefix + suffix
        if standard.object(forKey: newKey) == nil {
            standard.set(value, forKey: newKey)
        }
    }

    guard isAppBundle else { return }

    for suite in [stableSuite, legacySuite].compactMap(\.self) {
        for (key, value) in suite.dictionaryRepresentation() where key.hasPrefix(defaultsPrefix) {
            if standard.object(forKey: key) == nil {
                standard.set(value, forKey: key)
            }
        }
    }

    if let stableSuite {
        for (key, value) in standard.dictionaryRepresentation() where key.hasPrefix(defaultsPrefix) {
            if stableSuite.object(forKey: key) == nil {
                stableSuite.set(value, forKey: key)
            }
        }
    }
}

func compatibleDefaultsBool(
    forKey key: String,
    standard: UserDefaults = .standard,
    stableSuite: UserDefaults? = UserDefaults(suiteName: launchdLabel),
    legacySuite: UserDefaults? = UserDefaults(suiteName: legacyLaunchdLabel)) -> Bool
{
    if let value = standard.object(forKey: key) as? Bool {
        return value
    }

    if let value = stableSuite?.object(forKey: key) as? Bool {
        standard.set(value, forKey: key)
        return value
    }

    if let value = legacySuite?.object(forKey: key) as? Bool {
        standard.set(value, forKey: key)
        stableSuite?.set(value, forKey: key)
        return value
    }

    return false
}

func persistCompatibleDefaultsBool(
    _ value: Bool,
    forKey key: String,
    standard: UserDefaults = .standard,
    stableSuite: UserDefaults? = UserDefaults(suiteName: launchdLabel))
{
    standard.set(value, forKey: key)
    stableSuite?.set(value, forKey: key)
}
