import AsyncXPCConnection
import ClawdisIPC
import Foundation

private let serviceName = "com.steipete.clawdis.xpc"

@objc protocol ClawdisXPCProtocol {
    func handle(_ data: Data, withReply reply: @escaping @Sendable (Data?, Error?) -> Void)
}

@main
struct ClawdisCLI {
    static func main() async {
        do {
            let request = try parseCommandLine()
            let response = try await send(request: request)
            let payloadString: String? = if let payload = response.payload, let text = String(
                data: payload,
                encoding: .utf8)
            {
                text
            } else {
                nil
            }
            let output: [String: Any] = [
                "ok": response.ok,
                "message": response.message ?? "",
                "payload": payloadString ?? "",
            ]
            let json = try JSONSerialization.data(withJSONObject: output, options: [.prettyPrinted])
            FileHandle.standardOutput.write(json)
            FileHandle.standardOutput.write(Data([0x0A]))
            exit(response.ok ? 0 : 1)
        } catch CLIError.help {
            printHelp()
            exit(0)
        } catch CLIError.version {
            printVersion()
            exit(0)
        } catch {
            fputs("clawdis-mac error: \(error)\n", stderr)
            exit(2)
        }
    }

    // swiftlint:disable cyclomatic_complexity
    private static func parseCommandLine() throws -> Request {
        var args = Array(CommandLine.arguments.dropFirst())
        guard let command = args.first else { throw CLIError.help }
        args = Array(args.dropFirst())

        switch command {
        case "--help", "-h", "help":
            throw CLIError.help
        case "--version", "-V", "version":
            throw CLIError.version

        case "notify":
            var title: String?
            var body: String?
            var sound: String?
            while !args.isEmpty {
                let arg = args.removeFirst()
                switch arg {
                case "--title": title = args.popFirst()
                case "--body": body = args.popFirst()
                case "--sound": sound = args.popFirst()
                default: break
                }
            }
            guard let t = title, let b = body else { throw CLIError.help }
            return .notify(title: t, body: b, sound: sound)

        case "ensure-permissions":
            var caps: [Capability] = []
            var interactive = false
            while !args.isEmpty {
                let arg = args.removeFirst()
                switch arg {
                case "--cap":
                    if let val = args.popFirst(), let cap = Capability(rawValue: val) { caps.append(cap) }
                case "--interactive": interactive = true
                default: break
                }
            }
            if caps.isEmpty { caps = Capability.allCases }
            return .ensurePermissions(caps, interactive: interactive)

        case "screenshot":
            var displayID: UInt32?
            var windowID: UInt32?
            while !args.isEmpty {
                let arg = args.removeFirst()
                switch arg {
                case "--display-id": if let val = args.popFirst(), let num = UInt32(val) { displayID = num }
                case "--window-id": if let val = args.popFirst(), let num = UInt32(val) { windowID = num }
                default: break
                }
            }
            return .screenshot(displayID: displayID, windowID: windowID, format: "png")

        case "run":
            var cwd: String?
            var env: [String: String] = [:]
            var timeout: Double?
            var needsSR = false
            var cmd: [String] = []
            while !args.isEmpty {
                let arg = args.removeFirst()
                switch arg {
                case "--cwd": cwd = args.popFirst()

                case "--env":
                    if let pair = args.popFirst(), let eq = pair.firstIndex(of: "=") {
                        let k = String(pair[..<eq]); let v = String(pair[pair.index(after: eq)...]); env[k] = v
                    }

                case "--timeout": if let val = args.popFirst(), let dbl = Double(val) { timeout = dbl }

                case "--needs-screen-recording": needsSR = true

                default:
                    cmd.append(arg)
                }
            }
            return .runShell(
                command: cmd,
                cwd: cwd,
                env: env.isEmpty ? nil : env,
                timeoutSec: timeout,
                needsScreenRecording: needsSR)

        case "status":
            return .status

        case "agent":
            var message: String?
            var thinking: String?
            var session: String?

            while !args.isEmpty {
                let arg = args.removeFirst()
                switch arg {
                case "--message": message = args.popFirst()
                case "--thinking": thinking = args.popFirst()
                case "--session": session = args.popFirst()
                default:
                    // Support bare message as last argument
                    if message == nil {
                        message = arg
                    }
                }
            }

            guard let message else { throw CLIError.help }
            return .agent(message: message, thinking: thinking, session: session)

        default:
            throw CLIError.help
        }
    }

