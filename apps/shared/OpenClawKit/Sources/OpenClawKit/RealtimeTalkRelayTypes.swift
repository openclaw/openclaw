#if Talk && canImport(ElevenLabsKit) && (os(iOS) || os(macOS))
import AVFAudio
import Foundation
import OpenClawProtocol

public struct RealtimeTalkAudioFrame: Sendable {
    public let data: Data
    public let timestampMs: Double
    public let rms: Float

    public init(data: Data, timestampMs: Double, rms: Float) {
        self.data = data
        self.timestampMs = timestampMs
        self.rms = rms
    }
}

public enum RealtimeTalkPCM16Encoder {
    public nonisolated static func encode(
        buffer: AVAudioPCMBuffer,
        inputSampleRate: Double,
        targetSampleRate: Double) -> Data
    {
        guard let channelData = buffer.floatChannelData,
              buffer.frameLength > 0,
              inputSampleRate > 0,
              targetSampleRate > 0
        else { return Data() }
        let frameCount = Int(buffer.frameLength)
        let channelCount = max(1, Int(buffer.format.channelCount))
        let outputCount = max(1, Int((Double(frameCount) * targetSampleRate / inputSampleRate).rounded(.down)))
        var data = Data(capacity: outputCount * MemoryLayout<Int16>.size)
        for index in 0..<outputCount {
            let sourcePosition = Double(index) * inputSampleRate / targetSampleRate
            let lower = min(frameCount - 1, Int(sourcePosition.rounded(.down)))
            let upper = min(frameCount - 1, lower + 1)
            let fraction = Float(sourcePosition - Double(lower))
            var mixed: Float = 0
            for channel in 0..<channelCount {
                let samples = channelData[channel]
                mixed += samples[lower] + ((samples[upper] - samples[lower]) * fraction)
            }
            let sample = max(-1, min(1, mixed / Float(channelCount)))
            var intSample = Int16((sample * Float(Int16.max)).rounded()).littleEndian
            withUnsafeBytes(of: &intSample) { data.append(contentsOf: $0) }
        }
        return data
    }
}

@MainActor
public protocol RealtimeTalkAudioCapturing: AnyObject {
    var suppressesInputDuringOutput: Bool { get }
    var usesServerVADForBargeIn: Bool { get }

    func start(
        targetSampleRate: Double,
        onAudio: @escaping @Sendable (RealtimeTalkAudioFrame) -> Void,
        onFailure: @escaping @MainActor (String) -> Void) throws

    func stop()

    /// Retire input delivery while retaining a shared engine for final playback.
    /// Return false when the capture cannot support this optional operation.
    func stopInputPreservingPlayback() -> Bool
}

extension RealtimeTalkAudioCapturing {
    public func stopInputPreservingPlayback() -> Bool {
        false
    }

    public var usesServerVADForBargeIn: Bool {
        false
    }
}

public struct RealtimeTalkRelayTransport: Sendable {
    public let subscribeServerEvents: @Sendable (Int) async -> AsyncStream<EventFrame>
    public let request: @Sendable (String, [String: AnyCodable]?, Double) async throws -> Data
    public let isCurrent: @Sendable () async -> Bool

    public init(
        subscribeServerEvents: @escaping @Sendable (Int) async -> AsyncStream<EventFrame>,
        request: @escaping @Sendable (String, [String: AnyCodable]?, Double) async throws -> Data,
        isCurrent: @escaping @Sendable () async -> Bool = { true })
    {
        self.subscribeServerEvents = subscribeServerEvents
        self.request = request
        self.isCurrent = isCurrent
    }
}

public struct RealtimeTalkRelayIssue: Equatable, Sendable {
    public let code: String
    public let message: String
    public let provider: String?
    public let model: String?
    public let transport: String?
    public let phase: String?

