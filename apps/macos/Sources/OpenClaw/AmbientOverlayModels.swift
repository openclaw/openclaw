import CoreGraphics
import Foundation

enum AmbientOverlayState: Equatable {
    case idle
    case arming
    case armed
    case executing
    case cooldown
}

enum AmbientOverlayDisplayScope: String, CaseIterable, Identifiable {
    case currentDisplay
    case allDisplays

    var id: String { self.rawValue }

    var title: String {
        switch self {
        case .currentDisplay:
            "Current Display"
        case .allDisplays:
            "All Displays"
        }
    }
}

struct AmbientOverlayDisplayInfo: Equatable, Identifiable {
    var id: String
    var frame: CGRect
}

struct AmbientOverlaySettings: Equatable {
    static let defaultIntensity = 0.42
    static let defaultTimeoutSeconds = 30.0
    static let defaults = AmbientOverlaySettings(
        isEnabled: false,
        displayScope: .currentDisplay,
        intensity: Self.defaultIntensity,
        timeoutSeconds: Self.defaultTimeoutSeconds)

    var isEnabled: Bool
    var displayScope: AmbientOverlayDisplayScope
    var intensity: Double
    var timeoutSeconds: Double
}

enum AmbientOverlayDisplayResolver {
    static func targetDisplays(
        displays: [AmbientOverlayDisplayInfo],
        mouseLocation: CGPoint,
        scope: AmbientOverlayDisplayScope) -> [AmbientOverlayDisplayInfo]
    {
        switch scope {
        case .allDisplays:
            displays
        case .currentDisplay:
            if let display = displays.first(where: { $0.frame.contains(mouseLocation) }) {
                [display]
            } else if let firstDisplay = displays.first {
                [firstDisplay]
            } else {
                []
            }
        }
    }
}
