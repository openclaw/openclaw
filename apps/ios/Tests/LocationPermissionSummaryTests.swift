import CoreLocation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

@Suite(.serialized) struct LocationPermissionSummaryTests {
    @Test func `always desired when in use authorized needs attention`() {
        let summary = LocationPermissionSummary(
            desiredMode: .always,
            locationServicesEnabled: true,
            authorizationStatus: .authorizedWhenInUse,
            accuracyAuthorization: .fullAccuracy)

        #expect(summary.effectiveMode == .whileUsing)
        #expect(!summary.canUseLocationInBackground)
        #expect(summary.needsAttention)
        #expect(summary.statusText == "While Using")
        #expect(summary.detailText.contains("Always is selected"))
    }

    @Test func `always desired authorized always allows background`() {
        let summary = LocationPermissionSummary(
            desiredMode: .always,
            locationServicesEnabled: true,
            authorizationStatus: .authorizedAlways,
            accuracyAuthorization: .reducedAccuracy)

        #expect(summary.effectiveMode == .always)
        #expect(summary.canUseLocationInBackground)
        #expect(!summary.needsAttention)
        #expect(summary.detailText.contains("Background location requests"))
        #expect(summary.detailText.contains("Precise Location is off"))
    }

    @Test func `off desired ignores granted permission`() {
        let summary = LocationPermissionSummary(
            desiredMode: .off,
            locationServicesEnabled: false,
            authorizationStatus: .authorizedAlways,
            accuracyAuthorization: .fullAccuracy)

        #expect(summary.effectiveMode == .off)
        #expect(!summary.canUseLocationInBackground)
        #expect(!summary.needsAttention)
        #expect(summary.detailText.contains("Location sharing is disabled"))
        #expect(summary.detailText.contains("Location Services are off"))
    }

    @Test func `off desired still reports ios always grant`() {
        let summary = LocationPermissionSummary(
            desiredMode: .off,
            locationServicesEnabled: true,
            authorizationStatus: .authorizedAlways,
            accuracyAuthorization: .fullAccuracy)

        #expect(summary.effectiveMode == .off)
        #expect(!summary.canUseLocationInBackground)
        #expect(!summary.needsAttention)
        #expect(summary.detailText.contains("Location sharing is disabled"))
        #expect(summary.detailText.contains("Always"))
    }

    @Test func `off desired still reports ios while using grant`() {
        let summary = LocationPermissionSummary(
            desiredMode: .off,
            locationServicesEnabled: true,
            authorizationStatus: .authorizedWhenInUse,
            accuracyAuthorization: .fullAccuracy)

        #expect(summary.effectiveMode == .off)
        #expect(!summary.canUseLocationInBackground)
        #expect(!summary.needsAttention)
        #expect(summary.detailText.contains("Location sharing is disabled"))
        #expect(summary.detailText.contains("While Using"))
    }

    @Test func `disabled location services override app grant`() {
        let summary = LocationPermissionSummary(
            desiredMode: .always,
            locationServicesEnabled: false,
            authorizationStatus: .authorizedAlways,
            accuracyAuthorization: .fullAccuracy)

        #expect(summary.effectiveMode == .off)
        #expect(!summary.canUseLocationInBackground)
        #expect(summary.needsAttention)
        #expect(summary.statusText == "Off")
        #expect(summary.detailText == "Location Services are off in iOS Settings.")
    }

    @Test func `external ios always grant preserves disabled app mode`() {
        let mode = LocationPermissionSummary.reconciledDesiredMode(
            currentMode: .off,
            locationServicesEnabled: true,
            authorizationStatus: .authorizedAlways)

        #expect(mode == .off)
    }

    @Test func `external ios while using grant preserves disabled app mode`() {
        let mode = LocationPermissionSummary.reconciledDesiredMode(
            currentMode: .off,
            locationServicesEnabled: true,
            authorizationStatus: .authorizedWhenInUse)

        #expect(mode == .off)
    }

    @Test func `external ios always grant preserves while using app mode`() {
        let mode = LocationPermissionSummary.reconciledDesiredMode(
            currentMode: .whileUsing,
            locationServicesEnabled: true,
            authorizationStatus: .authorizedAlways)

        #expect(mode == .whileUsing)
    }

    @Test func `ios while using grant preserves always intent for mismatch warning`() {
        let mode = LocationPermissionSummary.reconciledDesiredMode(
            currentMode: .always,
            locationServicesEnabled: true,
            authorizationStatus: .authorizedWhenInUse)

        #expect(mode == .always)
    }

