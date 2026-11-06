import CoreLocation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct PermissionManagerLocationTests {
    @Test(arguments: [CLAuthorizationStatus.denied, .restricted])
    func `denied Location resolves Settings before enablement consent`(_ status: CLAuthorizationStatus) async {
        let manager = FixtureLocationManager(status: status)
        var openedSettings = 0
        var enablementRequests = 0
        let requester = LocationPermissionRequester(
            manager: manager, locationServicesEnabled: { true }, openSettings: { openedSettings += 1 })
        await PermissionManager.resolve([.location], location: requester, isCurrent: { true }) { _ in
            enablementRequests += 1
            return false
        }
        #expect(openedSettings == 1)
        #expect(enablementRequests == 0)
        #expect(manager.authorizationRequests == 0)
    }

    @Test
    func `disabled Location Services resolves Settings without enablement consent`() async {
        let manager = FixtureLocationManager(status: .authorizedAlways)
        var openedSettings = 0
        var enablementRequests = 0
        let requester = LocationPermissionRequester(
            manager: manager, locationServicesEnabled: { false }, openSettings: { openedSettings += 1 })
        await PermissionManager.resolve([.location], location: requester, isCurrent: { true }) { _ in
            enablementRequests += 1
            return false
        }
        #expect(openedSettings == 1)
        #expect(enablementRequests == 0)
        #expect(manager.authorizationRequests == 0)
        #expect(requester.authorizationStatus == .denied)
    }

    @Test(arguments: [CLAuthorizationStatus.notDetermined, .authorizedAlways])
    func `promptable and granted Location still require enablement consent`(_ status: CLAuthorizationStatus) async {
        let manager = FixtureLocationManager(status: status)
        var openedSettings = 0
        var enablementRequests = 0
        let requester = LocationPermissionRequester(
            manager: manager, locationServicesEnabled: { true }, openSettings: { openedSettings += 1 })
        await PermissionManager.resolve([.location], location: requester, isCurrent: { true }) { _ in
            enablementRequests += 1
            return false
        }
        #expect(enablementRequests == 1)
        #expect(openedSettings == 0)
        #expect(manager.authorizationRequests == 0)
    }

    @Test(arguments: [CLAuthorizationStatus.denied, .restricted])
    func `enabling Location opens Settings when macOS cannot prompt again`(_ status: CLAuthorizationStatus) async {
        let manager = FixtureLocationManager(status: status)
        var openedSettings = 0
        let requester = LocationPermissionRequester(
            manager: manager, locationServicesEnabled: { true }, openSettings: { openedSettings += 1 })
        let result = await requester.request(always: false)
        #expect(result == status)
        #expect(openedSettings == 1)
        #expect(manager.authorizationRequests == 0)
    }

    @Test(arguments: [CLAuthorizationStatus.notDetermined, .authorizedAlways])
    func `enabling Location requests only an undetermined grant`(_ status: CLAuthorizationStatus) async {
        let manager = FixtureLocationManager(status: status)
        var openedSettings = 0
        let requester = LocationPermissionRequester(
            manager: manager, locationServicesEnabled: { true }, openSettings: { openedSettings += 1 })
        #expect(await requester.request(always: false) == .authorizedAlways)
        #expect(manager.authorizationRequests == (status == .notDetermined ? 1 : 0))
        #expect(openedSettings == 0)
    }

    @Test
    func `concurrent request waiters all resume`() async {
        let coordinator = LocationPermissionRequestCoordinator()
        let first = Task { @MainActor in
            await coordinator.wait { _ in }
        }
        while coordinator.pendingRequestCount < 1 {
            await Task.yield()
        }

        let second = Task { @MainActor in
            await coordinator.wait { _ in }
        }
        while coordinator.pendingRequestCount < 2 {
            await Task.yield()
        }

        coordinator.finish(status: .denied)

        #expect(await first.value == .denied)
        #expect(await second.value == .denied)
        #expect(coordinator.pendingRequestCount == 0)
    }

    @Test func `delayed location recovery loses authority when its caller retires`() async {
        let coordinator = LocationPermissionRequestCoordinator()
        let enqueued = AsyncTestGate()
        var isCurrent = true
        let request = Task { @MainActor in
            await coordinator.wait(isCurrent: { isCurrent }, onEnqueue: { _ in enqueued.open() })
        }
        await enqueued.wait()
        #expect(coordinator.hasCurrentRequests)
        isCurrent = false
        #expect(!coordinator.hasCurrentRequests)
        coordinator.finish(status: .denied)
        #expect(await request.value == .denied)
    }

    @Test
    func `authorizedAlways counts for both modes`() {
        #expect(PermissionManager.isLocationAuthorized(status: .authorizedAlways, requireAlways: false))
        #expect(PermissionManager.isLocationAuthorized(status: .authorizedAlways, requireAlways: true))
    }

    @Test
    func `other statuses not authorized`() {
        #expect(!PermissionManager.isLocationAuthorized(status: .notDetermined, requireAlways: false))
        #expect(!PermissionManager.isLocationAuthorized(status: .denied, requireAlways: false))
        #expect(!PermissionManager.isLocationAuthorized(status: .restricted, requireAlways: false))
    }
}

private final class FixtureLocationManager: CLLocationManager {
    private let status: CLAuthorizationStatus
    private(set) var authorizationRequests = 0

    init(status: CLAuthorizationStatus) {
        self.status = status
        super.init()
    }

    override var authorizationStatus: CLAuthorizationStatus {
        self.status
    }

    override func requestWhenInUseAuthorization() {
        self.authorizationRequests += 1
    }

    override func requestLocation() {
        let result = self.status == .notDetermined ? CLAuthorizationStatus.authorizedAlways : self.status
        self.delegate?.locationManager?(self, didChangeAuthorization: result)
    }
}
