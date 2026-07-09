import CoreLocation
import Foundation
import OpenClawKit
import UIKit

@MainActor
final class LocationService: NSObject, CLLocationManagerDelegate, LocationServiceCommon {
    typealias LocationRequestFactory = @MainActor (
        _ desiredAccuracy: CLLocationAccuracy,
        _ allowsBackgroundLocationUpdates: Bool,
        _ onFinish: @escaping @MainActor (LocationOneShotRequest) -> Void) -> LocationOneShotRequest

    enum Error: Swift.Error {
        case timeout
        case unavailable
    }

    private let manager = CLLocationManager()
    private let locationRequestFactory: LocationRequestFactory
    private var authWaitID: UUID?
    private var authWaitRequiresDeterminedStatus = false
    private var authContinuation: CheckedContinuation<CLAuthorizationStatus, Never>?
    private var locationContinuation: CheckedContinuation<CLLocation, Swift.Error>?
    private var activeLocationRequests: [CLLocationAccuracy: LocationOneShotRequest] = [:]
    private var cachedOneShotLocation: CLLocation?
    private var backgroundLocationUpdatesEnabled = false
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

    override convenience init() {
        self.init { desiredAccuracy, allowsBackgroundLocationUpdates, onFinish in
            LocationOneShotRequest(
                desiredAccuracy: desiredAccuracy,
                allowsBackgroundLocationUpdates: allowsBackgroundLocationUpdates,
                onFinish: onFinish)
        }
    }

    init(locationRequestFactory: @escaping LocationRequestFactory) {
        self.locationRequestFactory = locationRequestFactory
        super.init()
        self.configureLocationManager()
    }

