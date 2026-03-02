import CoreLocation
import Foundation
import OpenClawKit

@MainActor
final class MacNodeLocationService: NSObject, CLLocationManagerDelegate, LocationServiceCommon {
    enum Error: Swift.Error {
        case timeout
        case unavailable
    }

    private let manager = CLLocationManager()
    private var locationContinuation: CheckedContinuation<CLLocation, Swift.Error>?

    var locationManager: CLLocationManager {
        self.manager
    }

    var locationRequestContinuation: CheckedContinuation<CLLocation, Swift.Error>? {
        get { self.locationContinuation }
        set { self.locationContinuation = newValue }
    }

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
            manager: self.manager,
            desiredAccuracy: desiredAccuracy,
            maxAgeMs: maxAgeMs,
            timeoutMs: timeoutMs,
            request: { try await self.requestLocationOnce() }) { timeoutMs, operation in
                try await self.withTimeout(timeoutMs: timeoutMs) {
                    try await operation()
                }
        }
    }

    private func withTimeout<T: Sendable>(
        timeoutMs: Int,
        operation: @escaping () async throws -> T) async throws -> T
    {
        if timeoutMs == 0 {
            return try await operation()
        }

        return try await withCheckedThrowingContinuation { continuation in
            var didFinish = false

            func finish(returning value: T) {
                guard !didFinish else { return }
                didFinish = true
                continuation.resume(returning: value)
            }

            func finish(throwing error: Swift.Error) {
                guard !didFinish else { return }
                didFinish = true
                continuation.resume(throwing: error)
            }

            let timeoutItem = DispatchWorkItem {
                finish(throwing: Error.timeout)
            }
            DispatchQueue.main.asyncAfter(
                deadline: .now() + .milliseconds(timeoutMs),
                execute: timeoutItem)

            Task { @MainActor in
                do {
                    let value = try await operation()
                    timeoutItem.cancel()
                    finish(returning: value)
                } catch {
                    timeoutItem.cancel()
                    finish(throwing: error)
                }
            }
        }
    }

    // MARK: - CLLocationManagerDelegate (nonisolated for Swift 6 compatibility)

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        Task { @MainActor in
            guard let cont = self.locationContinuation else { return }
            self.locationContinuation = nil
            if let latest = locations.last {
                cont.resume(returning: latest)
            } else {
                cont.resume(throwing: Error.unavailable)
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Swift.Error) {
        let errorCopy = error // Capture error for Sendable compliance
        Task { @MainActor in
            guard let cont = self.locationContinuation else { return }
            self.locationContinuation = nil
            cont.resume(throwing: errorCopy)
        }
    }
}
