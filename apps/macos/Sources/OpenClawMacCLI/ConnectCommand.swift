import Foundation
import OpenClawDiscovery
import OpenClawKit
import OpenClawProtocol

struct ConnectOptions {
    var url: String?
    var token: String?
    var password: String?
    var mode: String?
    var timeoutMs: Int = 15000
    var json: Bool = false
    var probe: Bool = false
    var clientId: String = "openclaw-macos"
    var clientMode: String = "ui"
    var displayName: String?
    var role: String = "operator"
    var scopes: [String] = defaultOperatorConnectScopes
    var scopesAreExplicit: Bool = false
    var help: Bool = false

    static func parse(_ args: [String]) throws -> ConnectOptions {
        var opts = ConnectOptions()
        var passwordInput = CLISecretInputParser(name: "password")
        var i = 0
        while i < args.count {
            let arg = args[i]
            switch arg {
            case "-h", "--help":
                opts.help = true
            case "--json":
                opts.json = true
            case "--probe":
                opts.probe = true
            case "--url":
                opts.url = CLIArgParsingSupport.nextValue(args, index: &i)
            case "--token":
                opts.token = CLIArgParsingSupport.nextValue(args, index: &i)
            case "--password":
                try passwordInput.parseInline(args, index: &i, flag: arg)
            case "--password-stdin":
                try passwordInput.parseStdin()
            case "--password-file":
                try passwordInput.parseFile(args, index: &i, flag: arg)
            case "--password-env":
                try passwordInput.parseEnvironment(args, index: &i, flag: arg)
            case "--mode":
                opts.mode = CLIArgParsingSupport.nextValue(args, index: &i)
            case "--timeout":
                if let raw = CLIArgParsingSupport.nextValue(args, index: &i),
                   let parsed = Int(raw.trimmingCharacters(in: .whitespacesAndNewlines))
                {
                    opts.timeoutMs = max(250, parsed)
                }
            case "--client-id":
                opts.clientId = CLIArgParsingSupport.nextValue(args, index: &i) ?? opts.clientId
            case "--client-mode":
                opts.clientMode = CLIArgParsingSupport.nextValue(args, index: &i) ?? opts.clientMode
            case "--display-name":
                opts.displayName = CLIArgParsingSupport.nextValue(args, index: &i)
            case "--role":
                opts.role = CLIArgParsingSupport.nextValue(args, index: &i) ?? opts.role
            case "--scopes":
                if let raw = CLIArgParsingSupport.nextValue(args, index: &i) {
                    opts.scopes = raw.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                        .filter { !$0.isEmpty }
                    opts.scopesAreExplicit = true
                }
            default:
                break
            }
            i += 1
        }
        opts.password = try passwordInput.resolve()
        return opts
    }
}

struct ConnectOutput: Encodable {
    var status: String
    var url: String
    var mode: String
    var role: String
    var clientId: String
    var clientMode: String
    var scopes: [String]
    var snapshot: HelloOk?
    var health: ProtoAnyCodable?
    var error: String?
}

actor SnapshotStore {
    private var value: HelloOk?

    func set(_ snapshot: HelloOk) {
        self.value = snapshot
    }

    func get() -> HelloOk? {
        self.value
    }
}

func runConnect(_ args: [String]) async {
    let opts: ConnectOptions
    do {
        opts = try ConnectOptions.parse(args)
    } catch {
        fputs("connect: \(error)\n", stderr)
        exit(1)
    }
    if opts.help {
        print("""
        openclaw-mac connect

        Usage:
          openclaw-mac connect [--url <ws://host:port>] [--token <token>] [--password-stdin]
                               [--password-file <path>] [--password-env <name>] [--password <password>]
                               [--mode <local|remote>] [--timeout <ms>] [--probe] [--json]
                               [--client-id <id>] [--client-mode <mode>] [--display-name <name>]
                               [--role <role>] [--scopes <a,b,c>]

        Options:
          --url <url>             Gateway WebSocket URL (overrides config)
          --token <token>         Gateway token (if required)
          --password-stdin        Read gateway password from stdin
          --password-file <path>  Read gateway password from a file
          --password-env <name>   Read gateway password from an environment variable
          --password <pw>         Gateway password; warning: exposes the value in process listings and shell history
          --mode <mode>           Resolve from config: local|remote (default: config or local)
          --timeout <ms>          Request timeout (default: 15000)
          --probe                 Force a fresh health probe
          --json                  Emit JSON
          --client-id <id>        Override client id (default: openclaw-macos)
          --client-mode <m>       Override client mode (default: ui)
          --display-name <n>      Override display name
          --role <role>           Override role (default: operator)
          --scopes <a,b,c>        Override scopes list
          -h, --help              Show help
        """)
        return
    }

    let config = loadGatewayConfig()
    do {
        let endpoint = try resolveGatewayEndpoint(opts: opts, config: config)
        let displayName = opts.displayName ?? Host.current().localizedName ?? "OpenClaw macOS Debug CLI"
        let connectOptions = GatewayConnectOptions(
            role: opts.role,
            scopes: opts.scopes,
            scopesAreExplicit: opts.scopesAreExplicit,
            caps: [],
            commands: [],
            permissions: [:],
            clientId: opts.clientId,
            clientMode: opts.clientMode,
            clientDisplayName: displayName)

        let snapshotStore = SnapshotStore()
        let channel = GatewayChannelActor(
            url: endpoint.url,
            token: endpoint.token,
            password: endpoint.password,
            pushHandler: { push in
                if case let .snapshot(ok) = push {
                    await snapshotStore.set(ok)
                }
            },
            connectOptions: connectOptions)

        let params: [String: KitAnyCodable]? = opts.probe ? ["probe": KitAnyCodable(true)] : nil
        let data = try await channel.request(
            method: "health",
            params: params,
            timeoutMs: Double(opts.timeoutMs))
        let health = try? JSONDecoder().decode(ProtoAnyCodable.self, from: data)
        let snapshot = await snapshotStore.get()
        await channel.shutdown()

        let output = ConnectOutput(
            status: "ok",
            url: endpoint.url.absoluteString,
            mode: endpoint.mode,
            role: opts.role,
            clientId: opts.clientId,
            clientMode: opts.clientMode,
            scopes: opts.scopes,
            snapshot: snapshot,
            health: health,
            error: nil)
        printConnectOutput(output, json: opts.json)
    } catch {
        let endpoint = bestEffortEndpoint(opts: opts, config: config)
        let fallbackMode = (opts.mode ?? config.mode ?? "local").lowercased()
        let output = ConnectOutput(
            status: "error",
            url: endpoint?.url.absoluteString ?? "unknown",
            mode: endpoint?.mode ?? fallbackMode,
            role: opts.role,
            clientId: opts.clientId,
            clientMode: opts.clientMode,
            scopes: opts.scopes,
            snapshot: nil,
            health: nil,
            error: error.localizedDescription)
        printConnectOutput(output, json: opts.json)
        exit(1)
    }
}