    public init(
        code: String = "realtime_unavailable",
        message: String,
        provider: String? = nil,
        model: String? = nil,
        transport: String? = nil,
        phase: String? = nil)
    {
        self.code = code
        self.message = message.trimmingCharacters(in: .whitespacesAndNewlines)
        self.provider = provider
        self.model = model
        self.transport = transport
        self.phase = phase
    }
}

public struct RealtimeTalkTranscript: Equatable, Sendable {
    public let role: String
    public let text: String
    public let isFinal: Bool

    public init(role: String, text: String, isFinal: Bool) {
        self.role = role
        self.text = text
        self.isFinal = isFinal
    }
}

public enum RealtimeTalkRelayTermination: Equatable, Sendable {
    case remoteClose(reason: String?)
    case outputCancelled(reason: String)
    case eventStreamEnded
    case audioInputFailed(message: String)
    case outputCancellationFailed
    case outputPlaybackOverflow
}

extension RealtimeTalkRelaySession {
    public struct Options: Sendable {
        public let sessionKey: String
        public let provider: String?
        public let model: String?
        public let voice: String?
        public let localStopPhrases: [String]?
        public let spokenExitAcknowledgementEnabled: Bool
        public let speechLocaleID: String?
        public let supportsVoiceSelection: Bool
        public let voiceChangeId: String?

        public init(
            sessionKey: String,
            provider: String?,
            model: String?,
            voice: String?,
            localStopPhrases: [String]? = nil,
            spokenExitAcknowledgementEnabled: Bool = false,
            speechLocaleID: String? = nil,
            supportsVoiceSelection: Bool = false,
            voiceChangeId: String? = nil)
        {
            self.sessionKey = sessionKey
            self.provider = provider
            self.model = model
            self.voice = voice
            self.localStopPhrases = localStopPhrases
            self.spokenExitAcknowledgementEnabled = spokenExitAcknowledgementEnabled
            self.speechLocaleID = speechLocaleID
            self.supportsVoiceSelection = supportsVoiceSelection
            self.voiceChangeId = voiceChangeId
        }
    }
}

extension RealtimeTalkRelaySession {
    struct OutputIdentity {
        enum Relation {
            case same
            case different
            case unknown
        }

        let turnId: String?

        init(turnID: String) {
            self.turnId = turnID
        }

        init(_ payload: [String: AnyCodable]) {
            let turnId = payload["talkEvent"]?.dictionaryValue?["turnId"]?.stringValue?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            self.turnId = turnId?.isEmpty == false ? turnId : nil
        }

        func isEmpty() -> Bool {
            self.turnId == nil
        }

        func relation(to other: OutputIdentity) -> Relation {
            if self.isEmpty() || other.isEmpty() {
                return self.isEmpty() == other.isEmpty() ? .same : .different
            }
            if let turnId, let otherTurnId = other.turnId {
                return turnId == otherTurnId ? .same : .different
            }
            return .unknown
        }
    }
}

extension RealtimeTalkRelaySession {
    struct ToolCallStartResponse: Decodable {
        let runId: String?
        let idempotencyKey: String?
    }

    struct ChatCompletionResult {
        let text: String?
        let failed: Bool
    }

    struct RelayChatEvent: Decodable {
        let runId: String?
        let state: String?
        let message: AnyCodable?
    }
}

extension RealtimeTalkRelaySession {
    nonisolated static func assistantText(from message: AnyCodable?) -> String? {
        guard let message else { return nil }
        if let text = message.stringValue {
            return self.trimmed(text)
        }
        guard let object = message.dictionaryValue else { return nil }
        if let role = self.trimmed(object["role"]?.stringValue), role.lowercased() != "assistant" {
            return nil
        }
        guard let content = object["content"] else { return nil }
        if let text = content.stringValue {
            return self.trimmed(text)
        }
        let parts = content.arrayValue?.compactMap { part -> String? in
            if let text = part.stringValue { return self.trimmed(text) }
            return self.trimmed(part.dictionaryValue?["text"]?.stringValue)
        } ?? []
        return self.trimmed(parts.joined(separator: "\n"))
    }

    nonisolated static func trimmed(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}
#endif
