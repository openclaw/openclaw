import Darwin
import Foundation
import Testing
@testable import MullusiDiscovery

private final class NameserverQueryLog: @unchecked Sendable {
    private let lock = NSLock()
    private var nameservers: [String] = []

    func record(_ nameserver: String) {
        self.lock.lock()
        defer { self.lock.unlock() }
        self.nameservers.append(nameserver)
    }

    func count(matching nameserver: String) -> Int {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.nameservers.filter { $0 == nameserver }.count
    }
}

@Suite(.serialized)
struct WideAreaGatewayDiscoveryTests {
    @Test func `discovers beacon from tailnet dns sd fallback`() {
        let originalWideAreaDomain = getenv("MULLUSI_WIDE_AREA_DOMAIN").map { String(cString: $0) }
        setenv("MULLUSI_WIDE_AREA_DOMAIN", "mullusi.internal", 1)
        defer {
            if let originalWideAreaDomain {
                setenv("MULLUSI_WIDE_AREA_DOMAIN", originalWideAreaDomain, 1)
            } else {
                unsetenv("MULLUSI_WIDE_AREA_DOMAIN")
            }
        }
        let statusJson = """
        {
          "Self": { "TailscaleIPs": ["100.69.232.64"] },
          "Peer": {
            "peer-1": { "TailscaleIPs": ["100.123.224.76"] }
          }
        }
        """

        let context = WideAreaGatewayDiscovery.DiscoveryContext(
            tailscaleStatus: { statusJson },
            dig: { args, _ in
                let recordType = args.last ?? ""
                let nameserver = args.first(where: { $0.hasPrefix("@") }) ?? ""
                if recordType == "PTR" {
                    if nameserver == "@100.100.100.100" {
                        return "steipetacstudio-gateway._mullusi-gw._tcp.mullusi.internal.\n"
                    }
                    return ""
                }
                if recordType == "SRV" {
                    return "0 0 18790 steipetacstudio.mullusi.internal."
                }
                if recordType == "TXT" {
                    return "\"displayName=Peter\\226\\128\\153s Mac Studio (Mullusi)\" \"gatewayPort=18790\" \"tailnetDns=peters-mac-studio-1.sheep-coho.ts.net\" \"cliPath=/Users/steipete/mullusi/src/entry.ts\""
                }
                return ""
            })

        let beacons = WideAreaGatewayDiscovery.discover(
            timeoutSeconds: 2.0,
            context: context)

        #expect(beacons.count == 1)
        let beacon = beacons[0]
        let expectedDisplay = "Peter\u{2019}s Mac Studio (Mullusi)"
        #expect(beacon.displayName == expectedDisplay)
        #expect(beacon.port == 18790)
        #expect(beacon.gatewayPort == 18790)
        #expect(beacon.tailnetDns == "peters-mac-studio-1.sheep-coho.ts.net")
        #expect(beacon.cliPath == "/Users/steipete/mullusi/src/entry.ts")
    }

    @Test func `attacker peer cannot become nameserver`() {
        let originalWideAreaDomain = getenv("MULLUSI_WIDE_AREA_DOMAIN").map { String(cString: $0) }
        setenv("MULLUSI_WIDE_AREA_DOMAIN", "mullusi.internal", 1)
        defer {
            if let originalWideAreaDomain {
                setenv("MULLUSI_WIDE_AREA_DOMAIN", originalWideAreaDomain, 1)
            } else {
                unsetenv("MULLUSI_WIDE_AREA_DOMAIN")
            }
        }
        let statusJson = """
        {
          "Self": { "TailscaleIPs": ["100.64.0.1"] },
          "Peer": {
            "attacker": { "TailscaleIPs": ["100.64.0.2"] }
          }
        }
        """

        let queriedNameservers = NameserverQueryLog()
        let context = WideAreaGatewayDiscovery.DiscoveryContext(
            tailscaleStatus: { statusJson },
            dig: { args, _ in
                let nameserver = args.first(where: { $0.hasPrefix("@") }) ?? ""
                queriedNameservers.record(nameserver)

                let recordType = args.last ?? ""
                if recordType == "PTR" {
                    if nameserver == "@100.64.0.2" {
                        return "evil._mullusi-gw._tcp.mullusi.internal.\n"
                    }
                    return ""
                }
                if recordType == "SRV" {
                    return "0 0 443 evil.ts.net."
                }
                if recordType == "TXT" {
                    return "\"displayName=Evil\""
                }
                return ""
            })

        let beacons = WideAreaGatewayDiscovery.discover(
            timeoutSeconds: 2.0,
            context: context)

        #expect(queriedNameservers.count(matching: "@100.64.0.2") == 0)
        #expect(queriedNameservers.count(matching: "@100.100.100.100") == 1)
        #expect(beacons.isEmpty)
    }
}
