import Foundation
import Testing
@testable import OpenClawMacCLI

struct RootCommandParserTests {
    @Test func `signed service launcher accepts only the managed Gateway shape`() {
        let home = URL(fileURLWithPath: "/fixture")
        let root = "/fixture/.openclaw"
        let bun = root + "/runtime/service/bun"
        let entry = root + "/runtime/build/lib/node_modules/openclaw/openclaw.mjs"
        let file = root + "/service-env/ai.openclaw.gateway.env"
        let wrapper = root + "/service-env/ai.openclaw.gateway-env-wrapper.sh"
        let command = ["/bin/sh", wrapper, file, bun, "--no-install", entry, "gateway", "--port", "18789"]
        let parsed = AppGatewayServiceCommand(arguments: command, homeDirectory: home)
        #expect(parsed?.executable.path == "/bin/sh")
        #expect(parsed?.arguments == Array(command.dropFirst()))
        #expect(AppGatewayServiceCommand(arguments: [bun, entry, "gateway"], homeDirectory: home)?
            .executable.path == bun)
        #expect(AppGatewayServiceCommand(arguments: [wrapper, file, bun, entry, "gateway"], homeDirectory: home)?
            .executable.path == wrapper)
        for name in ["dist/index.js", "dist/index.mjs", "dist/entry.js", "dist/entry.mjs"] {
            let installed = root + "/runtime/build/lib/node_modules/openclaw/" + name
            #expect(AppGatewayServiceCommand(
                arguments: ["/bin/sh", wrapper, file, bun, "--no-install", installed, "gateway"],
                homeDirectory: home) != nil)
        }
        for invalid in [
            ["/bin/sh", "/tmp/wrapper", file, bun, entry, "gateway"],
            ["/bin/sh", wrapper, file, "/usr/bin/node", entry, "gateway"],
            ["/bin/sh", wrapper, file, bun, entry, "exec"],
            ["/bin/sh", wrapper, file, bun, "/tmp/openclaw.mjs", "gateway"],
            ["/bin/sh", wrapper, file, bun, root + "/runtime/build/lib/node_modules/openclaw/dist/other.js", "gateway"],
        ] {
            #expect(AppGatewayServiceCommand(arguments: invalid, homeDirectory: home) == nil)
        }
    }

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
