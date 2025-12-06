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
        } catch {
            fputs("clawdis-mac error: \(error)\n", stderr)
            exit(2)
        }
    }

    private static func parseCommandLine() throws -> Request {
        var args = Array(CommandLine.arguments.dropFirst())
        guard let command = args.first else { throw CLIError.help }
        args = Array(args.dropFirst())

        switch command {
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

        default:
            throw CLIError.help
        }
    }

    private static func send(request: Request) async throws -> Response {
        let conn = NSXPCConnection(machServiceName: serviceName)
        let interface = NSXPCInterface(with: ClawdisXPCProtocol.self)
        conn.remoteObjectInterface = interface
        conn.resume()
        defer { conn.invalidate() }

        let data = try JSONEncoder().encode(request)

        let service = AsyncXPCConnection.RemoteXPCService<ClawdisXPCProtocol>(connection: conn)
        let raw: Data = try await service.withValueErrorCompletion { proxy, completion in
            struct CompletionBox: @unchecked Sendable { let handler: (Data?, Error?) -> Void }
            let box = CompletionBox(handler: completion)
            proxy.handle(data, withReply: { data, error in box.handler(data, error) })
        }
        return try JSONDecoder().decode(Response.self, from: raw)
    }
}

enum CLIError: Error { case help }

extension [String] {
    mutating func popFirst() -> String? {
        guard let first else { return nil }
        self = Array(self.dropFirst())
        return first
    }
}
