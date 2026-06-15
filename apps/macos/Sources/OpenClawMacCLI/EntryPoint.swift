import Foundation

@main
struct OpenClawMacCLI {
    static func main() async {
        let args = Array(CommandLine.arguments.dropFirst())
        switch rootCommandAction(for: args) {
        case .usage:
            printUsage()
        case let .connect(commandArgs):
            await runConnect(commandArgs)
        case let .configureRemote(commandArgs):
            runConfigureRemote(commandArgs)
        case let .discover(commandArgs):
            await runDiscover(commandArgs)
        case let .wizard(commandArgs):
            await runWizardCommand(commandArgs)
        case let .unknown(exitCode):
            fputs("openclaw-mac: unknown command\n", stderr)
            printUsage()
            exit(exitCode)
        }
    }
}

private func printUsage() {
    print("""
    openclaw-mac

    Usage:
      openclaw-mac connect [--url <ws://host:port>] [--token <token>] [--password <password>]
                           [--mode <local|remote>] [--timeout <ms>] [--probe] [--json]
                           [--client-id <id>] [--client-mode <mode>] [--display-name <name>]
                           [--role <role>] [--scopes <a,b,c>]
      openclaw-mac configure-remote --ssh-target <user@host[:port]> [--local-port <port>]
                          [--remote-port <port>] [--token <token>] [--password <password>]
                          [--identity <path>] [--project-root <path>] [--cli-path <path>] [--json]
      openclaw-mac discover [--timeout <ms>] [--json] [--include-local]
      openclaw-mac wizard [--url <ws://host:port>] [--token <token>] [--password <password>]
                          [--mode <local|remote>] [--workspace <path>] [--json]

    Examples:
      openclaw-mac connect
      openclaw-mac configure-remote --ssh-target user@gateway.local --remote-port 18789
      openclaw-mac connect --url ws://127.0.0.1:18789 --json
      openclaw-mac discover --timeout 3000 --json
      openclaw-mac wizard --mode local
    """)
}