    func ensureAuthorization(mode: OpenClawLocationMode) async -> CLAuthorizationStatus {
        guard CLLocationManager.locationServicesEnabled() else { return .denied }

        let status = self.manager.authorizationStatus
        if status == .notDetermined {
            let updated = await self.requestAuthorization(requiresDeterminedStatus: true) {
                self.manager.requestWhenInUseAuthorization()
            }
            if mode != .always { return updated }
        }

        if mode == .always {
            let current = self.manager.authorizationStatus
            if current == .authorizedWhenInUse {
                return await self.requestAuthorization(requiresDeterminedStatus: false) {
                    self.manager.requestAlwaysAuthorization()
                }
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
        if let cached = self.cachedOneShotLocation(maxAgeMs: maxAgeMs) {
            return cached
        }
        let requestedAccuracy = LocationCurrentRequest.accuracyValue(desiredAccuracy)
        let location = try await LocationCurrentRequest.resolve(
            manager: self.manager,
            desiredAccuracy: desiredAccuracy,
            maxAgeMs: maxAgeMs,
            timeoutMs: timeoutMs,
            request: { try await self.requestLocationOnce(desiredAccuracy: requestedAccuracy) },
            withTimeout: { timeoutMs, operation in
                try await self.withTimeout(timeoutMs: timeoutMs, operation: operation)
            })
        self.cachedOneShotLocation = location
        return location
    }

    func requestLocationOnce() async throws -> CLLocation {
        try await self.requestLocationOnce(desiredAccuracy: self.manager.desiredAccuracy)
    }

    private func requestLocationOnce(desiredAccuracy: CLLocationAccuracy) async throws -> CLLocation {
        let request =
            self.activeLocationRequests[desiredAccuracy] ?? self.makeLocationOneShotRequest(
                desiredAccuracy: desiredAccuracy)
        return try await request.location()
    }

    private func makeLocationOneShotRequest(desiredAccuracy: CLLocationAccuracy) -> LocationOneShotRequest {
        let request = self
            .locationRequestFactory(desiredAccuracy, self.backgroundLocationUpdatesEnabled) { [weak self] request in
                if self?.activeLocationRequests[desiredAccuracy] === request {
                    self?.activeLocationRequests[desiredAccuracy] = nil
                }
            }
        self.activeLocationRequests[desiredAccuracy] = request
        return request
    }

    private func cachedOneShotLocation(maxAgeMs: Int?) -> CLLocation? {
        guard let maxAgeMs,
              let cached = self.cachedOneShotLocation,
              Date().timeIntervalSince(cached.timestamp) * 1000 <= Double(maxAgeMs)
        else {
            return nil
        }
        return cached
    }

    private func requestAuthorization(
        requiresDeterminedStatus: Bool,
        request: () -> Void) async -> CLAuthorizationStatus
    {
        await withCheckedContinuation { cont in
            let waitID = UUID()
            self.authWaitID = waitID
            self.authWaitRequiresDeterminedStatus = requiresDeterminedStatus
            self.authContinuation = cont
            // Install the waiter before requesting permission so a fast delegate callback cannot be lost.
            request()
            Task { @MainActor in
                let clock = ContinuousClock()
                let noPromptDeadline = clock.now.advanced(by: .milliseconds(1500))
                var activeUndeterminedDeadline: ContinuousClock.Instant?
                var observedPrompt = UIApplication.shared.applicationState != .active
                // A slow system prompt must not trigger the no-callback fallback. Once iOS makes
                // the app inactive, wait until the user dismisses the prompt and the app returns.
                while self.authWaitID == waitID, self.authContinuation != nil {
                    try? await Task.sleep(for: .milliseconds(100))
                    let applicationIsActive = UIApplication.shared.applicationState == .active
                    if !applicationIsActive {
                        observedPrompt = true
                        activeUndeterminedDeadline = nil
                        continue
                    }
                    guard observedPrompt || clock.now >= noPromptDeadline else { continue }
                    let status = self.manager.authorizationStatus
                    if Self.shouldCompleteAuthorizationWait(
                        status: status,
                        requiresDeterminedStatus: requiresDeterminedStatus)
                    {
                        self.finishAuthorizationWait(waitID: waitID, status: status)
                        continue
                    }
                    if observedPrompt, activeUndeterminedDeadline == nil {
                        activeUndeterminedDeadline = clock.now.advanced(by: .milliseconds(1500))
                    }
                    let fallbackDeadline = activeUndeterminedDeadline ?? noPromptDeadline
                    guard clock.now >= fallbackDeadline else { continue }
                    self.finishAuthorizationWait(
                        waitID: waitID,
                        status: status,
                        allowUndeterminedFallback: true)
                }
            }
        }
    }

    nonisolated static func shouldCompleteAuthorizationWait(
        status: CLAuthorizationStatus,
        requiresDeterminedStatus: Bool,
        allowUndeterminedFallback: Bool = false) -> Bool
    {
        allowUndeterminedFallback || !requiresDeterminedStatus || status != .notDetermined
    }

    private func finishAuthorizationWait(
        waitID: UUID,
        status: CLAuthorizationStatus,
        allowUndeterminedFallback: Bool = false)
    {
        guard self.authWaitID == waitID, let cont = self.authContinuation else { return }
        guard Self.shouldCompleteAuthorizationWait(
            status: status,
            requiresDeterminedStatus: self.authWaitRequiresDeterminedStatus,
            allowUndeterminedFallback: allowUndeterminedFallback)
        else { return }
        self.authWaitID = nil
        self.authWaitRequiresDeterminedStatus = false
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
        self.backgroundLocationUpdatesEnabled = enabled
        self.manager.allowsBackgroundLocationUpdates = enabled
        for request in self.activeLocationRequests.values {
            request.setBackgroundLocationUpdatesEnabled(enabled)
        }
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

@MainActor
final class LocationOneShotRequest: NSObject, CLLocationManagerDelegate {
    private struct Waiter {
        let id: UUID
        let continuation: CheckedContinuation<CLLocation, Swift.Error>
    }

    private let manager: CLLocationManager?
    private let startRequest: @MainActor () -> Void
    private let stopRequest: @MainActor () -> Void
    private let onFinish: @MainActor (LocationOneShotRequest) -> Void
    private var waiters: [Waiter] = []
    private var didStart = false
    private var didFinish = false

    init(
        desiredAccuracy: CLLocationAccuracy,
        allowsBackgroundLocationUpdates: Bool,
        onFinish: @escaping @MainActor (LocationOneShotRequest) -> Void)
    {
        let manager = CLLocationManager()
        self.manager = manager
        self.startRequest = {
            manager.requestLocation()
        }
        self.stopRequest = {
            manager.stopUpdatingLocation()
            manager.delegate = nil
        }
        self.onFinish = onFinish
        super.init()
        manager.desiredAccuracy = desiredAccuracy
        manager.allowsBackgroundLocationUpdates = allowsBackgroundLocationUpdates
        manager.delegate = self
    }

    init(
        startRequest: @escaping @MainActor () -> Void,
        stopRequest: @escaping @MainActor () -> Void,
        onFinish: @escaping @MainActor (LocationOneShotRequest) -> Void)
    {
        self.manager = nil
        self.startRequest = startRequest
        self.stopRequest = stopRequest
        self.onFinish = onFinish
        super.init()
    }

    func location() async throws -> CLLocation {
        let waiterID = UUID()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                guard !Task.isCancelled else {
                    continuation.resume(throwing: CancellationError())
                    return
                }
                self.addWaiter(id: waiterID, continuation: continuation)
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                self?.cancelWaiter(id: waiterID)
            }
        }
    }

    func complete(with locations: [CLLocation]) {
        if let latest = locations.last {
            self.finish(.success(latest))
        } else {
            self.finish(.failure(LocationService.Error.unavailable))
        }
    }

    func fail(with error: Swift.Error) {
        self.finish(.failure(error))
    }

    func setBackgroundLocationUpdatesEnabled(_ enabled: Bool) {
        self.manager?.allowsBackgroundLocationUpdates = enabled
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let locs = locations
        Task { @MainActor in
            self.complete(with: locs)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Swift.Error) {
        let err = error
        Task { @MainActor in
            self.fail(with: err)
        }
    }

    private func addWaiter(
        id: UUID,
        continuation: CheckedContinuation<CLLocation, Swift.Error>)
    {
        guard !self.didFinish else {
            continuation.resume(throwing: LocationService.Error.unavailable)
            return
        }
        self.waiters.append(Waiter(id: id, continuation: continuation))
        guard !self.didStart else { return }
        self.didStart = true
        self.startRequest()
    }

    private func cancelWaiter(id: UUID) {
        guard let index = self.waiters.firstIndex(where: { $0.id == id }) else { return }
        let waiter = self.waiters.remove(at: index)
        waiter.continuation.resume(throwing: CancellationError())
        if self.waiters.isEmpty {
            self.finishWithoutWaiters()
        }
    }

    private func finishWithoutWaiters() {
        guard !self.didFinish else { return }
        self.didFinish = true
        self.stopRequest()
        self.onFinish(self)
    }

    private func finish(_ result: Result<CLLocation, Swift.Error>) {
        guard !self.didFinish else { return }
        self.didFinish = true
        let waiters = self.waiters
        self.waiters.removeAll()
        self.stopRequest()
        self.onFinish(self)
        for waiter in waiters {
            switch result {
            case let .success(location):
                waiter.continuation.resume(returning: location)
            case let .failure(error):
                waiter.continuation.resume(throwing: error)
            }
        }
    }
}
