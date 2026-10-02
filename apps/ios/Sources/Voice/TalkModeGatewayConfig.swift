import Foundation
import OpenClawKit

struct TalkRuntimeIssue: Equatable {
    enum Code: String {
        case audioInputUnavailable = "audio_input_unavailable"
        case realtimeOutputCancelFailed = "realtime_output_cancel_failed"
        case realtimeUnavailable = "realtime_unavailable"
    }

    let code: Code
    let message: String
    let provider: String?
    let model: String?
    let transport: String?
    let phase: String?

    init(
        code: Code,
        message: String,
        provider: String? = nil,
        model: String? = nil,
        transport: String? = nil,
        phase: String? = nil)
    {
        self.code = code
        self.message = message.trimmingCharacters(in: .whitespacesAndNewlines)
        self.provider = provider?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.model = model?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.transport = transport?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.phase = phase?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var displayMessage: String {
        if !self.message.isEmpty { return self.message }
        return String(localized: "Realtime voice did not start.")
    }

    var fallbackStatusText: String {
        String(localized: "Listening (iOS Speech fallback)")
    }

    var diagnosticSummary: String {
        var parts = [displayMessage]
        if let provider, !provider.isEmpty { parts.append("provider: \(provider)") }
        if let model, !model.isEmpty { parts.append("model: \(model)") }
        if let transport, !transport.isEmpty { parts.append("transport: \(transport)") }
        if let phase, !phase.isEmpty { parts.append("phase: \(phase)") }
        return parts.joined(separator: " • ")
    }
}

struct TalkVoiceModeDescriptor: Equatable {
    let title: String
    let subtitle: String?

    var accessibilityValue: String {
        if let subtitle, !subtitle.isEmpty {
            return "\(self.title), \(subtitle)"
        }
        return self.title
    }
}

enum TalkVoiceModeDescriptorBuilder {
    static func build(
        providerId: String,
        providerLabel: String,
        modelId: String?,
        voiceId: String?,
        transport: String?,
        isRealtime: Bool) -> TalkVoiceModeDescriptor
    {
        let normalizedProvider = providerId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let trimmedModel = modelId?.trimmedNonEmpty
        let trimmedVoice = voiceId?.trimmedNonEmpty
        let trimmedTransport = transport?.trimmedNonEmpty
        let title = if isRealtime, normalizedProvider == "openai", trimmedModel == "gpt-realtime-2" {
            "GPT Realtime 2.0"
        } else if isRealtime, normalizedProvider == "openai" {
            "OpenAI Realtime"
        } else if isRealtime {
            providerLabel.isEmpty ? "Realtime Voice" : providerLabel
        } else if normalizedProvider == "system" {
            "iOS System Voice"
        } else {
            providerLabel.isEmpty ? "Talk Voice" : providerLabel
        }

        var details: [String] = []
        if isRealtime, normalizedProvider != "openai", !providerLabel.isEmpty, providerLabel != title {
            details.append(providerLabel)
        }
        if let trimmedTransport {
            details.append(Self.transportLabel(trimmedTransport))
        }
        if let trimmedModel, title != "GPT Realtime 2.0" || trimmedModel != "gpt-realtime-2" {
            details.append(trimmedModel)
        }
        if let trimmedVoice {
            details.append(Self.voiceLabel(trimmedVoice))
        }

        return TalkVoiceModeDescriptor(
            title: title,
            subtitle: details.isEmpty ? nil : details.joined(separator: " • "))
    }

    private static func voiceLabel(_ voice: String) -> String {
        switch voice {
        case "alloy", "ash", "ballad", "cedar", "coral", "echo", "marin", "sage", "shimmer", "verse":
            voice.prefix(1).uppercased() + String(voice.dropFirst())
        default:
            voice
        }
    }

    private static func transportLabel(_ transport: String) -> String {
        switch transport.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "webrtc":
            "Native WebRTC"
        case "gateway-relay":
            "Gateway Relay"
        case "provider-websocket":
            "Provider WebSocket"
        case "managed-room":
            "Managed Room"
        case "native":
            "Native"
        case let value where !value.isEmpty:
            value
        default:
            "Native"
        }
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
