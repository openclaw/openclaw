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
    let apiKey: String?
    let systemVoiceIdentifier: String?
    let systemVoiceLanguage: String?
    let systemVoiceRate: Float?
    let systemVoicePitchMultiplier: Float?
    let seamColorHex: String?
}

enum TalkModeGatewayConfigParser {
    private static func trimmedString(_ value: AnyCodable?) -> String? {
        let trimmed = value?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func floatValue(_ value: AnyCodable?) -> Float? {
        if let double = value?.doubleValue { return Float(double) }
        if let int = value?.intValue { return Float(int) }
        return nil
    }

    static func parse(
        snapshot: ConfigSnapshot,
        defaultProvider: String,
        defaultModelIdFallback: String,
        defaultSilenceTimeoutMs: Int,
        envVoice: String?,
        sagVoice: String?,
        envApiKey: String?
    ) -> TalkModeGatewayConfigState {
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
        let resolvedModel = (model?.isEmpty == false) ? model! : defaultModelIdFallback
        let outputFormat = activeConfig?["outputFormat"]?.stringValue
        let systemVoiceIdentifier = self.trimmedString(activeConfig?["systemVoiceIdentifier"])
        let systemVoiceLanguage = self.trimmedString(activeConfig?["systemVoiceLanguage"])
        let systemVoiceRate = self.floatValue(activeConfig?["systemVoiceRate"])
        let systemVoicePitchMultiplier = self.floatValue(activeConfig?["systemVoicePitchMultiplier"])
        let interrupt = talk?["interruptOnSpeech"]?.boolValue
        let apiKey = activeConfig?["apiKey"]?.stringValue
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
            apiKey: resolvedApiKey,
            systemVoiceIdentifier: systemVoiceIdentifier,
            systemVoiceLanguage: systemVoiceLanguage,
            systemVoiceRate: systemVoiceRate,
            systemVoicePitchMultiplier: systemVoicePitchMultiplier,
            seamColorHex: rawSeam.isEmpty ? nil : rawSeam)
    }

    static func fallback(
        defaultModelIdFallback: String,
        defaultSilenceTimeoutMs: Int,
        envVoice: String?,
        sagVoice: String?,
        envApiKey: String?
    ) -> TalkModeGatewayConfigState {
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
            apiKey: resolvedApiKey,
            systemVoiceIdentifier: nil,
            systemVoiceLanguage: nil,
            systemVoiceRate: nil,
            systemVoicePitchMultiplier: nil,
            seamColorHex: nil)
    }
}
