import Foundation
import Synchronization
import Testing
@testable import OpenClawDiscovery

struct WideAreaGatewayDiscoveryFollowupTests {
    private static let status = #"{"Self":{"TailscaleIPs":["100.64.0.1"]}}"#
    private static let ptr = "lab._openclaw-gw._tcp.example.test."
    private static let srv = "0 0 18789 lab.example.test."
    private static let txt = #""displayName=Lab" "gatewayPort=18789""#

    private actor StatusSpy {
        let output: String?
        private(set) var calls = 0

        init(output: String?) {
            self.output = output
        }

        func read() -> String? {
            self.calls += 1
            return self.output
        }
    }

    private struct ProbeState: Sendable {
        var now = Date(timeIntervalSinceReferenceDate: 0)
        var paths: [String] = []
        var queries: [String] = []
        var timeouts: [TimeInterval] = []
    }

    @Test func `legacy status adapter runs once per discover including reused context`() async {
        let outputs: [String?] = [nil, "not-json", "{}", Self.status]
        for output in outputs {
            let spy = StatusSpy(output: output)
            let queries = Mutex<[String]>([])
            let context = WideAreaGatewayDiscovery.DiscoveryContext(
                tailscaleStatus: { await spy.read() },
                dig: { args, _ in
                    let type = args.last ?? ""
                    queries.withLock { $0.append(type) }
                    switch type {
                    case "PTR": return Self.ptr
                    case "SRV": return Self.srv
                    case "TXT": return Self.txt
                    default: Issue.record("Unexpected DNS query"); return nil
                    }
                },
                now: { Date(timeIntervalSinceReferenceDate: 0) },
                serviceDomain: { "example.test." })

            for call in 1...2 {
                let beacons = await WideAreaGatewayDiscovery.discover(context: context)
                #expect(await spy.calls == call)
                if output == Self.status {
                    #expect(beacons.count == 1)
                    #expect(beacons.first?.displayName == "Lab")
                    #expect(queries.withLock { $0.count } == call * 3)
                } else {
                    #expect(beacons.isEmpty)
                    #expect(queries.withLock { $0.isEmpty })
                }
            }
        }
    }

    @Test func `command adapter retains all four status candidates then resolves DNS`() async {
        let state = Mutex(ProbeState())
        let context = WideAreaGatewayDiscovery.DiscoveryContext(
            run: { path, args, timeout in
                state.withLock {
                    if path != "/usr/bin/dig" {
                        #expect(args == ["status", "--json"])
                        $0.paths.append(path)
                        $0.timeouts.append(timeout)
                        return $0.paths.count == 4 ? Self.status : nil
                    }
                    let type = args.last ?? ""
                    $0.queries.append(type)
                    switch type {
                    case "PTR": return Self.ptr
                    case "SRV": return Self.srv
                    case "TXT": return Self.txt
                    default: Issue.record("Unexpected DNS query"); return nil
                    }
                }
            },
            now: { state.withLock { $0.now } },
            serviceDomain: { "example.test." })

        let beacons = await WideAreaGatewayDiscovery.discover(context: context)
        let observed = state.withLock { $0 }
        #expect(observed.paths == [
            "/usr/local/bin/tailscale",
            "/opt/homebrew/bin/tailscale",
            "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
            "tailscale",
        ])
        #expect(observed.timeouts == [0.7, 0.7, 0.7, 0.7])
        #expect(observed.queries == ["PTR", "SRV", "TXT"])
        #expect(beacons.count == 1)
        #expect(beacons.first?.host == "lab.example.test")
        #expect(beacons.first?.gatewayPort == 18789)
    }

    @Test(arguments: ["status", "PTR", "SRV", "TXT"], [1.0, 1.25])
    func `does not issue another probe at or after deadline`(
        exhaustedBy: String,
        elapsed: TimeInterval) async
    {
        let state = Mutex(ProbeState())
        let context = WideAreaGatewayDiscovery.DiscoveryContext(
            run: { path, args, timeout in
                state.withLock {
                    let type = path == "/usr/bin/dig" ? (args.last ?? "") : "status"
                    $0.queries.append(type)
                    $0.timeouts.append(timeout)
                    if type == exhaustedBy {
                        // Return usable data exactly at the deadline or after it.
                        $0.now = Date(timeIntervalSinceReferenceDate: elapsed)
                    }
                    switch type {
                    case "status": return Self.status
                    case "PTR": return Self.ptr + "\nsecond._openclaw-gw._tcp.example.test."
                    case "SRV": return Self.srv
                    case "TXT": return Self.txt
                    default: Issue.record("Unexpected probe"); return nil
                    }
                }
            },
            now: { state.withLock { $0.now } },
            serviceDomain: { "example.test." })

        let beacons = await WideAreaGatewayDiscovery.discover(timeoutSeconds: 1, context: context)
        let observed = state.withLock { $0 }
        let expectedQueries: [String]
        switch exhaustedBy {
        case "status": expectedQueries = ["status"]
        case "PTR": expectedQueries = ["status", "PTR"]
        case "SRV": expectedQueries = ["status", "PTR", "SRV"]
        default: expectedQueries = ["status", "PTR", "SRV", "TXT"]
        }
        #expect(observed.queries == expectedQueries)
        #expect(observed.timeouts.allSatisfy { $0 > 0 })
        if exhaustedBy == "SRV" || exhaustedBy == "TXT" {
            // An already-resolved SRV remains useful when TXT has no budget.
            #expect(beacons.count == 1)
            #expect(beacons.first?.host == "lab.example.test")
            #expect(beacons.first?.displayName == (exhaustedBy == "TXT" ? "Lab" : "lab"))
            #expect(beacons.first?.gatewayPort == (exhaustedBy == "TXT" ? 18789 : nil))
        } else {
            #expect(beacons.isEmpty)
        }
    }
}
