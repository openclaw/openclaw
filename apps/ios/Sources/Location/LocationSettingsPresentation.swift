import CoreLocation
import Foundation
import OpenClawKit

enum LocationSettingsAction: Equatable {
    case setMode(OpenClawLocationMode)
    case openAppSettings(OpenClawLocationMode)
}

struct LocationSettingsPresentation: Equatable {
    var selectedMode: OpenClawLocationMode
    var summary: LocationPermissionSummary

    var sharingControlIsOn: Bool {
        self.summary.effectiveMode != .off
    }

    var showsAccessLevel: Bool {
        self.accessLevelText != nil
    }

    var accessLevelText: String? {
        guard self.summary.locationServicesEnabled else { return nil }
        switch self.summary.authorizationStatus {
        case .authorizedWhenInUse:
            return OpenClawLocationMode.whileUsing.locationAccessLevelText
        case .authorizedAlways:
            return OpenClawLocationMode.always.locationAccessLevelText
        default:
            return nil
        }
    }

    var statusText: String? {
        guard self.selectedMode != .off else { return nil }
        guard self.summary.needsAttention else { return nil }

        if !self.summary.locationServicesEnabled {
            return "Location Services are off in iOS Settings."
        }

        switch self.summary.authorizationStatus {
        case .notDetermined:
            return "iOS permission is required to share location."
        case .denied:
            return nil
        case .restricted:
            return "Location permission is restricted on this device."
        case .authorizedWhenInUse:
            return nil
        default:
            return "OpenClaw cannot determine the current iOS location permission."
        }
    }

    func toggleAction(defaultEnabledMode: OpenClawLocationMode = .whileUsing) -> LocationSettingsAction {
        if self.sharingControlIsOn {
            return .setMode(.off)
        }
        let mode = self.selectedMode == .off ? defaultEnabledMode : self.selectedMode
        return self.enableAction(mode: mode)
    }

    private func enableAction(mode: OpenClawLocationMode) -> LocationSettingsAction {
        if !self.summary.locationServicesEnabled {
            return .openAppSettings(mode)
        }

        switch self.summary.authorizationStatus {
        case .denied, .restricted:
            return .openAppSettings(mode)
        default:
            return .setMode(mode)
        }
    }
}

extension OpenClawLocationMode {
    var locationAccessLevelText: String? {
        switch self {
        case .off:
            nil
        case .whileUsing:
            "While Using the App"
        case .always:
            "Always"
        }
    }
}
