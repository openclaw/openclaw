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

    @MainActor @Test func `always mode starts significant location monitoring when always is granted`() async {
        let locationService = MockLocationService(authorizationStatus: .authorizedAlways)
        let appModel = NodeAppModel(locationService: locationService)

        let granted = await appModel.requestLocationPermissions(mode: .always)

        #expect(granted)
        #expect(locationService.backgroundUpdatesEnabled == true)
        #expect(locationService.stopMonitoringCallCount == 0)
        #expect(locationService.startMonitoringCallCount == 1)
    }

    @MainActor @Test func `always mode remains selected when ios only grants while using`() async {
        let locationService = MockLocationService(authorizationStatus: .authorizedWhenInUse)
        let appModel = NodeAppModel(locationService: locationService)

        let granted = await appModel.requestLocationPermissions(mode: .always)

        #expect(granted)
        #expect(locationService.backgroundUpdatesEnabled == false)
        #expect(locationService.stopMonitoringCallCount == 1)
    }

    @MainActor @Test func `external downgrade and always restoration reconcile significant monitoring`() {
        let defaultsKey = "location.enabledMode"
        let previous = UserDefaults.standard.object(forKey: defaultsKey)
        defer {
            if let previous {
                UserDefaults.standard.set(previous, forKey: defaultsKey)
            } else {
                UserDefaults.standard.removeObject(forKey: defaultsKey)
            }
        }
        UserDefaults.standard.set(OpenClawLocationMode.always.rawValue, forKey: defaultsKey)
        let locationService = MockLocationService(authorizationStatus: .authorizedAlways)
        let appModel = NodeAppModel(locationService: locationService)

        withExtendedLifetime(appModel) {
            locationService.simulateAuthorizationChange(.authorizedAlways)
            locationService.simulateAuthorizationChange(.authorizedWhenInUse)
            locationService.simulateAuthorizationChange(.authorizedAlways)
        }

        #expect(locationService.backgroundUpdatesEnabled == true)
        #expect(locationService.startMonitoringCallCount == 2)
        #expect(locationService.stopMonitoringCallCount == 1)
    }
}

@MainActor
private final class MockLocationService: LocationServicing, @unchecked Sendable {
    private var status: CLAuthorizationStatus
    private var authorizationChangeHandler: (@MainActor @Sendable (CLAuthorizationStatus) -> Void)?
    var backgroundUpdatesEnabled: Bool?
    var startMonitoringCallCount = 0
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

    func setAuthorizationChangeHandler(
        _ handler: @escaping @MainActor @Sendable (CLAuthorizationStatus) -> Void)
    {
        self.authorizationChangeHandler = handler
    }

    func startMonitoringSignificantLocationChanges(onUpdate: @escaping @Sendable (CLLocation) -> Void) {
        _ = onUpdate
        self.startMonitoringCallCount += 1
    }

    func stopMonitoringSignificantLocationChanges() {
        self.stopMonitoringCallCount += 1
    }

    func simulateAuthorizationChange(_ status: CLAuthorizationStatus) {
        self.status = status
        self.authorizationChangeHandler?(status)
    }
}
