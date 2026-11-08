import Testing
@testable import OpenClawMacCLI

struct RootCommandParserTests {
    @Test func `empty args resolve to app control`() {
        #expect(resolveRootCommandAction([]) == .control([]))
    }

    @Test func `help aliases resolve to usage`() {
        for args in [["-h"], ["--help"], ["help"]] {
            #expect(resolveRootCommandAction(args) == .usage)
        }
    }

    @Test func `known commands preserve trailing args`() {
        #expect(resolveRootCommandAction(["connect", "--json", "--timeout", "3000"])
            == .connect(["--json", "--timeout", "3000"]))
        #expect(
            resolveRootCommandAction(["configure-remote", "--ssh-target", "alice@example.com"])
                == .configureRemote(["--ssh-target", "alice@example.com"]))
        #expect(resolveRootCommandAction(["discover", "--include-local"]) == .discover(["--include-local"]))
        #expect(resolveRootCommandAction(["wizard", "--mode", "local"]) == .wizard(["--mode", "local"]))
    }

    @Test func `unknown command resolves to nonzero exit action`() {
        #expect(resolveRootCommandAction(["nope"]) == .unknown(exitCode: 1))
    }

    @Test func `command names remain case sensitive`() {
        #expect(resolveRootCommandAction(["Connect"]) == .unknown(exitCode: 1))
    }
}
