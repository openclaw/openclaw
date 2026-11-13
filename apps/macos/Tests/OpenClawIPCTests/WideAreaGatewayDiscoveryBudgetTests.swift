import Foundation
import Synchronization
import Testing
@testable import OpenClawDiscovery

struct WideAreaGatewayDiscoveryBudgetTests {
    private struct ProbeState {
        var now = Date(timeIntervalSinceReferenceDate: 0)
        var paths: [String] = []
        var timeouts: [TimeInterval] = []
    }

    @Test(arguments: [0.25, 2.0])
    func `status candidates share the discovery budget`(budget: TimeInterval) async {
        let state = Mutex(ProbeState())
        let context = WideAreaGatewayDiscovery.DiscoveryContext(
            run: { path, arguments, timeout in
                #expect(arguments == ["status", "--json"])
                // Model a candidate consuming its allotted command timeout and
                // returning no status. No process, timer, or suspended task exists.
                state.withLock {
                    $0.paths.append(path)
                    $0.timeouts.append(timeout)
                    $0.now.addTimeInterval(timeout)
                }
                return nil
            },
            now: { state.withLock { $0.now } })

        let beacons = await WideAreaGatewayDiscovery.discover(timeoutSeconds: budget, context: context)
        let observed = state.withLock { $0 }
        let expectedTimeouts: [TimeInterval] = budget == 0.25 ? [0.25] : [0.7, 0.7, 0.6]
        let expectedPaths = Array([
            "/usr/local/bin/tailscale",
            "/opt/homebrew/bin/tailscale",
            "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        ].prefix(expectedTimeouts.count))

        #expect(beacons.isEmpty)
        #expect(observed.paths == expectedPaths)
        #expect(observed.timeouts.count == expectedTimeouts.count)
        for (actual, expected) in zip(observed.timeouts, expectedTimeouts) {
            #expect(abs(actual - expected) < 0.000000001)
        }
        #expect(abs(observed.now.timeIntervalSinceReferenceDate - budget) < 0.000000001)
    }
}
