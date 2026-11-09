import Foundation
import Synchronization
import Testing
@testable import OpenClawDiscovery

struct TailscaleServeGatewayDiscoveryBudgetTests {
    private static let status = #"{"Peer":{"one":{"DNSName":"lab.example.test.","HostName":"Lab","Online":true}}}"#
    private static let candidates = [
        "/usr/local/bin/tailscale",
        "/opt/homebrew/bin/tailscale",
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        "tailscale",
    ]

    private struct ProbeState: Sendable {
        var now = Date(timeIntervalSinceReferenceDate: 0)
        var paths: [String] = []
        var statusTimeouts: [TimeInterval] = []
        var probeTimeouts: [TimeInterval] = []
    }

    @Test(arguments: [0.25, 2.4])
    func `status fallback spends only the total discovery budget`(budget: TimeInterval) async {
        let state = Mutex(ProbeState())
        let context = TailscaleServeGatewayDiscovery.DiscoveryContext(
            run: { path, args, timeout in
                #expect(args == ["status", "--json"])
                state.withLock {
                    $0.paths.append(path)
                    $0.statusTimeouts.append(timeout)
                    $0.now.addTimeInterval(timeout)
                }
                return nil
            },
            probeHost: { _, timeout in
                state.withLock { $0.probeTimeouts.append(timeout) }
                return true
            },
            now: { state.withLock { $0.now } })

        let beacons = await TailscaleServeGatewayDiscovery.discover(timeoutSeconds: budget, context: context)
        let observed = state.withLock { $0 }
        let expected: [TimeInterval] = budget == 0.25 ? [0.25] : [1, 1, 0.4]
        #expect(observed.paths == Array(Self.candidates.prefix(expected.count)))
        #expect(observed.statusTimeouts.count == expected.count)
        for (actual, allowance) in zip(observed.statusTimeouts, expected) {
            #expect(abs(actual - allowance) < 0.000000001)
        }
        #expect(abs(observed.now.timeIntervalSinceReferenceDate - budget) < 0.000000001)
        #expect(observed.probeTimeouts.isEmpty)
        #expect(beacons.isEmpty)
    }

    @Test func `fourth status candidate leaves only remaining budget for gateway probe`() async {
        let state = Mutex(ProbeState())
        let context = TailscaleServeGatewayDiscovery.DiscoveryContext(
            run: { path, args, timeout in
                #expect(args == ["status", "--json"])
                return state.withLock {
                    $0.paths.append(path)
                    $0.statusTimeouts.append(timeout)
                    $0.now.addTimeInterval(0.1875)
                    return $0.paths.count == 4 ? Self.status : nil
                }
            },
            probeHost: { host, timeout in
                #expect(host == "lab.example.test")
                state.withLock {
                    $0.probeTimeouts.append(timeout)
                    $0.now.addTimeInterval(timeout)
                }
                return true
            },
            now: { state.withLock { $0.now } })

        let beacons = await TailscaleServeGatewayDiscovery.discover(timeoutSeconds: 1, context: context)
        let observed = state.withLock { $0 }
        #expect(observed.paths == Self.candidates)
        #expect(observed.statusTimeouts == [1, 0.8125, 0.625, 0.4375])
        #expect(observed.probeTimeouts == [0.25])
        #expect(observed.now.timeIntervalSinceReferenceDate == 1)
        #expect(beacons.count == 1)
        #expect(beacons.first?.displayName == "Lab")
        #expect(beacons.first?.host == "lab.example.test")
        #expect(beacons.first?.port == 443)
    }

    @Test(arguments: [1.0, 1.25])
    func `status result at or beyond deadline cannot start a gateway probe`(elapsed: TimeInterval) async {
        let state = Mutex(ProbeState())
        let context = TailscaleServeGatewayDiscovery.DiscoveryContext(
            run: { path, _, timeout in
                state.withLock {
                    $0.paths.append(path)
                    $0.statusTimeouts.append(timeout)
                    $0.now.addTimeInterval(elapsed)
                }
                return Self.status
            },
            probeHost: { _, timeout in
                state.withLock { $0.probeTimeouts.append(timeout) }
                return true
            },
            now: { state.withLock { $0.now } })

        let beacons = await TailscaleServeGatewayDiscovery.discover(timeoutSeconds: 1, context: context)
        let observed = state.withLock { $0 }
        #expect(observed.paths == [Self.candidates[0]])
        #expect(observed.statusTimeouts == [1])
        #expect(observed.probeTimeouts.isEmpty)
        #expect(beacons.isEmpty)
    }

    @Test func `legacy status remains once per discover and shares its elapsed time`() async {
        let state = Mutex(ProbeState())
        let context = TailscaleServeGatewayDiscovery.DiscoveryContext(
            tailscaleStatus: {
                state.withLock {
                    $0.paths.append("legacy")
                    $0.now.addTimeInterval(0.75)
                }
                return Self.status
            },
            probeHost: { _, timeout in
                state.withLock { $0.probeTimeouts.append(timeout) }
                return true
            },
            now: { state.withLock { $0.now } })

        for count in 1...2 {
            let beacons = await TailscaleServeGatewayDiscovery.discover(timeoutSeconds: 1, context: context)
            let observed = state.withLock { $0 }
            #expect(observed.paths.count == count)
            #expect(observed.probeTimeouts == Array(repeating: 0.25, count: count))
            #expect(beacons.count == 1)
        }
    }

    @Test func `unavailable or malformed legacy status never probes`() async {
        let outputs: [String?] = [nil, "not-json", "{}"]
        for output in outputs {
            let calls = Mutex(0)
            let context = TailscaleServeGatewayDiscovery.DiscoveryContext(
                tailscaleStatus: {
                    calls.withLock { $0 += 1 }
                    return output
                },
                probeHost: { _, _ in
                    Issue.record("Unexpected gateway probe without usable status")
                    return true
                })
            for count in 1...2 {
                let beacons = await TailscaleServeGatewayDiscovery.discover(context: context)
                #expect(calls.withLock { $0 } == count)
                #expect(beacons.isEmpty)
            }
        }
    }
}
