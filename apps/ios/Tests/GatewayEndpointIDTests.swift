import OpenClawKit
import Network
import Testing
@testable import OpenClaw

@Suite struct GatewayEndpointIDTests {
    @Test func stableIDForServiceDecodesAndNormalizesName() {
        let endpoint = NWEndpoint.service(
            name: "OpenClaw\\032Gateway   \\032  Node\n",
            type: "_openclaw-gw._tcp",
            domain: "local.",
            interface: nil)

        #expect(GatewayEndpointID.stableID(endpoint) == "_openclaw-gw._tcp|local.|OpenClaw Gateway Node")
    }

    @Test func stableIDForNonServiceUsesEndpointDescription() {
        let endpoint = NWEndpoint.hostPort(host: NWEndpoint.Host("127.0.0.1"), port: 4242)
        #expect(GatewayEndpointID.stableID(endpoint) == String(describing: endpoint))
    }

    @Test(arguments: [
        ("Bobby\\226\\128\\153s Mac", "Bobby\u{00E2}\u{0080}\u{0099}s Mac"),
        ("Cafe\\204\\129", "Cafe\u{00CC}\u{0081}"),
        ("a\\999b", "a\u{03E7}b"),
        ("Caf\u{00E9}\\032Bar", "Caf\u{00E9} Bar"),
        ("a\\03b\\XYZ", "a\\03b\\XYZ"),
    ])
    func stableIDPreservesPersistedEscapeMapping(rawName: String, persistedName: String) {
        let endpoint = NWEndpoint.service(
            name: rawName,
            type: "_openclaw-gw._tcp",
            domain: "local.",
            interface: nil)

        #expect(Array(GatewayEndpointID.stableID(endpoint).utf8) ==
            Array("_openclaw-gw._tcp|local.|\(persistedName)".utf8))
    }

    @Test func prettyDescriptionDecodesBonjourEscapes() {
        let endpoint = NWEndpoint.service(
            name: "OpenClaw\\032Gateway",
            type: "_openclaw-gw._tcp",
            domain: "local.",
            interface: nil)

        let pretty = GatewayEndpointID.prettyDescription(endpoint)
        #expect(pretty == BonjourEscapes.decode(String(describing: endpoint)))
        #expect(!pretty.localizedCaseInsensitiveContains("\\032"))
    }
}
