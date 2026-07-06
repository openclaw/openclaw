import Foundation
import Testing
@testable import OpenClaw

struct PortGuardianIsExpectedTests {
    @Test func `local mode preserves launchd node dist gateway command`() {
        let fullCommand = """
        /opt/homebrew/bin/node /opt/homebrew/lib/node_modules/openclaw/dist/index.js gateway --port 18789 --bind loopback
        """

        #expect(PortGuardian._testIsExpected(
            command: "node",
            fullCommand: fullCommand,
            port: 18789,
            mode: .local))
    }

    @Test func `local mode preserves git checkout node dist gateway command`() {
        let fullCommand = """
        /usr/local/bin/node /Users/dev/Projects/openclaw/dist/index.js gateway --port 18789
        """

        #expect(PortGuardian._testIsExpected(
            command: "node",
            fullCommand: fullCommand,
            port: 18789,
            mode: .local))
    }

    @Test func `local mode rejects similarly named node project`() {
        #expect(!PortGuardian._testIsExpected(
            command: "node",
            fullCommand: "/usr/local/bin/node /tmp/openclaw-tools/dist/index.js gateway --port 18789",
            port: 18789,
            mode: .local))
    }

    @Test func `local mode rejects gateway appearing after another node argument`() {
        #expect(!PortGuardian._testIsExpected(
            command: "node",
            fullCommand: "/usr/local/bin/node --inspect /tmp/openclaw/dist/index.js gateway --port 18789",
            port: 18789,
            mode: .local))
    }

    @Test func `local mode rejects node dist entrypoint without gateway subcommand`() {
        #expect(!PortGuardian._testIsExpected(
            command: "node",
            fullCommand: "/opt/homebrew/bin/node /opt/homebrew/lib/node_modules/openclaw/dist/index.js doctor",
            port: 18789,
            mode: .local))
    }
}
