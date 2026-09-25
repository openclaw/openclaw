#if Talk && canImport(ElevenLabsKit) && (os(iOS) || os(macOS))
import Foundation
import OpenClawProtocol
import OSLog

enum RealtimeAudioSendOutcome {
    case sent, inactive, saturated, failed(String)
}

actor RealtimeAudioSender {
    private struct PendingSend {
        let startedAtMs: Double
        let captureTimestampMs: Double
        let byteCount: Int
    }

    private let request: @Sendable (String, [String: AnyCodable]?, Double) async throws -> Data
    private var relaySessionId: String?
    private var pendingSends: [UUID: PendingSend] = [:]
    private let maxPendingSends = 4
    private var reportedSaturation = false
    private let logger = Logger(subsystem: "ai.openclawfoundation.app", category: "RealtimeTalkRelay")

    init(
        relaySessionId: String,
        request: @escaping @Sendable (String, [String: AnyCodable]?, Double) async throws -> Data)
    {
        self.relaySessionId = relaySessionId
        self.request = request
    }

    func close() {
        self.relaySessionId = nil
    }

    func send(_ data: Data, timestampMs: Double) async -> RealtimeAudioSendOutcome {
        guard !Task.isCancelled, let relaySessionId else { return .inactive }
        let nowMs = ProcessInfo.processInfo.systemUptime * 1000
        guard self.pendingSends.count < self.maxPendingSends else {
            if !self.reportedSaturation,
               let oldest = self.pendingSends.values.min(by: { $0.startedAtMs < $1.startedAtMs })
            {
                self.reportedSaturation = true
                // Compare request age with the capture timeline to distinguish slow ACKs
                // from callbacks delivered in a burst. Never log audio or session identifiers.
                let ageMs = (nowMs - oldest.startedAtMs).rounded()
                let captureSpanMs = (timestampMs - oldest.captureTimestampMs).rounded()
                let pendingBytes = self.pendingSends.values.reduce(0) { $0 + $1.byteCount }
                self.logger.warning(
                    """
                    talk realtime input saturated pending=\(self.pendingSends.count, privacy: .public) \
                    pendingBytes=\(pendingBytes, privacy: .public) incomingBytes=\(data.count, privacy: .public) \
                    oldestRequestMs=\(ageMs, privacy: .public) captureSpanMs=\(captureSpanMs, privacy: .public)
                    """)
            }
            return .saturated
        }
        let sendID = UUID()
        self.pendingSends[sendID] = PendingSend(
            startedAtMs: nowMs,
            captureTimestampMs: timestampMs,
            byteCount: data.count)
        defer { self.pendingSends.removeValue(forKey: sendID) }
        // The Gateway carries this straight into the provider's media timeline, and OpenAI rejects
        // a `conversation.item.truncate` whose `audio_end_ms` is not an integer -- a fractional
        // timestamp here kills the session on the first barge-in.
        let payload: [String: AnyCodable] = [
            "sessionId": AnyCodable(relaySessionId),
            "audioBase64": AnyCodable(data.base64EncodedString()),
            "timestamp": AnyCodable(timestampMs.rounded()),
        ]
        do {
            try Task.checkCancellation()
            let response = try await self.request("talk.session.appendAudio", payload, 8000)
            try Task.checkCancellation()
            _ = try JSONDecoder().decode(TalkSessionOkResult.self, from: response)
            return .sent
        } catch {
            return Task.isCancelled ? .inactive : .failed(error.localizedDescription)
        }
    }
}

#endif
