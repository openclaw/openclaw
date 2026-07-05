import CoreLocation
import Foundation
import OpenClawKit
import UIKit

@MainActor
final class LocationService: NSObject, CLLocationManagerDelegate, LocationServiceCommon {
    enum Error: Swift.Error {
        case timeout
        case unavailable
    }

    private let manager = CLLocationManager()
    private var authWaitID: UUID?
    private var authContinuation: CheckedContinuation<CLAuthorizationStatus, Never>?
    private var locationContinuation: CheckedContinuation<CLLocation, Swift.Error>?
    private var authorizationChangeHandler: (@MainActor @Sendable (CLAuthorizationStatus) -> Void)?
    private var significantLocationCallback: (@Sendable (CLLocation) -> Void)?
    private var isMonitoringSignificantChanges = false

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

    func ensureAuthorization(mode: OpenClawLocationMode) async -> CLAuthorizationStatus {
        guard CLLocationManager.locationServicesEnabled() else { return .denied }

        let status = self.manager.authorizationStatus
        if status == .notDetermined {
            self.manager.requestWhenInUseAuthorization()
            let updated = await self.awaitAuthorizationChange()
            if mode != .always { return updated }
        }

        if mode == .always {
            let current = self.manager.authorizationStatus
            if current == .authorizedWhenInUse {
                self.manager.requestAlwaysAuthorization()
                return await self.awaitAuthorizationChange()
            }
            return current
        }

        return self.manager.authorizationStatus
    }

    func currentLocation(
        params: OpenClawLocationGetParams,
        desiredAccuracy: OpenClawLocationAccuracy,
        maxAgeMs: Int?,
        timeoutMs: Int?) async throws -> CLLocation
    {
        _ = params
        return try await LocationCurrentRequest.resolve(
            manager: self.manager,
            desiredAccuracy: desiredAccuracy,
            maxAgeMs: maxAgeMs,
            timeoutMs: timeoutMs,
            request: { try await self.requestLocationOnce() },
            withTimeout: { timeoutMs, operation in
                try await self.withTimeout(timeoutMs: timeoutMs, operation: operation)
            })
    }

    private func awaitAuthorizationChange() async -> CLAuthorizationStatus {
        await withCheckedContinuation { cont in
            let waitID = UUID()
            self.authWaitID = waitID
            self.authContinuation = cont
            Task { @MainActor in
                let clock = ContinuousClock()
                let noPromptDeadline = clock.now.advanced(by: .milliseconds(1500))
                var observedPrompt = UIApplication.shared.applicationState != .active
                // A slow system prompt must not trigger the no-callback fallback. Once iOS makes
                // the app inactive, wait until the user dismisses the prompt and the app returns.
                while self.authWaitID == waitID, self.authContinuation != nil {
                    try? await Task.sleep(for: .milliseconds(100))
                    let applicationIsActive = UIApplication.shared.applicationState == .active
                    if !applicationIsActive {
                        observedPrompt = true
                        continue
                    }
                    guard observedPrompt || clock.now >= noPromptDeadline else { continue }
                    self.finishAuthorizationWait(waitID: waitID, status: self.manager.authorizationStatus)
                }
            }
        }
    }

    private func finishAuthorizationWait(waitID: UUID, status: CLAuthorizationStatus) {
        guard self.authWaitID == waitID, let cont = self.authContinuation else { return }
        self.authWaitID = nil
        self.authContinuation = nil
        cont.resume(returning: status)
    }

    private func withTimeout<T: Sendable>(
        timeoutMs: Int,
        operation: @escaping @Sendable () async throws -> T) async throws -> T
    {
        try await AsyncTimeout.withTimeoutMs(timeoutMs: timeoutMs, onTimeout: { Error.timeout }, operation: operation)
    }

    func startMonitoringSignificantLocationChanges(onUpdate: @escaping @Sendable (CLLocation) -> Void) {
        self.significantLocationCallback = onUpdate
        guard !self.isMonitoringSignificantChanges else { return }
        self.isMonitoringSignificantChanges = true
        self.manager.startMonitoringSignificantLocationChanges()
    }

    func setBackgroundLocationUpdatesEnabled(_ enabled: Bool) {
        self.manager.allowsBackgroundLocationUpdates = enabled
    }

    func setAuthorizationChangeHandler(
        _ handler: @escaping @MainActor @Sendable (CLAuthorizationStatus) -> Void)
    {
        self.authorizationChangeHandler = handler
    }

    func stopMonitoringSignificantLocationChanges() {
        self.significantLocationCallback = nil
        self.isMonitoringSignificantChanges = false
        self.manager.stopMonitoringSignificantLocationChanges()
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            self.authorizationChangeHandler?(status)
            guard let waitID = self.authWaitID else { return }
            self.finishAuthorizationWait(waitID: waitID, status: status)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let locs = locations
        Task { @MainActor in
            // Resolve the one-shot continuation first (if any).
            if let cont = self.locationContinuation {
                self.locationContinuation = nil
                if let latest = locs.last {
                    cont.resume(returning: latest)
                } else {
                    cont.resume(throwing: Error.unavailable)
                }
                // Don't return — also forward to significant-change callback below
                // so both consumers receive updates when both are active.
            }
            if let callback = self.significantLocationCallback, let latest = locs.last {
                callback(latest)
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Swift.Error) {
        let err = error
        Task { @MainActor in
            guard let cont = self.locationContinuation else { return }
            self.locationContinuation = nil
            cont.resume(throwing: err)
        }
    }
}
