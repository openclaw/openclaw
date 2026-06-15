import Testing
@testable import OpenClawMacCLI

struct RootCommandParserTests {
    @Test func `empty args parse no command and show usage`() {
        #expect(parseRootCommand([]) == nil)
        #expect(rootCommandAction(for: []) == .usage)
    }

    @Test func `single command parses with empty trailing args`() throws {
        let command = try #require(parseRootCommand(["connect"]))
        #expect(command.name == "connect")
        #expect(command.args == [])
    }

    @Test func `root parser splits command from trailing arguments`() throws {
        let command = try #require(parseRootCommand(["connect", "--url", "ws://127.0.0.1:18789", "--json"]))
        #expect(command.name == "connect")
        #expect(command.args == ["--url", "ws://127.0.0.1:18789", "--json"])
    }

    @Test func `help aliases show usage`() {
        for alias in ["-h", "--help", "help"] {
            #expect(rootCommandAction(for: [alias]) == .usage)
        }
    }

    @Test func `known commands dispatch with trailing arguments`() {
        #expect(rootCommandAction(for: ["connect", "--json"]) == .connect(["--json"]))
        #expect(rootCommandAction(for: ["configure-remote", "--ssh-target", "alice@gateway.local"]) ==
            .configureRemote([
                "--ssh-target",
                "alice@gateway.local",
            ]))
        #expect(rootCommandAction(for: ["discover", "--include-local"]) == .discover(["--include-local"]))
        #expect(rootCommandAction(for: ["wizard", "--mode", "local"]) == .wizard(["--mode", "local"]))
    }

    @Test func `unknown command dispatches to nonzero exit action`() {
        #expect(rootCommandAction(for: ["Connect"]) == .unknown(exitCode: 1))
        #expect(rootCommandAction(for: ["bogus", "--json"]) == .unknown(exitCode: 1))
    }
}
