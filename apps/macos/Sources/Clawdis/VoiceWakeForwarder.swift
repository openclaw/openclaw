import Foundation
import OSLog

struct VoiceWakeForwardConfig: Sendable {
    let enabled: Bool
    let target: String
    let identityPath: String
    let commandTemplate: String
    let timeout: TimeInterval
}

enum VoiceWakeForwarder {
    private static let logger = Logger(subsystem: "com.steipete.clawdis", category: "voicewake.forward")

    static func forward(transcript: String, config: VoiceWakeForwardConfig) async {
        guard config.enabled else { return }
        let destination = config.target.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parsed = self.parse(target: destination) else {
            self.logger.error("voice wake forward skipped: host missing")
            return
        }

        let userHost = parsed.user.map { "\($0)@\(parsed.host)" } ?? parsed.host

        var args: [String] = [
            "-o", "BatchMode=yes",
            "-o", "IdentitiesOnly=yes",
        ]
        if parsed.port > 0 { args.append(contentsOf: ["-p", String(parsed.port)]) }
        if !config.identityPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            args.append(contentsOf: ["-i", config.identityPath])
        }
        args.append(userHost)

        let rendered = self.renderedCommand(template: config.commandTemplate, transcript: transcript)
        args.append(contentsOf: ["sh", "-c", rendered])

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
        process.arguments = args

        let input = Pipe()
        process.standardInput = input
        let output = Pipe()
        process.standardOutput = output
        process.standardError = output

        do {
            try process.run()
        } catch {
            self.logger.error("voice wake forward failed to start ssh: \(error.localizedDescription, privacy: .public)")
            return
        }

        if let data = transcript.data(using: .utf8) {
            input.fileHandleForWriting.write(data)
        }
        try? input.fileHandleForWriting.close()

        await self.wait(process, timeout: config.timeout)
    }

    static func renderedCommand(template: String, transcript: String) -> String {
        let escaped = Self.shellEscape(transcript)
        if template.contains("${text}") {
            return template.replacingOccurrences(of: "${text}", with: escaped)
        }
        return template
    }

    static func shellEscape(_ text: String) -> String {
        // Single-quote based shell escaping.
        let replaced = text.replacingOccurrences(of: "'", with: "'\\''")
        return "'\(replaced)'"
    }

    private static func wait(_ process: Process, timeout: TimeInterval) async {
        await withTaskGroup(of: Void.self) { group in
            group.addTask {
                process.waitUntilExit()
            }
            group.addTask {
                let nanos = UInt64(max(timeout, 0.1) * 1_000_000_000)
                try? await Task.sleep(nanoseconds: nanos)
                if process.isRunning {
                    process.terminate()
                }
            }
            _ = await group.next()
            group.cancelAll()
        }

        if process.terminationStatus != 0 {
            self.logger.debug("voice wake forward ssh exit=\(process.terminationStatus)")
        }
    }

    static func parse(target: String) -> (user: String?, host: String, port: Int)? {
        guard !target.isEmpty else { return nil }
        var remainder = target
        var user: String?
        if let at = remainder.firstIndex(of: "@") {
            user = String(remainder[..<at])
            remainder = String(remainder[remainder.index(after: at)...])
        }

        var host = remainder
        var port = defaultVoiceWakeForwardPort
        if let colon = remainder.lastIndex(of: ":"), colon != remainder.startIndex {
            let p = String(remainder[remainder.index(after: colon)...])
            if let parsedPort = Int(p) {
                port = parsedPort
                host = String(remainder[..<colon])
            }
        }

        host = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !host.isEmpty else { return nil }
        return (user: user?.trimmingCharacters(in: .whitespacesAndNewlines), host: host, port: port)
    }
}
