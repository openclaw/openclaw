import Testing
@testable import OpenClawMacCLI

struct RootCommandParserTests {
    @Test func parseRootCommandReturnsNilForEmptyArgs() {
        #expect(parseRootCommand([]) == nil)
    }

    @Test func parseRootCommandSplitsNameAndArguments() throws {
        let command = try #require(parseRootCommand(["connect", "--url", "ws://127.0.0.1:18789", "--json"]))

        #expect(command.name == "connect")
        #expect(command.args == ["--url", "ws://127.0.0.1:18789", "--json"])
    }

    @Test func resolveRootCommandActionMapsHelpAliasesToUsage() {
        #expect(resolveRootCommandAction([]) == .usage)
        #expect(resolveRootCommandAction(["-h"]) == .usage)
        #expect(resolveRootCommandAction(["--help"]) == .usage)
        #expect(resolveRootCommandAction(["help"]) == .usage)
    }

    @Test func resolveRootCommandActionMapsKnownCommandsWithArguments() {
        #expect(resolveRootCommandAction(["connect", "--json"]) == .connect(["--json"]))
        #expect(
            resolveRootCommandAction(["configure-remote", "--ssh-target", "user@example.com"])
                == .configureRemote(["--ssh-target", "user@example.com"])
        )
        #expect(resolveRootCommandAction(["discover", "--include-local"]) == .discover(["--include-local"]))
        #expect(resolveRootCommandAction(["wizard", "--mode", "local"]) == .wizard(["--mode", "local"]))
    }

    @Test func resolveRootCommandActionKeepsUnknownCommandsCaseSensitive() {
        #expect(resolveRootCommandAction(["Connect"]) == .unknown("Connect"))
        #expect(resolveRootCommandAction(["unknown", "--flag"]) == .unknown("unknown"))
    }
}
