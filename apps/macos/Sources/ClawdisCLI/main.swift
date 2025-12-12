import ClawdisIPC
import Foundation
import Darwin

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
            self.printHelp()
            exit(0)
        } catch CLIError.version {
            self.printVersion()
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
            var priority: NotificationPriority?
            var delivery: NotificationDelivery?
            while !args.isEmpty {
                let arg = args.removeFirst()
                switch arg {
                case "--title": title = args.popFirst()
                case "--body": body = args.popFirst()
                case "--sound": sound = args.popFirst()
                case "--priority":
                    if let val = args.popFirst(), let p = NotificationPriority(rawValue: val) { priority = p }
                case "--delivery":
                    if let val = args.popFirst(), let d = NotificationDelivery(rawValue: val) { delivery = d }
                default: break
                }
            }
            guard let t = title, let b = body else { throw CLIError.help }
            return .notify(title: t, body: b, sound: sound, priority: priority, delivery: delivery)

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

        case "rpc-status":
            return .rpcStatus

        case "agent":
            var message: String?
            var thinking: String?
            var session: String?
            var deliver = false
            var to: String?

            while !args.isEmpty {
                let arg = args.removeFirst()
                switch arg {
                case "--message": message = args.popFirst()
                case "--thinking": thinking = args.popFirst()
                case "--session": session = args.popFirst()
                case "--deliver": deliver = true
                case "--to": to = args.popFirst()
                default:
                    // Support bare message as last argument
                    if message == nil {
                        message = arg
                    }
                }
            }

            guard let message else { throw CLIError.help }
            return .agent(message: message, thinking: thinking, session: session, deliver: deliver, to: to)

        case "canvas":
            guard let sub = args.first else { throw CLIError.help }
            args = Array(args.dropFirst())

            switch sub {
            case "show":
                var session = "main"
                var path: String?
                var x: Double?
                var y: Double?
                var width: Double?
                var height: Double?
                while !args.isEmpty {
                    let arg = args.removeFirst()
                    switch arg {
                    case "--session": session = args.popFirst() ?? session
                    case "--path": path = args.popFirst()
                    case "--x": x = args.popFirst().flatMap(Double.init)
                    case "--y": y = args.popFirst().flatMap(Double.init)
                    case "--width": width = args.popFirst().flatMap(Double.init)
                    case "--height": height = args.popFirst().flatMap(Double.init)
                    default: break
                    }
                }
                let placement = (x != nil || y != nil || width != nil || height != nil)
                    ? CanvasPlacement(x: x, y: y, width: width, height: height)
                    : nil
                return .canvasShow(session: session, path: path, placement: placement)

            case "hide":
                var session = "main"
                while !args.isEmpty {
                    let arg = args.removeFirst()
                    switch arg {
                    case "--session": session = args.popFirst() ?? session
                    default: break
                    }
                }
                return .canvasHide(session: session)

            case "goto":
                var session = "main"
                var path: String?
                var x: Double?
                var y: Double?
                var width: Double?
                var height: Double?
                while !args.isEmpty {
                    let arg = args.removeFirst()
                    switch arg {
                    case "--session": session = args.popFirst() ?? session
                    case "--path": path = args.popFirst()
                    case "--x": x = args.popFirst().flatMap(Double.init)
                    case "--y": y = args.popFirst().flatMap(Double.init)
                    case "--width": width = args.popFirst().flatMap(Double.init)
                    case "--height": height = args.popFirst().flatMap(Double.init)
                    default: break
                    }
                }
                guard let path else { throw CLIError.help }
                let placement = (x != nil || y != nil || width != nil || height != nil)
                    ? CanvasPlacement(x: x, y: y, width: width, height: height)
                    : nil
                return .canvasGoto(session: session, path: path, placement: placement)

            case "eval":
                var session = "main"
                var js: String?
                while !args.isEmpty {
                    let arg = args.removeFirst()
                    switch arg {
                    case "--session": session = args.popFirst() ?? session
                    case "--js": js = args.popFirst()
                    default: break
                    }
                }
                guard let js else { throw CLIError.help }
                return .canvasEval(session: session, javaScript: js)

            case "snapshot":
                var session = "main"
                var outPath: String?
                while !args.isEmpty {
                    let arg = args.removeFirst()
                    switch arg {
                    case "--session": session = args.popFirst() ?? session
                    case "--out": outPath = args.popFirst()
                    default: break
                    }
                }
                return .canvasSnapshot(session: session, outPath: outPath)

            default:
                throw CLIError.help
            }

        default:
            throw CLIError.help
        }
    }

    // swiftlint:enable cyclomatic_complexity

    private static func printHelp() {
        let usage = """
        clawdis-mac — talk to the running Clawdis.app XPC service

        Usage:
          clawdis-mac notify --title <t> --body <b> [--sound <name>] [--priority <passive|active|timeSensitive>] [--delivery <system|overlay|auto>]
          clawdis-mac ensure-permissions
            [--cap <notifications|accessibility|screenRecording|microphone|speechRecognition>]
            [--interactive]
          clawdis-mac screenshot [--display-id <u32>] [--window-id <u32>]
          clawdis-mac run [--cwd <path>] [--env KEY=VAL] [--timeout <sec>] [--needs-screen-recording] <command ...>
          clawdis-mac status
          clawdis-mac rpc-status
          clawdis-mac agent --message <text> [--thinking <low|default|high>]
            [--session <key>] [--deliver] [--to <E.164>]
          clawdis-mac canvas show [--session <key>] [--path </...>]
            [--x <screenX> --y <screenY>] [--width <w> --height <h>]
          clawdis-mac canvas hide [--session <key>]
          clawdis-mac canvas goto --path </...> [--session <key>]
            [--x <screenX> --y <screenY>] [--width <w> --height <h>]
          clawdis-mac canvas eval --js <code> [--session <key>]
          clawdis-mac canvas snapshot [--out <path>] [--session <key>]
          clawdis-mac --help

        Returns JSON to stdout:
          {"ok":<bool>,"message":"...","payload":"..."}
        """
        print(usage)
    }

    private static func printVersion() {
        let info = self.loadInfo()
        let version = (info["CFBundleShortVersionString"] as? String) ?? self.loadPackageJSONVersion() ?? "unknown"
        var build = info["CFBundleVersion"] as? String ?? ""
        if build.isEmpty, version != "unknown" {
            build = version
        }
        let git = info["ClawdisGitCommit"] as? String ?? "unknown"
        let ts = info["ClawdisBuildTimestamp"] as? String ?? "unknown"

        let buildPart = build.isEmpty ? "" : " (\(build))"
        print("clawdis-mac \(version)\(buildPart) git:\(git) built:\(ts)")
    }

    private static func loadInfo() -> [String: Any] {
        if let dict = Bundle.main.infoDictionary, !dict.isEmpty { return dict }

        guard let exeURL = self.resolveExecutableURL() else { return [:] }

        var dir = exeURL.deletingLastPathComponent()
        for _ in 0..<10 {
            let candidate = dir.appendingPathComponent("Info.plist")
            if let dict = self.loadPlistDictionary(at: candidate) {
                return dict
            }
            let parent = dir.deletingLastPathComponent()
            if parent.path == dir.path { break }
            dir = parent
        }

        return [:]
    }

    private static func loadPlistDictionary(at url: URL) -> [String: Any]? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? PropertyListSerialization
            .propertyList(from: data, options: [], format: nil) as? [String: Any]
    }

    private static func resolveExecutableURL() -> URL? {
        var size: UInt32 = UInt32(PATH_MAX)
        var buffer = [CChar](repeating: 0, count: Int(size))

        let result = buffer.withUnsafeMutableBufferPointer { ptr in
            _NSGetExecutablePath(ptr.baseAddress, &size)
        }

        if result != 0 {
            buffer = [CChar](repeating: 0, count: Int(size))
            let result2 = buffer.withUnsafeMutableBufferPointer { ptr in
                _NSGetExecutablePath(ptr.baseAddress, &size)
            }
            guard result2 == 0 else { return nil }
        }

        let nulIndex = buffer.firstIndex(of: 0) ?? buffer.count
        let bytes = buffer.prefix(nulIndex).map { UInt8(bitPattern: $0) }
        let path = String(decoding: bytes, as: UTF8.self)
        return URL(fileURLWithPath: path).resolvingSymlinksInPath()
    }

    private static func loadPackageJSONVersion() -> String? {
        guard let exeURL = self.resolveExecutableURL() else { return nil }

        var dir = exeURL.deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent("package.json")
            if let version = self.loadPackageJSONVersion(at: candidate) {
                return version
            }
            let parent = dir.deletingLastPathComponent()
            if parent.path == dir.path { break }
            dir = parent
        }

        return nil
    }

    private static func loadPackageJSONVersion(at url: URL) -> String? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        guard obj["name"] as? String == "clawdis" else { return nil }
        return obj["version"] as? String
    }

    private static func send(request: Request) async throws -> Response {
        try await self.ensureAppRunning()

        return try await self.sendViaSocket(request: request)
    }

    /// Attempt a direct UNIX socket call; falls back to XPC if unavailable.
    private static func sendViaSocket(request: Request) async throws -> Response {
        let path = controlSocketPath
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw POSIXError(.ECONNREFUSED) }
        defer { close(fd) }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)
        let copied = path.withCString { cstr -> Int in
            strlcpy(&addr.sun_path.0, cstr, capacity)
        }
        guard copied < capacity else { throw POSIXError(.ENAMETOOLONG) }
        addr.sun_len = UInt8(MemoryLayout.size(ofValue: addr))
        let len = socklen_t(MemoryLayout.size(ofValue: addr))
        let result = withUnsafePointer(to: &addr) { ptr -> Int32 in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                connect(fd, sockPtr, len)
            }
        }
        guard result == 0 else { throw POSIXError(.ECONNREFUSED) }

        let payload = try JSONEncoder().encode(request)
        _ = payload.withUnsafeBytes { buf in
            write(fd, buf.baseAddress!, payload.count)
        }
        shutdown(fd, SHUT_WR)

        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 8192)
        let bufSize = buffer.count
        while true {
            let n = buffer.withUnsafeMutableBytes { read(fd, $0.baseAddress!, bufSize) }
            if n > 0 {
                data.append(buffer, count: n)
            } else {
                break
            }
        }
        guard !data.isEmpty else { throw POSIXError(.ECONNRESET) }
        return try JSONDecoder().decode(Response.self, from: data)
    }

    private static func ensureAppRunning() async throws {
        let appURL = URL(fileURLWithPath: CommandLine.arguments.first ?? "")
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