private func printConnectOutput(_ output: ConnectOutput, json: Bool) {
    if json {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? encoder.encode(output),
           let text = String(data: data, encoding: .utf8)
        {
            print(text)
        } else {
            print("{\"error\":\"failed to encode JSON\"}")
        }
        return
    }

    print("OpenClaw macOS Gateway Connect")
    print("Status: \(output.status)")
    print("URL: \(output.url)")
    print("Mode: \(output.mode)")
    print("Client: \(output.clientId) (\(output.clientMode))")
    print("Role: \(output.role)")
    print("Scopes: \(output.scopes.joined(separator: ", "))")
    if let snapshot = output.snapshot {
        print("Protocol: \(snapshot._protocol)")
        if let version = snapshot.server["version"]?.value as? String {
            print("Server: \(version)")
        }
    }
    if let health = output.health,
       let ok = (health.value as? [String: ProtoAnyCodable])?["ok"]?.value as? Bool
    {
        print("Health: \(ok ? "ok" : "error")")
    } else if output.health != nil {
        print("Health: received")
    }
    if let error = output.error {
        print("Error: \(error)")
    }
}

private func resolveGatewayEndpoint(opts: ConnectOptions, config: GatewayConfig) throws -> GatewayEndpoint {
    let resolvedMode = (opts.mode ?? config.mode ?? "local").lowercased()
    if let raw = opts.url, !raw.isEmpty {
        return try gatewayEndpoint(fromRawURL: raw, opts: opts, mode: resolvedMode, config: config)
    }

    if resolvedMode == "remote" {
        guard let raw = config.remoteUrl?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty
        else {
            throw NSError(
                domain: "Gateway",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "gateway.remote.url is missing"])
        }
        return try gatewayEndpoint(fromRawURL: raw, opts: opts, mode: resolvedMode, config: config)
    }

    let port = config.port ?? 18789
    let host = resolveLocalHost(bind: config.bind)
    guard let url = URL(string: "ws://\(host):\(port)") else {
        throw NSError(
            domain: "Gateway",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "invalid url: ws://\(host):\(port)"])
    }
    return GatewayEndpoint(
        url: url,
        token: resolvedToken(opts: opts, mode: resolvedMode, config: config),
        password: resolvedPassword(opts: opts, mode: resolvedMode, config: config),
        mode: resolvedMode)
}

private func bestEffortEndpoint(opts: ConnectOptions, config: GatewayConfig) -> GatewayEndpoint? {
    try? resolveGatewayEndpoint(opts: opts, config: config)
}

private func gatewayEndpoint(
    fromRawURL raw: String,
    opts: ConnectOptions,
    mode: String,
    config: GatewayConfig) throws -> GatewayEndpoint
{
    guard let url = URL(string: raw) else {
        throw NSError(domain: "Gateway", code: 1, userInfo: [NSLocalizedDescriptionKey: "invalid url: \(raw)"])
    }
    return GatewayEndpoint(
        url: url,
        token: resolvedToken(opts: opts, mode: mode, config: config),
        password: resolvedPassword(opts: opts, mode: mode, config: config),
        mode: mode)
}

private func resolvedToken(opts: ConnectOptions, mode: String, config: GatewayConfig) -> String? {
    if let token = opts.token, !token.isEmpty { return token }
    if mode == "remote" {
        return config.remoteToken
    }
    return config.token
}

private func resolvedPassword(opts: ConnectOptions, mode: String, config: GatewayConfig) -> String? {
    if let password = opts.password, !password.isEmpty { return password }
    if mode == "remote" {
        return config.remotePassword
    }
    return config.password
}

private func resolveLocalHost(bind: String?) -> String {
    let normalized = (bind ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let tailnetIP = TailscaleNetwork.detectTailnetIPv4()
    switch normalized {
    case "tailnet":
        return tailnetIP ?? "127.0.0.1"
    default:
        return "127.0.0.1"
    }
}