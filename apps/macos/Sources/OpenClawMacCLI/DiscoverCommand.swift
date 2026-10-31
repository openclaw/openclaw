import Foundation
import OpenClawDiscovery

struct DiscoveryOptions {
    var timeoutMs: Int = 2000
    var json: Bool = false
    var includeLocal: Bool = false
    var help: Bool = false

    static func parse(_ args: [String]) -> DiscoveryOptions {
        var opts = DiscoveryOptions()
        var i = 0
        while i < args.count {
            let arg = args[i]
            switch arg {
            case "-h", "--help":
                opts.help = true
            case "--json":
                opts.json = true
            case "--include-local":
                opts.includeLocal = true
            case "--timeout":
                let next = (i + 1 < args.count) ? args[i + 1] : nil
                if let next, let parsed = Int(next.trimmingCharacters(in: .whitespacesAndNewlines)) {
                    opts.timeoutMs = max(100, parsed)
                    i += 1
                }
            default:
                break
            }
            i += 1
        }
        return opts
    }
}

struct DiscoveryOutput: Encodable {
    var status: String
    var timeoutMs: Int
    var includeLocal: Bool
    var count: Int
    var gateways: [GatewayDiscoveryModel.DiscoveredGateway]
}

func runDiscover(_ args: [String]) async {
    let opts = DiscoveryOptions.parse(args)
    if opts.help {
        print("""
        openclaw-mac discover

        Usage:
          openclaw-mac discover [--timeout <ms>] [--json] [--include-local]

        Options:
          --timeout <ms>     Discovery window in milliseconds (default: 2000)
          --json             Emit JSON
          --include-local    Include gateways considered local
          -h, --help         Show help
        """)
        return
    }

    let displayName = Host.current().localizedName ?? ProcessInfo.processInfo.hostName
    let model = await MainActor.run {
        GatewayDiscoveryModel(
            localDisplayName: displayName,
            filterLocalGateways: !opts.includeLocal)
    }

    await MainActor.run {
        model.start()
    }

    try? await Task.sleep(for: .milliseconds(max(100, opts.timeoutMs)))

    let gateways = await MainActor.run { model.gateways }
    let status = await MainActor.run { model.statusText }

    await MainActor.run {
        model.stop()
    }

    if opts.json {
        let payload = DiscoveryOutput(
            status: status,
            timeoutMs: opts.timeoutMs,
            includeLocal: opts.includeLocal,
            count: gateways.count,
            gateways: gateways)
        printCLIJSON(payload, fallback: "{\"error\":\"failed to encode JSON\"}")
        return
    }

    print("Gateway Discovery (macOS NWBrowser)")
    print("Status: \(status)")
    print("Found \(gateways.count) gateway(s)\(opts.includeLocal ? "" : " (local filtered)")")
    for gateway in gateways {
        let hosts = [gateway.tailnetDns, gateway.lanHost]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: ", ")
        print("- \(gateway.displayName)")
        print("  hosts: \(hosts.isEmpty ? "(none)" : hosts)")
        print("  ssh: \(gateway.sshPort)")
        if let port = gateway.gatewayPort {
            print("  gatewayPort: \(port)")
        }
        print("  gatewayTls: \(gateway.gatewayTls)")
        print("  gatewayDirectReachable: \(gateway.gatewayDirectReachable)")
        if let cliPath = gateway.cliPath {
            print("  cliPath: \(cliPath)")
        }
        print("  isLocal: \(gateway.isLocal)")
        print("  stableID: \(gateway.stableID)")
        print("  debugID: \(gateway.debugID)")
    }
}
