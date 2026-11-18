import CoreLocation
import Foundation
import OpenClawKit

@MainActor
final class MacNodeLocationService: NSObject, CLLocationManagerDelegate, ConcurrentLocationServiceCommon {
    enum Error: Swift.Error {
        case timeout
        case unavailable
    }

    let locationManager = CLLocationManager()
    var locationRequestContinuations: [UUID: CheckedContinuation<CLLocation, Swift.Error>] = [:]

    override init() {
        super.init()
        self.configureLocationManager()
    }

    func currentLocation(
        desiredAccuracy: OpenClawLocationAccuracy,
        maxAgeMs: Int?,
        timeoutMs: Int?) async throws -> CLLocation
    {
        guard CLLocationManager.locationServicesEnabled() else {
            throw Error.unavailable
        }
        return try await LocationCurrentRequest.resolve(
            manager: self.locationManager,
            desiredAccuracy: desiredAccuracy,
            maxAgeMs: maxAgeMs,
            timeoutMs: timeoutMs,
            request: { try await self.requestLocationOnce() },
            withTimeout: { timeoutMs, operation in
                try await AsyncTimeout.withTimeoutMs(
                    timeoutMs: timeoutMs,
                    onTimeout: { Error.timeout },
                    operation: operation)
            })
    }

    // MARK: - CLLocationManagerDelegate (nonisolated for Swift 6 compatibility)

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        Task { @MainActor in
            self.completeLocationRequests(with: locations.last.map { .success($0) } ?? .failure(Error.unavailable))
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Swift.Error) {
        Task { @MainActor in
            self.completeLocationRequests(with: .failure(error))
        }
    }
}
