//
//  LocationManager.swift
//  visionOS-node
//
//  OpenClaw visionOS Node — LOAM STUDIO
//
//  Provides one-shot location lookups via CoreLocation.
//  Authorization is requested on first use.
//

import CoreLocation
import Foundation

@MainActor
final class LocationManager: NSObject, CLLocationManagerDelegate {

    private let clManager = CLLocationManager()
    private var continuation: CheckedContinuation<CLLocation, Error>?

    override init() {
        super.init()
        clManager.delegate = self
        clManager.desiredAccuracy = kCLLocationAccuracyBest
    }

    /// Request a one-shot location fix.
    /// Returns a CLLocation or throws if authorization denied or location unavailable.
    func requestLocation() async throws -> CLLocation {
        return try await withCheckedThrowingContinuation { cont in
            self.continuation = cont
            let status = self.clManager.authorizationStatus
            switch status {
            case .notDetermined:
                self.clManager.requestWhenInUseAuthorization()
            case .authorizedWhenInUse, .authorizedAlways:
                self.clManager.requestLocation()
            case .denied, .restricted:
                cont.resume(throwing: LocationError.denied)
                self.continuation = nil
            @unknown default:
                cont.resume(throwing: LocationError.denied)
                self.continuation = nil
            }
        }
    }

    // MARK: - CLLocationManagerDelegate

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.first else { return }
        Task { @MainActor in
            self.continuation?.resume(returning: location)
            self.continuation = nil
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in
            self.continuation?.resume(throwing: error)
            self.continuation = nil
        }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in
            let status = manager.authorizationStatus
            switch status {
            case .authorizedWhenInUse, .authorizedAlways:
                manager.requestLocation()
            case .denied, .restricted:
                self.continuation?.resume(throwing: LocationError.denied)
                self.continuation = nil
            default:
                break
            }
        }
    }
}

enum LocationError: Error {
    case denied
    case unavailable
}
