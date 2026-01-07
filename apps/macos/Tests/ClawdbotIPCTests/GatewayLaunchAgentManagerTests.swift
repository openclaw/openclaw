import Testing
@testable import Clawdbot

@Suite struct GatewayLaunchAgentManagerTests {
    @Test func parseLaunchctlPrintSnapshotParsesQuotedArgs() {
        let output = """
        service = com.clawdbot.gateway
        program arguments = (
            "/Applications/Clawdbot.app/Contents/Resources/Relay/clawdbot",
            "gateway-daemon",
            "--port",
            "18789",
            "--bind",
            "loopback"
        )
        pid = 123
        """
        let snapshot = GatewayLaunchAgentManager.parseLaunchctlPrintSnapshot(output)
        #expect(snapshot.pid == 123)
        #expect(snapshot.port == 18789)
        #expect(snapshot.bind == "loopback")
        #expect(snapshot.matches(port: 18789, bind: "loopback"))
        #expect(snapshot.matches(port: 18789, bind: "tailnet") == false)
        #expect(snapshot.matches(port: 19999, bind: "loopback") == false)
    }

    @Test func parseLaunchctlPrintSnapshotParsesUnquotedArgs() {
        let output = """
        argv[] = { /usr/local/bin/clawdbot, gateway-daemon, --port, 19999, --bind, tailnet }
        pid = 0
        """
        let snapshot = GatewayLaunchAgentManager.parseLaunchctlPrintSnapshot(output)
        #expect(snapshot.pid == 0)
        #expect(snapshot.port == 19999)
        #expect(snapshot.bind == "tailnet")
    }

    @Test func parseLaunchctlPrintSnapshotAllowsMissingBind() {
        let output = """
        program arguments = ( "clawdbot", "gateway-daemon", "--port", "18789" )
        pid = 456
        """
        let snapshot = GatewayLaunchAgentManager.parseLaunchctlPrintSnapshot(output)
        #expect(snapshot.port == 18789)
        #expect(snapshot.bind == nil)
        #expect(snapshot.matches(port: 18789, bind: "loopback"))
    }
}

