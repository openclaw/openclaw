import CoreLocation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct PermissionManagerLocationTests {
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
            await coordinator.wait(isCurrent: { isCurrent }) { _ in enqueued.open() }
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
