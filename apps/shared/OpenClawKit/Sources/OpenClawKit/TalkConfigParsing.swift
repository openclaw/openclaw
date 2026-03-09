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

    public static func selectProviderConfig(
        _ talk: [String: AnyCodable]?,
        defaultProvider: String,
        allowLegacyFallback: Bool = true,
    ) -> TalkProviderConfigSelection? {
        guard let talk else { return nil }
        if let resolvedSelection = self.resolvedProviderConfig(talk) {
            return resolvedSelection
        }
        let hasNormalizedPayload = talk["provider"] != nil || talk["providers"] != nil
        if hasNormalizedPayload {
            return nil
        }
        guard allowLegacyFallback else { return nil }
        return TalkProviderConfigSelection(
            provider: defaultProvider,
            config: talk,
            normalizedPayload: false)
    }

    public static func resolvedPositiveInt(_ value: AnyCodable?, fallback: Int) -> Int {
        if let timeout = value?.intValue, timeout > 0 {
            return timeout
        }
        if
            let timeout = value?.doubleValue,
            timeout > 0,
            timeout.rounded(.towardZero) == timeout,
            timeout <= Double(Int.max)
        {
            return Int(timeout)
        }
        return fallback
    }

    public static func resolvedSilenceTimeoutMs(_ talk: [String: AnyCodable]?, fallback: Int) -> Int {
        self.resolvedPositiveInt(talk?["silenceTimeoutMs"], fallback: fallback)
    }

    private static func normalizedTalkProviderID(_ raw: String?) -> String? {
        let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func resolvedProviderConfig(
        _ talk: [String: AnyCodable]
    ) -> TalkProviderConfigSelection? {
        guard
            let resolved = talk["resolved"]?.dictionaryValue,
            let providerID = self.normalizedTalkProviderID(resolved["provider"]?.stringValue)
        else { return nil }
        return TalkProviderConfigSelection(
            provider: providerID,
            config: resolved["config"]?.dictionaryValue ?? [:],
            normalizedPayload: true)
    }
}
