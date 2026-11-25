import Foundation

public struct TalkProviderConfigSelection: Sendable {
    public let provider: String
    public let config: [String: AnyCodable]
    public let normalizedPayload: Bool

    public init(provider: String, config: [String: AnyCodable], normalizedPayload: Bool) {
        self.provider = provider
        self.config = config
        self.normalizedPayload = normalizedPayload
    }
}

public enum TalkConfigParsing {
    public static func bridgeFoundationDictionary(_ raw: [String: Any]?) -> [String: AnyCodable]? {
        raw?.mapValues(AnyCodable.init)
    }

    /// Rem-Assistant/Rem's voice settings consume this API through its OpenClaw fork.
    /// Keep it public until that consumer migrates.
    public static func selectProviderConfig(
        _ talk: [String: AnyCodable]?,
        defaultProvider: String,
        allowLegacyFallback: Bool = true) -> TalkProviderConfigSelection?
    {
        guard let talk else { return nil }
        if let resolved = talk["resolved"]?.dictionaryValue,
           let providerID = resolved["provider"]?.stringValue?.trimmedNonEmpty?.lowercased()
        {
            return TalkProviderConfigSelection(
                provider: providerID,
                config: resolved["config"]?.dictionaryValue ?? [:],
                normalizedPayload: true)
        }
        guard allowLegacyFallback, talk["provider"] == nil, talk["providers"] == nil else { return nil }
        return TalkProviderConfigSelection(
            provider: defaultProvider,
            config: talk,
            normalizedPayload: false)
    }

    public static func firstNonEmptyString(
        _ config: [String: AnyCodable]?,
        keys: [String]) -> String?
    {
        guard let config else { return nil }
        for key in keys {
            if let value = config[key]?.stringValue?.trimmedNonEmpty { return value }
        }
        return nil
    }

    static func singleRealtimeProviderID(_ providers: [String: AnyCodable]?) -> String? {
        guard let providers, providers.count == 1 else { return nil }
        return providers.keys.first?.trimmedNonEmpty
    }

    static func realtimeProviderConfig(
        providers: [String: AnyCodable]?,
        provider: String?) -> [String: AnyCodable]?
    {
        guard let providers else { return nil }
        if let provider {
            if let exact = providers[provider]?.dictionaryValue {
                return exact
            }
            return providers.first { key, _ in
                key.trimmingCharacters(in: .whitespacesAndNewlines)
                    .caseInsensitiveCompare(provider) == .orderedSame
            }?.value.dictionaryValue
        }
        if providers.count == 1 {
            return providers.values.first?.dictionaryValue
        }
        return nil
    }

    public static func resolvedPositiveInt(_ value: AnyCodable?, fallback: Int) -> Int {
        if let timeout = value?.intValue, timeout > 0 {
            return timeout
        }
        return fallback
    }

    public static func resolvedSilenceTimeoutMs(_ talk: [String: AnyCodable]?, fallback: Int) -> Int {
        self.resolvedPositiveInt(talk?["silenceTimeoutMs"], fallback: fallback)
    }

    public static func normalizedSpeechLocaleID(_ value: String?) -> String? {
        value?.trimmedNonEmpty?.replacingOccurrences(of: "_", with: "-")
    }

    static func resolvedSpeechLocaleID(
        _ talk: [String: AnyCodable]?,
        fallback: String? = nil) -> String?
    {
        self.normalizedSpeechLocaleID(talk?["speechLocale"]?.stringValue)
            ?? self.normalizedSpeechLocaleID(fallback)
    }

    public static func normalizedExplicitSpeechLocaleID(
        _ value: String?,
        automaticID: String = "auto") -> String?
    {
        let normalized = self.normalizedSpeechLocaleID(value)
        return normalized == automaticID ? nil : normalized
    }

    public static func resolvedSpeechRecognitionLocaleID(
        preferredLocaleIDs: [String?],
        fallbackLocaleID: String = "en-US",
        supportedLocaleIDs: Set<String>) -> String?
    {
        let supported = Set(supportedLocaleIDs.compactMap(self.normalizedSpeechLocaleID))
        let candidates = (preferredLocaleIDs + [fallbackLocaleID])
            .compactMap(self.normalizedSpeechLocaleID)
        return candidates.first { supported.isEmpty || supported.contains($0) }
    }
}
