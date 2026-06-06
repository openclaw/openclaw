import Foundation
import OpenClawKit

struct TalkModeGatewayConfigState {
    let activeProvider: String
    let normalizedPayload: Bool
    let missingResolvedPayload: Bool
    let voiceId: String?
    let voiceAliases: [String: String]
    let modelId: String?
    let outputFormat: String?
    let interruptOnSpeech: Bool
    let silenceTimeoutMs: Int
    let speechLocaleID: String?
    let apiKey: String?
    let seamColorHex: String?
    let realtimeRelayConfig: TalkRealtimeRelayConfig?
}

enum TalkModeGatewayConfigParser {
    static func parse(
        snapshot: ConfigSnapshot,
        defaultProvider: String,
        defaultModelIdFallback: String,
        defaultSilenceTimeoutMs: Int,
        envVoice: String?,
        sagVoice: String?,
        envApiKey: String?) -> TalkModeGatewayConfigState
    {
        let talk = snapshot.config?["talk"]?.dictionaryValue
        let selection = TalkConfigParsing.selectProviderConfig(talk, defaultProvider: defaultProvider)
        let activeProvider = selection?.provider ?? defaultProvider
        let activeConfig = selection?.config
        let silenceTimeoutMs = TalkConfigParsing.resolvedSilenceTimeoutMs(
            talk,
            fallback: defaultSilenceTimeoutMs)
        let ui = snapshot.config?["ui"]?.dictionaryValue
        let rawSeam = ui?["seamColor"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let voice = activeConfig?["voiceId"]?.stringValue
        let rawAliases = activeConfig?["voiceAliases"]?.dictionaryValue
        let resolvedAliases: [String: String] =
            rawAliases?.reduce(into: [:]) { acc, entry in
                let key = entry.key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                let value = entry.value.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                guard !key.isEmpty, !value.isEmpty else { return }
                acc[key] = value
            } ?? [:]
        let model = activeConfig?["modelId"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedModel: String? = if model?.isEmpty == false {
            model!
        } else if activeProvider == defaultProvider {
            defaultModelIdFallback
        } else {
            nil
        }
        let outputFormat = activeConfig?["outputFormat"]?.stringValue
        let interrupt = talk?["interruptOnSpeech"]?.boolValue
        let speechLocaleID = TalkConfigParsing.resolvedSpeechLocaleID(talk)
        let apiKey = activeConfig?["apiKey"]?.stringValue
        let realtimeRelayConfig = Self.realtimeRelayConfig(talk)
        let resolvedVoice: String? = if activeProvider == defaultProvider {
            (voice?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? voice : nil) ??
                (envVoice?.isEmpty == false ? envVoice : nil) ??
                (sagVoice?.isEmpty == false ? sagVoice : nil)
        } else {
            (voice?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? voice : nil)
        }
        let resolvedApiKey: String? = if activeProvider == defaultProvider {
            (envApiKey?.isEmpty == false ? envApiKey : nil) ??
                (apiKey?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? apiKey : nil)
        } else {
            nil
        }

        return TalkModeGatewayConfigState(
            activeProvider: activeProvider,
            normalizedPayload: selection?.normalizedPayload == true,
            missingResolvedPayload: talk != nil && selection == nil,
            voiceId: resolvedVoice,
            voiceAliases: resolvedAliases,
            modelId: resolvedModel,
            outputFormat: outputFormat,
            interruptOnSpeech: interrupt ?? true,
            silenceTimeoutMs: silenceTimeoutMs,
            speechLocaleID: speechLocaleID,
            apiKey: resolvedApiKey,
            seamColorHex: rawSeam.isEmpty ? nil : rawSeam,
            realtimeRelayConfig: realtimeRelayConfig)
    }

    static func fallback(
        defaultModelIdFallback: String,
        defaultSilenceTimeoutMs: Int,
        envVoice: String?,
        sagVoice: String?,
        envApiKey: String?) -> TalkModeGatewayConfigState
    {
        let resolvedVoice =
            (envVoice?.isEmpty == false ? envVoice : nil) ??
            (sagVoice?.isEmpty == false ? sagVoice : nil)
        let resolvedApiKey = envApiKey?.isEmpty == false ? envApiKey : nil

        return TalkModeGatewayConfigState(
            activeProvider: "elevenlabs",
            normalizedPayload: false,
            missingResolvedPayload: false,
            voiceId: resolvedVoice,
            voiceAliases: [:],
            modelId: defaultModelIdFallback,
            outputFormat: nil,
            interruptOnSpeech: true,
            silenceTimeoutMs: defaultSilenceTimeoutMs,
            speechLocaleID: nil,
            apiKey: resolvedApiKey,
            seamColorHex: nil,
            realtimeRelayConfig: nil)
    }

    private static func realtimeRelayConfig(_ talk: [String: AnyCodable]?) -> TalkRealtimeRelayConfig? {
        guard let realtime = talk?["realtime"]?.dictionaryValue else { return nil }
        let mode = Self.firstString(realtime, keys: ["mode"])?.lowercased()
        guard mode == "realtime" else { return nil }
        let transport = Self.firstString(realtime, keys: ["transport"])?.lowercased()
        guard transport == nil || transport == "gateway-relay" else { return nil }
        let brain = Self.firstString(realtime, keys: ["brain"])?.lowercased()
        guard brain == nil || brain == "agent-consult" else { return nil }

        let providers = realtime["providers"]?.dictionaryValue
        let provider = Self.firstString(realtime, keys: ["provider"])
            ?? Self.singleRealtimeProviderId(providers)
        let providerConfig = Self.realtimeProviderConfig(providers: providers, provider: provider)
        let model = Self.firstString(realtime, keys: ["model", "modelId"])
            ?? Self.firstString(providerConfig, keys: ["model", "modelId"])
        let voice = Self.firstString(realtime, keys: ["voice", "voiceId", "speakerVoice", "speakerVoiceId"])
            ?? Self.firstString(providerConfig, keys: ["voice", "voiceId", "speakerVoice", "speakerVoiceId"])

        return TalkRealtimeRelayConfig(provider: provider, model: model, voice: voice)
    }

    private static func firstString(_ config: [String: AnyCodable]?, keys: [String]) -> String? {
        guard let config else { return nil }
        for key in keys {
            let value = config[key]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
            if value?.isEmpty == false {
                return value
            }
        }
        return nil
    }

    private static func singleRealtimeProviderId(_ providers: [String: AnyCodable]?) -> String? {
        guard let providers, providers.count == 1 else { return nil }
        let provider = providers.keys.first?.trimmingCharacters(in: .whitespacesAndNewlines)
        return provider?.isEmpty == false ? provider : nil
    }

    private static func realtimeProviderConfig(
        providers: [String: AnyCodable]?,
        provider: String?) -> [String: AnyCodable]?
    {
        guard let providers else { return nil }
        if let provider {
            return providers[provider]?.dictionaryValue
        }
        if providers.count == 1 {
            return providers.values.first?.dictionaryValue
        }
        return nil
    }
}
