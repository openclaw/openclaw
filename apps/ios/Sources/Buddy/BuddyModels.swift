import Foundation

enum BuddyState: String, Equatable {
    case idle
    case listening
    case wakeDetected
    case recording
    case thinking
    case speaking
    case executing
    case needsConfirmation
    case visionScanning
    case disconnected
    case permissionRequired
    case powerSaving

    static func resolve(
        permissionRequired: Bool,
        confirmationRequired: Bool,
        recording: Bool,
        visionScanning: Bool,
        speaking: Bool,
        thinking: Bool,
        connected: Bool
    ) -> BuddyState {
        if permissionRequired { return .permissionRequired }
        if confirmationRequired { return .needsConfirmation }
        if recording { return .recording }
        if visionScanning { return .visionScanning }
        if speaking { return .speaking }
        if thinking { return .thinking }
        if !connected { return .disconnected }
        return .listening
    }
}

enum BuddyMood: String, Equatable {
    case calm
    case attentive
    case focused
    case happy
    case curious
    case confused
    case tired
}

struct BuddyAgent: Equatable {
    var name: String = "Nemo"
    var mood: BuddyMood = .calm
    var message: String?
}

struct BuddyVoice: Equatable {
    var mode: String = "listening"
    var wakeWord: String = "NemoNemo"
}

struct BuddyVision: Equatable {
    var available: Bool = true
    var mode: String = "idle"
    var requiresConsent: Bool = false
}

struct BuddyPrompt: Equatable {
    var id: String
    var kind: String
    var text: String
}

struct BuddySnapshot: Equatable {
    var state: BuddyState
    var agent: BuddyAgent = BuddyAgent()
    var voice: BuddyVoice = BuddyVoice()
    var vision: BuddyVision = BuddyVision()
    var prompt: BuddyPrompt?

    static func listening() -> BuddySnapshot {
        BuddySnapshot(state: .listening)
    }
}
