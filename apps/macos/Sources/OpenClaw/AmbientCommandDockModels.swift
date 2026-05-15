import Foundation

enum AmbientCommandGroup: String, CaseIterable, Equatable {
    case core
    case surfaces
    case voice
    case gateway
    case sessions
    case modes
    case automation

    var title: String {
        switch self {
        case .core:
            "Core"
        case .surfaces:
            "Surfaces"
        case .voice:
            "Voice"
        case .gateway:
            "Gateway"
        case .sessions:
            "Sessions"
        case .modes:
            "Modes"
        case .automation:
            "Automation"
        }
    }
}

struct AmbientCommandSpec: Equatable, Identifiable {
    var name: String
    var aliases: [String]
    var group: AmbientCommandGroup
    var description: String
    var argumentHint: String?

    var id: String { self.name }
    var displayName: String { "/\(self.name)" }
}

enum AmbientParsedInput: Equatable {
    case empty
    case prompt(String)
    case command(name: String, arguments: String)
    case unknown(name: String, suggestions: [AmbientCommandSpec])
}

enum AmbientCommandResult: Equatable {
    case none
    case success(String)
    case failure(String)
    case info(String)
}

enum AmbientThomasOrbState: Equatable {
    case ready
    case focused
    case sending
    case working
    case success
    case error
}

struct AmbientThomasOrbMotionProfile: Equatable {
    var pulseSeconds: Double
    var orbitSeconds: Double
    var floatAmplitude: Double
    var glowOpacity: Double

    static func profile(for state: AmbientThomasOrbState) -> AmbientThomasOrbMotionProfile {
        switch state {
        case .ready:
            AmbientThomasOrbMotionProfile(
                pulseSeconds: 2.8,
                orbitSeconds: 10.0,
                floatAmplitude: 10,
                glowOpacity: 0.28)
        case .focused:
            AmbientThomasOrbMotionProfile(
                pulseSeconds: 2.4,
                orbitSeconds: 8.0,
                floatAmplitude: 12,
                glowOpacity: 0.36)
        case .sending:
            AmbientThomasOrbMotionProfile(
                pulseSeconds: 1.25,
                orbitSeconds: 3.6,
                floatAmplitude: 7,
                glowOpacity: 0.48)
        case .working:
            AmbientThomasOrbMotionProfile(
                pulseSeconds: 1.8,
                orbitSeconds: 5.0,
                floatAmplitude: 14,
                glowOpacity: 0.42)
        case .success:
            AmbientThomasOrbMotionProfile(
                pulseSeconds: 1.0,
                orbitSeconds: 6.0,
                floatAmplitude: 10,
                glowOpacity: 0.52)
        case .error:
            AmbientThomasOrbMotionProfile(
                pulseSeconds: 3.2,
                orbitSeconds: 12.0,
                floatAmplitude: 4,
                glowOpacity: 0.34)
        }
    }
}
