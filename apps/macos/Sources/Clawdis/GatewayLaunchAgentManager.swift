import Foundation

enum GatewayLaunchAgentManager {
    private static let logger = Logger(subsystem: "com.steipete.clawdis", category: "gateway.launchd")
    private static let supportedBindModes: Set<String> = ["loopback", "tailnet", "lan", "auto"]

    private static var plistURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(gatewayLaunchdLabel).plist")
    }

    private static func gatewayExecutablePath(bundlePath: String) -> String {
        "\(bundlePath)/Contents/Resources/Relay/clawdis"
    }

    private static func relayDir(bundlePath: String) -> String {
        "\(bundlePath)/Contents/Resources/Relay"
    }

    static func status() async -> Bool {
        guard FileManager.default.fileExists(atPath: self.plistURL.path) else { return false }
        let result = await self.runLaunchctl(["print", "gui/\(getuid())/\(gatewayLaunchdLabel)"])
        return result.status == 0
    }

    static func set(enabled: Bool, bundlePath: String, port: Int) async -> String? {
        if enabled {
            let gatewayBin = self.gatewayExecutablePath(bundlePath: bundlePath)
            guard FileManager.default.isExecutableFile(atPath: gatewayBin) else {
                self.logger.error("launchd enable failed: gateway missing at \(gatewayBin)")
                return "Embedded gateway missing in bundle; rebuild via scripts/package-mac-app.sh"
            }
            self.logger.info("launchd enable requested port=\(port)")
            self.writePlist(bundlePath: bundlePath, port: port)
            _ = await self.runLaunchctl(["bootout", "gui/\(getuid())/\(gatewayLaunchdLabel)"])
            let bootstrap = await self.runLaunchctl(["bootstrap", "gui/\(getuid())", self.plistURL.path])
            if bootstrap.status != 0 {
                let msg = bootstrap.output.trimmingCharacters(in: .whitespacesAndNewlines)
                self.logger.error("launchd bootstrap failed: \(msg)")
                return bootstrap.output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ? "Failed to bootstrap gateway launchd job"
                    : bootstrap.output.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            // Note: removed redundant `kickstart -k` that caused race condition.
            // bootstrap already starts the job; kickstart -k would kill it immediately
            // and with KeepAlive=true, cause a restart loop with port conflicts.
            return nil
        }

        self.logger.info("launchd disable requested")
        _ = await self.runLaunchctl(["bootout", "gui/\(getuid())/\(gatewayLaunchdLabel)"])
        try? FileManager.default.removeItem(at: self.plistURL)
        return nil
    }

    static func kickstart() async {
        _ = await self.runLaunchctl(["kickstart", "-k", "gui/\(getuid())/\(gatewayLaunchdLabel)"])
    }

    private static func writePlist(bundlePath: String, port: Int) {
        let gatewayBin = self.gatewayExecutablePath(bundlePath: bundlePath)
        let relayDir = self.relayDir(bundlePath: bundlePath)
        let preferredPath = ([relayDir] + CommandResolver.preferredPaths())
            .joined(separator: ":")
        let bind = self.preferredGatewayBind() ?? "loopback"
        let token = self.preferredGatewayToken()
        let password = self.preferredGatewayPassword()
        var envEntries = """
            <key>PATH</key>
            <string>\(preferredPath)</string>
            <key>CLAWDIS_IMAGE_BACKEND</key>
            <string>sips</string>
        """
        if let token {
            envEntries += """
                <key>CLAWDIS_GATEWAY_TOKEN</key>
                <string>\(token)</string>
            """
        }
        if let password {
            envEntries += """
                <key>CLAWDIS_GATEWAY_PASSWORD</key>
                <string>\(password)</string>
            """
        }
        let plist = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
          <key>Label</key>
          <string>\(gatewayLaunchdLabel)</string>
          <key>ProgramArguments</key>
          <array>
            <string>\(gatewayBin)</string>
            <string>gateway-daemon</string>
            <string>--port</string>
            <string>\(port)</string>
            <string>--bind</string>
            <string>\(bind)</string>
          </array>
          <key>WorkingDirectory</key>
          <string>\(FileManager.default.homeDirectoryForCurrentUser.path)</string>
          <key>RunAtLoad</key>
          <true/>
          <key>KeepAlive</key>
          <true/>
          <key>EnvironmentVariables</key>
          <dict>
        \(envEntries)
          </dict>
          <key>StandardOutPath</key>
          <string>\(LogLocator.launchdGatewayLogPath)</string>
          <key>StandardErrorPath</key>
          <string>\(LogLocator.launchdGatewayLogPath)</string>
        </dict>
        </plist>
        """
        do {
            try plist.write(to: self.plistURL, atomically: true, encoding: .utf8)
        } catch {
            self.logger.error("launchd plist write failed: \(error.localizedDescription)")
        }
    }

    private static func preferredGatewayBind() -> String? {
        if CommandResolver.connectionModeIsRemote() {
            return nil
        }
        if let env = ProcessInfo.processInfo.environment["CLAWDIS_GATEWAY_BIND"] {
            let trimmed = env.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if self.supportedBindModes.contains(trimmed) {
                return trimmed
            }
        }

        let root = ClawdisConfigFile.loadDict()
        if let gateway = root["gateway"] as? [String: Any],
           let bind = gateway["bind"] as? String
        {
            let trimmed = bind.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if self.supportedBindModes.contains(trimmed) {
                return trimmed
            }
        }

        return nil
    }

    private static func preferredGatewayToken() -> String? {
        let raw = ProcessInfo.processInfo.environment["CLAWDIS_GATEWAY_TOKEN"] ?? ""
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func preferredGatewayPassword() -> String? {
        // First check environment variable
        let raw = ProcessInfo.processInfo.environment["CLAWDIS_GATEWAY_PASSWORD"] ?? ""
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            return trimmed
        }
        // Then check config file (gateway.auth.password)
        let root = ClawdisConfigFile.loadDict()
        if let gateway = root["gateway"] as? [String: Any],
           let auth = gateway["auth"] as? [String: Any],
           let password = auth["password"] as? String
        {
            return password.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return nil
    }

    private struct LaunchctlResult {
        let status: Int32
        let output: String
    }

    @discardableResult
    private static func runLaunchctl(_ args: [String]) async -> LaunchctlResult {
        await Task.detached(priority: .utility) { () -> LaunchctlResult in
            let process = Process()
            process.launchPath = "/bin/launchctl"
            process.arguments = args
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe
            do {
                try process.run()
                process.waitUntilExit()
                let data = pipe.fileHandleForReading.readToEndSafely()
                let output = String(data: data, encoding: .utf8) ?? ""
                return LaunchctlResult(status: process.terminationStatus, output: output)
            } catch {
                return LaunchctlResult(status: -1, output: error.localizedDescription)
            }
        }.value
    }
}

#if DEBUG
extension GatewayLaunchAgentManager {
    static func _testGatewayExecutablePath(bundlePath: String) -> String {
        self.gatewayExecutablePath(bundlePath: bundlePath)
    }

    static func _testRelayDir(bundlePath: String) -> String {
        self.relayDir(bundlePath: bundlePath)
    }

    static func _testPreferredGatewayBind() -> String? {
        self.preferredGatewayBind()
    }

    static func _testPreferredGatewayToken() -> String? {
        self.preferredGatewayToken()
    }
}
#endif
