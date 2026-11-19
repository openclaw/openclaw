import CoreLocation
import Foundation
import Testing
import XCTest
@testable import OpenClaw

/// Exercise on a fresh, task-owned iOS simulator with synthetic delegate inputs only.
@Suite(.serialized)
@MainActor
struct LocationServiceCallbackTests {
    enum Delivery: CaseIterable, Sendable {
        case locations
        case empty
        case failure
    }

    @Test(arguments: Delivery.allCases)
    func `delegate result completes concurrent waiters and drains the store`(
        delivery: Delivery) async throws
    {
        let service = LocationService()
        service.locationManager.delegate = nil
        // No authorization or location request is made; only synthetic delegate input is delivered.
        defer { service.locationManager.delegate = nil }
        let earlier = CLLocation(latitude: 1, longitude: 2)
        let latest = CLLocation(latitude: 3, longitude: 4)
        let failure = NSError(domain: "LocationCallbackFixture", code: 17)
        let registered = XCTestExpectation(description: "all waiters registered")
        registered.expectedFulfillmentCount = 3
        let completed = XCTestExpectation(description: "all waiters completed")
        completed.expectedFulfillmentCount = 3
        completed.assertForOverFulfill = true
        let waiters = [Waiter(), Waiter(), Waiter()]
        let tasks = waiters.map { waiter in
            Task { @MainActor in
                guard !Task.isCancelled else { return }
                do {
                    let location = try await withCheckedThrowingContinuation {
                        (continuation: CheckedContinuation<CLLocation, any Error>) in
                        service.locationRequestContinuations[waiter.requestID] = continuation
                        registered.fulfill()
                    }
                    waiter.result = .success(location)
                } catch {
                    waiter.result = .failure(error)
                }
                #expect(service.locationRequestContinuations.isEmpty)
                completed.fulfill()
            }
        }
        defer {
            for task in tasks {
                task.cancel()
            }
            // A missing delegate completion must fail promptly without leaking its suspended waiter.
            for waiter in waiters where waiter.result == nil {
                service.locationRequestContinuations.removeValue(forKey: waiter.requestID)?
                    .resume(throwing: CancellationError())
            }
        }
        let ready = await XCTWaiter.fulfillment(of: [registered], timeout: 5)
        try #require(ready == .completed)

        // A second delivery must not retain and resume any of the original checked continuations again.
        for _ in 0..<2 {
            switch delivery {
            case .locations:
                service.locationManager(service.locationManager, didUpdateLocations: [earlier, latest])
            case .empty:
                service.locationManager(service.locationManager, didUpdateLocations: [])
            case .failure:
                service.locationManager(service.locationManager, didFailWithError: failure)
            }
        }

        let finished = await XCTWaiter.fulfillment(of: [completed], timeout: 5)
        try #require(finished == .completed)
        for task in tasks {
            await task.value
        }
        for waiter in waiters {
            let result = try #require(waiter.result)
            switch (delivery, result) {
            case let (.locations, .success(location)):
                #expect(location === latest)
            case let (.empty, .failure(error)):
                guard case .unavailable? = error as? LocationService.Error else {
                    Issue.record("An empty update must fail with LocationService.Error.unavailable")
                    continue
                }
            case let (.failure, .failure(error)):
                let actual = error as NSError
                #expect(actual.domain == failure.domain)
                #expect(actual.code == failure.code)
            default:
                Issue.record("Delegate result did not match the delivered outcome")
            }
        }
        #expect(service.locationRequestContinuations.isEmpty)
    }
}

@MainActor
private final class Waiter {
    let requestID = UUID()
    var result: Result<CLLocation, any Error>?
}
