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
        executing: Bool = false,
        thinking: Bool,
        connected: Bool
    ) -> BuddyState {
        if permissionRequired { return .permissionRequired }
        if confirmationRequired { return .needsConfirmation }
        if recording { return .recording }
        if visionScanning { return .visionScanning }
        if speaking { return .speaking }
        if executing { return .executing }
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

enum BuddySnapshotBuilder {
    static func build(
        connected: Bool,
        recording: Bool,
        speaking: Bool,
        thinking: Bool = false,
        executing: Bool = false,
        visionScanning: Bool = false,
        permissionRequired: Bool = false,
        confirmationRequired: Bool = false,
        assistantMessage: String? = nil,
        toolName: String? = nil
    ) -> BuddySnapshot {
        let activeRecording = recording && !speaking
        let state = BuddyState.resolve(
            permissionRequired: permissionRequired,
            confirmationRequired: confirmationRequired,
            recording: activeRecording,
            visionScanning: visionScanning,
            speaking: speaking,
            executing: executing,
            thinking: thinking,
            connected: connected)

        switch state {
        case .permissionRequired:
            return BuddySnapshot(
                state: state,
                agent: BuddyAgent(mood: .confused, message: "我需要麦克风或摄像头权限"))
        case .needsConfirmation:
            return BuddySnapshot(
                state: state,
                agent: BuddyAgent(mood: .attentive, message: "要我继续吗？"),
                prompt: BuddyPrompt(id: "pending-action", kind: "continue", text: "要我继续吗？"))
        case .recording:
            return BuddySnapshot(state: state, agent: BuddyAgent(mood: .attentive, message: "我在听"))
        case .visionScanning:
            return BuddySnapshot(
                state: state,
                agent: BuddyAgent(mood: .curious, message: "让我看一下"),
                vision: BuddyVision(available: true, mode: "scanning"))
        case .speaking:
            let message = assistantMessage?.trimmingCharacters(in: .whitespacesAndNewlines)
            return BuddySnapshot(
                state: state,
                agent: BuddyAgent(
                    mood: .happy,
                    message: message.flatMap { $0.isEmpty ? nil : $0 } ?? "我在回答"))
        case .executing:
            let name = toolName?.trimmingCharacters(in: .whitespacesAndNewlines)
            return BuddySnapshot(
                state: state,
                agent: BuddyAgent(
                    mood: .focused,
                    message: name.flatMap { $0.isEmpty ? nil : "我在处理 \($0)" } ?? "我在处理"))
        case .thinking:
            return BuddySnapshot(state: state, agent: BuddyAgent(mood: .focused, message: "想一想"))
        case .disconnected:
            return BuddySnapshot(state: state, agent: BuddyAgent(mood: .confused, message: "我连不上 OpenClaw 了"))
        default:
            return BuddySnapshot(state: state)
        }
    }
}
