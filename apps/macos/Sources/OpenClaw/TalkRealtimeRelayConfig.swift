import Foundation

struct TalkRealtimeRelayConfig: Equatable, Sendable {
    let provider: String?
    let model: String?
    let voice: String?

    func options(sessionKey: String, interruptOnSpeech: Bool) -> TalkRealtimeRelayOptions {
        TalkRealtimeRelayOptions(
            sessionKey: sessionKey,
            provider: self.provider,
            model: self.model,
            voice: self.voice,
            interruptOnSpeech: interruptOnSpeech)
    }
}

struct TalkRealtimeRelayOptions: Equatable, Sendable {
    let sessionKey: String
    let provider: String?
    let model: String?
    let voice: String?
    let interruptOnSpeech: Bool
}
