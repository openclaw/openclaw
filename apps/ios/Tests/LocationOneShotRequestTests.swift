import CoreLocation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

@MainActor
struct LocationOneShotRequestTests {
    @Test func `location service keeps incompatible accuracies separate`() async throws {
        var startedAccuracies: [CLLocationAccuracy] = []
        var requests: [LocationOneShotRequest] = []
        let service = LocationService { desiredAccuracy, _, onFinish in
            let request = LocationOneShotRequest(
                startRequest: {
                    startedAccuracies.append(desiredAccuracy)
                },
                stopRequest: {},
                onFinish: onFinish)
            requests.append(request)
            return request
        }

        let coarse = Task {
            @MainActor in
            try await service.currentLocation(
                params: OpenClawLocationGetParams(desiredAccuracy: .coarse),
                desiredAccuracy: .coarse,
                maxAgeMs: nil,
                timeoutMs: 10000)
        }
        await Task.yield()

        let precise = Task {
            @MainActor in
            try await service.currentLocation(
                params: OpenClawLocationGetParams(desiredAccuracy: .precise),
                desiredAccuracy: .precise,
                maxAgeMs: nil,
                timeoutMs: 10000)
        }
        await Task.yield()

        #expect(startedAccuracies == [kCLLocationAccuracyKilometer, kCLLocationAccuracyBest])
        #expect(requests.count == 2)

        let coarseLocation = CLLocation(latitude: 37.0, longitude: -122.0)
        let preciseLocation = CLLocation(latitude: 37.3349, longitude: -122.0090)
        requests[0].complete(with: [coarseLocation])
        requests[1].complete(with: [preciseLocation])

        let resolvedCoarse = try await coarse.value
        let resolvedPrecise = try await precise.value
        #expect(resolvedCoarse.coordinate.latitude == coarseLocation.coordinate.latitude)
        #expect(resolvedPrecise.coordinate.latitude == preciseLocation.coordinate.latitude)
    }

    @Test func `current location reuses one shot cache within max age`() async throws {
        var startCount = 0
        var requests: [LocationOneShotRequest] = []
        let service = LocationService { _, _, onFinish in
            let request = LocationOneShotRequest(
                startRequest: {
                    startCount += 1
                },
                stopRequest: {},
                onFinish: onFinish)
            requests.append(request)
            return request
        }

        let first = Task {
            @MainActor in
            try await service.currentLocation(
                params: OpenClawLocationGetParams(),
                desiredAccuracy: .balanced,
                maxAgeMs: nil,
                timeoutMs: 10000)
        }
        await Task.yield()

        #expect(startCount == 1)
        #expect(requests.count == 1)

        let location = CLLocation(latitude: 37.3349, longitude: -122.0090)
        requests[0].complete(with: [location])
        let firstLocation = try await first.value
        #expect(firstLocation.coordinate.latitude == location.coordinate.latitude)

        let cached = try await service.currentLocation(
            params: OpenClawLocationGetParams(maxAgeMs: 60000),
            desiredAccuracy: .balanced,
            maxAgeMs: 60000,
            timeoutMs: 10000)

        #expect(startCount == 1)
        #expect(cached.coordinate.longitude == location.coordinate.longitude)
    }

    @Test func `one shot request inherits background location setting`() async throws {
        var inheritedBackgroundFlags: [Bool] = []
        let service = LocationService { _, allowsBackgroundLocationUpdates, onFinish in
            inheritedBackgroundFlags.append(allowsBackgroundLocationUpdates)
            return LocationOneShotRequest(
                startRequest: {},
                stopRequest: {},
                onFinish: onFinish)
        }
        service.setBackgroundLocationUpdatesEnabled(true)

        let task = Task { @MainActor in try await service.requestLocationOnce() }
        await Task.yield()

        #expect(inheritedBackgroundFlags == [true])

        task.cancel()
        await #expect(throws: CancellationError.self) {
            try await task.value
        }
    }

    @Test func `concurrent waiters share one location request`() async throws {
        var startCount = 0
        var finishCount = 0
        let request = LocationOneShotRequest(
            startRequest: {
                startCount += 1
            },
            stopRequest: {},
            onFinish: { _ in
                finishCount += 1
            })

        let first = Task { @MainActor in try await request.location() }
        let second = Task { @MainActor in try await request.location() }
        await Task.yield()

        #expect(startCount == 1)

        let location = CLLocation(latitude: 37.3349, longitude: -122.0090)
        request.complete(with: [location])

        let firstLocation = try await first.value
        let secondLocation = try await second.value
        #expect(firstLocation.coordinate.latitude == location.coordinate.latitude)
        #expect(secondLocation.coordinate.longitude == location.coordinate.longitude)
        #expect(finishCount == 1)
    }

    @Test func `last cancelled waiter stops and finishes request`() async {
        var startCount = 0
        var stopCount = 0
        var finishCount = 0
        let request = LocationOneShotRequest(
            startRequest: {
                startCount += 1
            },
            stopRequest: {
                stopCount += 1
            },
            onFinish: { _ in
                finishCount += 1
            })

        let task = Task { @MainActor in try await request.location() }
        await Task.yield()

        #expect(startCount == 1)

        task.cancel()
        await #expect(throws: CancellationError.self) {
            try await task.value
        }
        #expect(stopCount == 1)
        #expect(finishCount == 1)
    }
}
