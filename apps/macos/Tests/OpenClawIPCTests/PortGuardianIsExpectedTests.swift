import XCTest
@testable import OpenClaw

final class PortGuardianIsExpectedTests: XCTestCase {

    // MARK: - Legacy and current service process titles

    func testGatewayDaemonIsExpected() {
        XCTAssertTrue(PortGuardian._testIsExpected(
            command: "openclaw-gateway",
            fullCommand: "openclaw-gateway",
            port: 18789,
            mode: .local))
    }

    func testOpenClawGatewayInFullCommand() {
        XCTAssertTrue(PortGuardian._testIsExpected(
            command: "node",
            fullCommand: "/usr/bin/openclaw-gateway --port 18789",
            port: 18789,
            mode: .local))
    }

    func testGatewayDaemonInFullCommand() {
        XCTAssertTrue(PortGuardian._testIsExpected(
            command: "node",
            fullCommand: "something-gateway-daemon-wrapper",
            port: 18789,
            mode: .local))
    }

    // MARK: - CLI listener with no args

    func testCLIListenerNoArgs() {
        XCTAssertTrue(PortGuardian._testIsExpected(
            command: "openclaw",
            fullCommand: "openclaw",
            port: 18789,
            mode: .local))
    }

    // MARK: - Launchd-managed Node.js gateway (the fix for #94476)

    func testNodeDistIndexJsGatewayIsExpected() {
        // Homebrew Node + git checkout gateway
        XCTAssertTrue(PortGuardian._testIsExpected(
            command: "node",
            fullCommand: "/opt/homebrew/opt/node/bin/node /Users/testuser/openclaw/dist/index.js gateway --port 18789",
            port: 18789,
            mode: .local))
    }

    func testNodeDistIndexJsGatewayIntelHomebrew() {
        // Intel Homebrew path
        XCTAssertTrue(PortGuardian._testIsExpected(
            command: "node",
            fullCommand: "/usr/local/bin/node /Users/testuser/openclaw/dist/index.js gateway --port 18789",
            port: 18789,
            mode: .local))
    }

    func testNodeDistIndexJsGatewayNpmInstall() {
        // npm global install
        XCTAssertTrue(PortGuardian._testIsExpected(
            command: "node",
            fullCommand: "/usr/local/bin/node /usr/local/lib/node_modules/openclaw/dist/index.js gateway --port 18789",
            port: 18789,
            mode: .local))
    }

    // MARK: - Unrelated Node processes should NOT match

    func testRandomNodeProcessIsNotExpected() {
        XCTAssertFalse(PortGuardian._testIsExpected(
            command: "node",
            fullCommand: "/usr/local/bin/node /some/other/app/server.js",
            port: 18789,
            mode: .local))
    }

    func testNodeWithoutOpenClawIsNotExpected() {
        XCTAssertFalse(PortGuardian._testIsExpected(
            command: "node",
            fullCommand: "/opt/homebrew/opt/node/bin/node /Users/testuser/myproject/dist/index.js gateway --port 18789",
            port: 18789,
            mode: .local))
    }

    // MARK: - Remote and unconfigured modes

    func testRemoteModeGatewayPort() {
        // Remote mode with matching gateway port should return true
        let gatewayPort = GatewayEnvironment.gatewayPort()
        XCTAssertTrue(PortGuardian._testIsExpected(
            command: "node",
            fullCommand: "anything",
            port: gatewayPort,
            mode: .remote))
    }

    func testUnconfiguredModeAlwaysFalse() {
        XCTAssertFalse(PortGuardian._testIsExpected(
            command: "openclaw-gateway",
            fullCommand: "openclaw-gateway",
            port: 18789,
            mode: .unconfigured))
    }
}
