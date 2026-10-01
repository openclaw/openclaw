import CoreLocation
import Foundation

@MainActor
public protocol LocationServiceCommon: AnyObject, CLLocationManagerDelegate {
    var locationManager: CLLocationManager { get }
    var locationRequestContinuation: CheckedContinuation<CLLocation, Error>? { get set }
}

@MainActor
public protocol ConcurrentLocationServiceCommon: LocationServiceCommon, Sendable {
    var locationRequestContinuations: [UUID: CheckedContinuation<CLLocation, Error>] { get set }
}

extension LocationServiceCommon {
    public func configureLocationManager() {
        self.locationManager.delegate = self
        self.locationManager.desiredAccuracy = kCLLocationAccuracyBest
    }

    public func authorizationStatus() -> CLAuthorizationStatus {
        self.locationManager.authorizationStatus
    }

    public func accuracyAuthorization() -> CLAccuracyAuthorization {
        self.locationManager.accuracyAuthorization
    }
}

extension ConcurrentLocationServiceCommon {
    public func completeLocationRequests(with result: Result<CLLocation, Error>) {
        let continuations = Array(self.locationRequestContinuations.values) + [self.locationRequestContinuation]
            .compactMap(\.self)
        // Drain both stores before resuming so a later result cannot complete any waiter twice.
        self.locationRequestContinuations.removeAll()
        self.locationRequestContinuation = nil
        for continuation in continuations {
            continuation.resume(with: result)
        }
    }

    public func requestLocationOnce() async throws -> CLLocation {
        // CLLocationManager coalesces requestLocation calls into one pending fix, so every
        // active waiter shares the next delegate result; cancel the platform request only last.
        let requestID = UUID()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            let manager = self.locationManager
            return try await withCheckedThrowingContinuation { continuation in
                guard !Task.isCancelled else {
                    continuation.resume(throwing: CancellationError())
                    return
                }
                self.locationRequestContinuations[requestID] = continuation
                manager.requestLocation()
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                guard let self,
                      let continuation = self.locationRequestContinuations.removeValue(forKey: requestID)
                else {
                    return
                }
                if self.locationRequestContinuations.isEmpty,
                   self.locationRequestContinuation == nil
                {
                    self.locationManager.stopUpdatingLocation()
                }
                continuation.resume(throwing: CancellationError())
            }
        }
    }
}