    @Test func `disabled location services preserve selected app mode for warning`() {
        let mode = LocationPermissionSummary.reconciledDesiredMode(
            currentMode: .always,
            locationServicesEnabled: false,
            authorizationStatus: .authorizedAlways)

        #expect(mode == .always)
    }

    @MainActor @Test func `off mode stops significant location monitoring`() async {
        let locationService = MockLocationService(authorizationStatus: .authorizedAlways)
        let appModel = NodeAppModel(locationService: locationService)

        let granted = await appModel.requestLocationPermissions(mode: .off)

        #expect(granted)
        #expect(locationService.backgroundUpdatesEnabled == false)
        #expect(locationService.stopMonitoringCallCount == 1)
    }

    @MainActor @Test func `while using mode stops significant location monitoring when always remains granted`() async {
        let locationService = MockLocationService(authorizationStatus: .authorizedAlways)
        let appModel = NodeAppModel(locationService: locationService)

        let granted = await appModel.requestLocationPermissions(mode: .whileUsing)

        #expect(granted)
        #expect(locationService.backgroundUpdatesEnabled == false)
        #expect(locationService.stopMonitoringCallCount == 1)
    }

    @MainActor @Test func `always mode keeps significant location monitoring eligible when always is granted`() async {
        let locationService = MockLocationService(authorizationStatus: .authorizedAlways)
        let appModel = NodeAppModel(locationService: locationService)

        let granted = await appModel.requestLocationPermissions(mode: .always)

        #expect(granted)
        #expect(locationService.backgroundUpdatesEnabled == true)
        #expect(locationService.stopMonitoringCallCount == 0)
    }

    @MainActor @Test func `always mode remains selected when ios only grants while using`() async {
        let locationService = MockLocationService(authorizationStatus: .authorizedWhenInUse)
        let appModel = NodeAppModel(locationService: locationService)

        let granted = await appModel.requestLocationPermissions(mode: .always)

        #expect(granted)
        #expect(locationService.backgroundUpdatesEnabled == false)
        #expect(locationService.stopMonitoringCallCount == 1)
    }

    @MainActor @Test func `authorization downgrade stops significant location monitoring`() {
        let locationService = MockLocationService(authorizationStatus: .authorizedAlways)

        locationService.reconcileBackgroundMonitoringAuthorization(.authorizedWhenInUse)

        #expect(locationService.backgroundUpdatesEnabled == false)
        #expect(locationService.stopMonitoringCallCount == 1)
    }

    @MainActor @Test func `authorized always keeps significant location monitoring active`() {
        let locationService = MockLocationService(authorizationStatus: .authorizedAlways)

        locationService.reconcileBackgroundMonitoringAuthorization(.authorizedAlways)

        #expect(locationService.backgroundUpdatesEnabled == nil)
        #expect(locationService.stopMonitoringCallCount == 0)
    }
}

@MainActor
private final class MockLocationService: LocationServicing, @unchecked Sendable {
    private let status: CLAuthorizationStatus
    var backgroundUpdatesEnabled: Bool?
    var stopMonitoringCallCount = 0

    init(authorizationStatus: CLAuthorizationStatus) {
        self.status = authorizationStatus
    }

    func authorizationStatus() -> CLAuthorizationStatus {
        self.status
    }

    func accuracyAuthorization() -> CLAccuracyAuthorization {
        .fullAccuracy
    }

    func ensureAuthorization(mode: OpenClawLocationMode) async -> CLAuthorizationStatus {
        _ = mode
        return self.status
    }

    func currentLocation(
        params: OpenClawLocationGetParams,
        desiredAccuracy: OpenClawLocationAccuracy,
        maxAgeMs: Int?,
        timeoutMs: Int?) async throws -> CLLocation
    {
        _ = params
        _ = desiredAccuracy
        _ = maxAgeMs
        _ = timeoutMs
        throw LocationService.Error.unavailable
    }

    func setBackgroundLocationUpdatesEnabled(_ enabled: Bool) {
        self.backgroundUpdatesEnabled = enabled
    }

    func startMonitoringSignificantLocationChanges(onUpdate: @escaping @Sendable (CLLocation) -> Void) {
        _ = onUpdate
    }

    func stopMonitoringSignificantLocationChanges() {
        self.stopMonitoringCallCount += 1
    }
}
