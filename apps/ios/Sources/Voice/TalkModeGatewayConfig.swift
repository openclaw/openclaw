import Foundation
import OpenClawKit

struct TalkRuntimeIssue {
    enum Code: String {
        case audioInputUnavailable = "audio_input_unavailable"
        case realtimeOutputCancelFailed = "realtime_output_cancel_failed"
        case realtimeUnavailable = "realtime_unavailable"
    }

    let code: Code
    let message: String

    init(code: Code = .realtimeUnavailable, message: String) {
        self.code = code
        self.message = message.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var displayMessage: String {
        if !self.message.isEmpty { return self.message }
        return String(localized: "Realtime voice did not start.")
    }

    var fallbackStatusText: String {
        String(localized: "Listening (iOS Speech fallback)")
    }
}

enum TalkModeRuntimeRoute: Equatable {
    case localElevenLabs
    case gatewayTalkSpeak
    case realtimeWebRTC
    case realtimeRelay

    var usesRealtime: Bool {
        self == .realtimeRelay || self == .realtimeWebRTC
    }

    var usesGatewayTalkSpeak: Bool {
        self == .gatewayTalkSpeak
    }

    var gatewayOwnsCredentials: Bool {
        self != .localElevenLabs
    }
}

struct TalkModeGatewayConfigState {
    let snapshot: TalkConfigSnapshot
    let route: TalkModeRuntimeRoute
    let defaultVoiceId: String?
    let configuredModelId: String?
    let defaultModelId: String
    let defaultOutputFormat: String?
    let realtimeModelId: String?
    let rawConfigApiKey: String?
}

enum TalkModeGatewayConfigParser {
    static func parse(
        config: [String: Any],
        defaultProvider: String,
        defaultModelIdFallback: String,
        defaultRealtimeModelIdFallback: String,
        defaultSilenceTimeoutMs: Int) -> TalkModeGatewayConfigState
    {
        let talk = TalkConfigParsing.bridgeFoundationDictionary(config["talk"] as? [String: Any])
        let snapshot = TalkConfigSnapshot(
            talk,
            defaultProvider: defaultProvider,
            defaultSilenceTimeoutMs: defaultSilenceTimeoutMs,
            allowLegacyFallback: false)
        let activeConfig = snapshot.providerConfig
        let model = TalkConfigParsing.firstNonEmptyString(activeConfig, keys: ["modelId", "model"])
        let defaultModelId = model ?? defaultModelIdFallback
        let defaultVoiceId = TalkConfigParsing.firstNonEmptyString(activeConfig, keys: ["voiceId", "voice"])
        let defaultOutputFormat = TalkConfigParsing.firstNonEmptyString(activeConfig, keys: ["outputFormat"])
        let realtime = snapshot.realtime
        let realtimeClientHints = TalkConfigParsing.bridgeFoundationDictionary(
            (config["clientHints"] as? [String: Any])?["realtime"] as? [String: Any])
        let gatewayOwnsRealtimeModel =
            TalkConfigParsing.firstNonEmptyString(realtimeClientHints, keys: ["modelSource"]) == "gateway"
        let realtimeModelId = gatewayOwnsRealtimeModel
            ? realtime.modelId
            : (realtime.modelId ?? defaultRealtimeModelIdFallback)
        let rawConfigApiKey = activeConfig?["apiKey"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)

        return TalkModeGatewayConfigState(
            snapshot: snapshot,
            route: self.runtimeRoute(snapshot: snapshot, defaultProvider: defaultProvider),
            defaultVoiceId: defaultVoiceId,
            configuredModelId: model,
            defaultModelId: defaultModelId,
            defaultOutputFormat: defaultOutputFormat,
            realtimeModelId: realtimeModelId,
            rawConfigApiKey: rawConfigApiKey)
    }

    private static func runtimeRoute(
        snapshot: TalkConfigSnapshot,
        defaultProvider: String) -> TalkModeRuntimeRoute
    {
        let nativeRoute: TalkModeRuntimeRoute = snapshot.activeProvider
            .trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == defaultProvider
            .trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            ? .localElevenLabs : .gatewayTalkSpeak
        let realtime = snapshot.realtime
        guard realtime.mode == "realtime",
              realtime.brain == nil || realtime.brain == "agent-consult"
        else { return nativeRoute }
        // Forced consultation must use the relay that enforces final-transcript consultations.
        if realtime.consultRouting == "force-agent-consult"
            || realtime.transport == "gateway-relay"
            || realtime.transport == "provider-websocket"
            || self.usesAzureOpenAI(provider: realtime.provider, config: realtime.providerConfig)
        {
            return .realtimeRelay
        }
        switch realtime.transport {
        case "managed-room":
            return nativeRoute
        case "webrtc", nil:
            return realtime.provider?.lowercased() == "openai" ? .realtimeWebRTC : .realtimeRelay
        default:
            return .realtimeRelay
        }
    }

    private static func usesAzureOpenAI(
        provider: String?,
        config: [String: AnyCodable]?) -> Bool
    {
        guard provider?.caseInsensitiveCompare("openai") == .orderedSame else { return false }
        return TalkConfigParsing.firstNonEmptyString(config, keys: ["azureEndpoint", "azureDeployment"]) != nil
    }
}
