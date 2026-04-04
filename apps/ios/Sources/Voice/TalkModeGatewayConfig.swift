import Foundation
import OpenClawKit

struct TalkModeGatewayConfigState {
    let activeProvider: String
    let normalizedPayload: Bool
    let missingResolvedPayload: Bool
    let defaultVoiceId: String?
    let voiceAliases: [String: String]
    let preferredModelId: String?
    let preferredOutputFormat: String?
    let rawConfigApiKey: String?
    let interruptOnSpeech: Bool?
    let silenceTimeoutMs: Int
    let mistralBaseUrl: String?
}

enum TalkModeGatewayConfigParser {
    static func parse(
        config: [String: Any],
        defaultProvider: String,
        defaultSilenceTimeoutMs: Int
    ) -> TalkModeGatewayConfigState {
        let talkRaw = config["talk"] as? [String: Any]
        if let talkRaw = talkRaw {
            let keys = talkRaw.keys.joined(separator: ", ")
            GatewayDiagnostics.log("talk config parsing: found 'talk' dictionary with keys: [\(keys)]")
        } else {
            GatewayDiagnostics.log("talk config parsing: 'talk' dictionary is missing in server response")
        }
        let talk = TalkConfigParsing.bridgeFoundationDictionary(talkRaw)
        let selection = TalkConfigParsing.selectProviderConfig(
            talk,
            defaultProvider: defaultProvider,
            allowLegacyFallback: false)
        let activeProvider = selection?.provider ?? defaultProvider
        let activeConfig = selection?.config
        
        if activeConfig == nil {
             GatewayDiagnostics.log("talk config parsing: activeConfig (resolved) is missing for provider \(activeProvider)")
        }

        let modelIdKeys = ["modelId", "model"]
        var model: String?
        for key in modelIdKeys {
            if let val = activeConfig?[key]?.stringValue {
                model = val
                break
            }
        }
        if model == nil {
            for key in modelIdKeys {
                if let val = talk?[key]?.stringValue {
                    model = val
                    break
                }
            }
        }

        let voiceIdKeys = ["voiceId", "voice"]
        var voice: String?
        for key in voiceIdKeys {
            if let val = activeConfig?[key]?.stringValue {
                voice = val
                break
            }
        }
        if voice == nil {
            for key in voiceIdKeys {
                if let val = talk?[key]?.stringValue {
                    voice = val
                    break
                }
            }
        }

        let preferredModelId = (model?.isEmpty == false) ? model : nil
        let preferredOutputFormat = (activeConfig?["outputFormat"]?.stringValue ?? 
                                    talk?["outputFormat"]?.stringValue)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let rawConfigApiKey = (activeConfig?["apiKey"]?.stringValue ?? talk?["apiKey"]?.stringValue)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        
        let voiceAliases: [String: String]
        if let aliases = activeConfig?["voiceAliases"]?.dictionaryValue ?? talk?["voiceAliases"]?.dictionaryValue {
            var resolved: [String: String] = [:]
            for (key, value) in aliases {
                guard let id = value.stringValue else { continue }
                let normalizedKey = key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                let trimmedId = id.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !normalizedKey.isEmpty, !trimmedId.isEmpty else { continue }
                resolved[normalizedKey] = trimmedId
            }
            voiceAliases = resolved
        } else {
            voiceAliases = [:]
        }

        let interruptOnSpeech = (activeConfig?["interruptOnSpeech"]?.boolValue ?? talk?["interruptOnSpeech"]?.boolValue)
        let silenceTimeoutMs = TalkConfigParsing.resolvedSilenceTimeoutMs(
            talk,
            fallback: defaultSilenceTimeoutMs)

        let mistralBaseUrl = activeConfig?["baseUrl"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
 
         return TalkModeGatewayConfigState(
             activeProvider: activeProvider,
             normalizedPayload: selection?.normalizedPayload == true,
             missingResolvedPayload: talk != nil && selection == nil,
             defaultVoiceId: voice,
             voiceAliases: voiceAliases,
             preferredModelId: preferredModelId,
             preferredOutputFormat: (preferredOutputFormat?.isEmpty == false) ? preferredOutputFormat : nil,
             rawConfigApiKey: rawConfigApiKey,
             interruptOnSpeech: interruptOnSpeech,
             silenceTimeoutMs: silenceTimeoutMs,
             mistralBaseUrl: (mistralBaseUrl?.isEmpty == false) ? mistralBaseUrl : nil)
    }
}