    // swiftlint:enable cyclomatic_complexity

    private static func printHelp() {
        let usage = """
        clawdis-mac — talk to the running Clawdis.app XPC service

        Usage:
          clawdis-mac notify --title <t> --body <b> [--sound <name>]
          clawdis-mac ensure-permissions
            [--cap <notifications|accessibility|screenRecording|microphone|speechRecognition>]
            [--interactive]
          clawdis-mac screenshot [--display-id <u32>] [--window-id <u32>]
          clawdis-mac run [--cwd <path>] [--env KEY=VAL] [--timeout <sec>] [--needs-screen-recording] <command ...>
          clawdis-mac status
          clawdis-mac agent --message <text> [--thinking <low|default|high>] [--session <key>]
          clawdis-mac --help

        Returns JSON to stdout:
          {"ok":<bool>,"message":"...","payload":"..."}
        """
        print(usage)
    }

    private static func printVersion() {
        let info = loadInfo()
        let version = info["CFBundleShortVersionString"] as? String ?? "unknown"
        let build = info["CFBundleVersion"] as? String ?? ""
        let git = info["ClawdisGitCommit"] as? String ?? "unknown"
        let ts = info["ClawdisBuildTimestamp"] as? String ?? "unknown"
        print("clawdis-mac \(version) (\(build)) git:\(git) built:\(ts)")
    }

    private static func loadInfo() -> [String: Any] {
        if let dict = Bundle.main.infoDictionary, !dict.isEmpty { return dict }
        guard let exe = CommandLine.arguments.first else { return [:] }
        let url = URL(fileURLWithPath: exe)
            .resolvingSymlinksInPath()
            .deletingLastPathComponent() // MacOS
            .deletingLastPathComponent() // Contents
            .appendingPathComponent("Info.plist")
        if let data = try? Data(contentsOf: url),
           let dict = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [String: Any]
        {
            return dict
        }
        return [:]
    }

    private static func send(request: Request) async throws -> Response {
        try await ensureAppRunning()

        var lastError: Error?
        for _ in 0..<10 {
            let conn = NSXPCConnection(machServiceName: serviceName)
            let interface = NSXPCInterface(with: ClawdisXPCProtocol.self)
            conn.remoteObjectInterface = interface
            conn.resume()

            let data = try JSONEncoder().encode(request)
            do {
                let service = AsyncXPCConnection.RemoteXPCService<ClawdisXPCProtocol>(connection: conn)
                let raw: Data = try await service.withValueErrorCompletion { proxy, completion in
                    struct CompletionBox: @unchecked Sendable { let handler: (Data?, Error?) -> Void }
                    let box = CompletionBox(handler: completion)
                    proxy.handle(data, withReply: { data, error in box.handler(data, error) })
                }
                conn.invalidate()
                return try JSONDecoder().decode(Response.self, from: raw)
            } catch {
                lastError = error
                conn.invalidate()
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
        }
        throw lastError ?? CLIError.help
    }

    private static func ensureAppRunning() async throws {
        let appURL = URL(fileURLWithPath: (CommandLine.arguments.first ?? ""))
            .resolvingSymlinksInPath()
            .deletingLastPathComponent() // MacOS
            .deletingLastPathComponent() // Contents
        let proc = Process()
        proc.launchPath = "/usr/bin/open"
        proc.arguments = ["-n", appURL.path]
        proc.standardOutput = Pipe()
        proc.standardError = Pipe()
        try proc.run()
        try? await Task.sleep(nanoseconds: 100_000_000)
    }
}

enum CLIError: Error { case help, version }

extension [String] {
    mutating func popFirst() -> String? {
        guard let first else { return nil }
        self = Array(self.dropFirst())
        return first
    }
}
