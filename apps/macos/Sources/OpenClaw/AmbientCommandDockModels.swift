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
    case quiet
    case ready
    case focused
    case reading
    case planning
    case waitingForApproval
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
        case .quiet:
            AmbientThomasOrbMotionProfile(
                pulseSeconds: 4.0,
                orbitSeconds: 14.0,
                floatAmplitude: 3,
                glowOpacity: 0.16)
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
        case .reading:
            AmbientThomasOrbMotionProfile(
                pulseSeconds: 2.2,
                orbitSeconds: 7.2,
                floatAmplitude: 9,
                glowOpacity: 0.34)
        case .planning:
            AmbientThomasOrbMotionProfile(
                pulseSeconds: 2.0,
                orbitSeconds: 6.2,
                floatAmplitude: 11,
                glowOpacity: 0.38)
        case .waitingForApproval:
            AmbientThomasOrbMotionProfile(
                pulseSeconds: 1.6,
                orbitSeconds: 5.8,
                floatAmplitude: 6,
                glowOpacity: 0.46)
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

struct AmbientThomasOrbMotionSample: Equatable {
    var offsetX: Double
    var offsetY: Double
    var tiltDegrees: Double
    var spinDegrees: Double

    static func sample(time: TimeInterval, state: AmbientThomasOrbState) -> AmbientThomasOrbMotionSample {
        let profile = AmbientThomasOrbMotionProfile.profile(for: state)
        let anchors: [(x: Double, y: Double)] = [
            (-34, -34),
            (30, -24),
            (38, 28),
            (-22, 32),
            (-38, 2),
        ]
        let hopSeconds = max(2.4, profile.orbitSeconds * 0.34)
        let rawIndex = Int(floor(time / hopSeconds))
        let current = anchors[rawIndex % anchors.count]
        let next = anchors[(rawIndex + 1) % anchors.count]
        let progress = Self.smoothStep(time.truncatingRemainder(dividingBy: hopSeconds) / hopSeconds)
        let sway = cos(time / 1.6 + Double(rawIndex)) * (profile.floatAmplitude * 0.28)
        let drift = sin(time / 1.2 + Double(rawIndex)) * (profile.floatAmplitude * 0.38)
        let x = Self.lerp(current.x, next.x, progress) + sway
        let y = Self.lerp(current.y, next.y, progress) + drift

        return AmbientThomasOrbMotionSample(
            offsetX: x,
            offsetY: y,
            tiltDegrees: sin(time / 0.76 + Double(rawIndex)) * 5.5,
            spinDegrees: (time.truncatingRemainder(dividingBy: profile.orbitSeconds) / profile.orbitSeconds) * 360)
    }

    private static func lerp(_ lhs: Double, _ rhs: Double, _ progress: Double) -> Double {
        lhs + ((rhs - lhs) * progress)
    }

    private static func smoothStep(_ progress: Double) -> Double {
        let clamped = min(max(progress, 0), 1)
        return clamped * clamped * (3 - (2 * clamped))
    }
}
