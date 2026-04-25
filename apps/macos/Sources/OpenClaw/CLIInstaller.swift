import Foundation

@MainActor
enum CLIInstaller {
    struct PreflightStatus: Equatable {
        let needsCommandLineTools: Bool
        let message: String?

        static let ready = PreflightStatus(needsCommandLineTools: false, message: nil)
    }

    static func installedLocation() -> String? {
        self.installedLocation(
            searchPaths: CommandResolver.preferredPaths(),
            fileManager: .default)
    }

    static func installedLocation(
        searchPaths: [String],
        fileManager: FileManager) -> String?
    {
        for basePath in searchPaths {
            let candidate = URL(fileURLWithPath: basePath).appendingPathComponent("openclaw").path
            var isDirectory: ObjCBool = false

            guard fileManager.fileExists(atPath: candidate, isDirectory: &isDirectory),
                  !isDirectory.boolValue
            else {
                continue
            }

            guard fileManager.isExecutableFile(atPath: candidate) else { continue }

            return candidate
        }

        return nil
    }

    static func isInstalled() -> Bool {
        self.installedLocation() != nil
    }

    static func preflight() async -> PreflightStatus {
        let response = await ShellExecutor.runDetailed(
            command: ["/usr/bin/xcode-select", "-p"],
            cwd: nil,
            env: nil,
            timeout: 10)

        guard response.success else {
            return PreflightStatus(
                needsCommandLineTools: true,
                message: """
                Apple Developer Tools are required before OpenClaw can install the CLI.
                Install them first, then come back and click “I've Installed It, Recheck”.
                """)
        }

        return .ready
    }

    static func requestCommandLineToolsInstall(
        statusHandler: @escaping @MainActor @Sendable (String) async -> Void
    ) async {
        await statusHandler("Opening Apple developer tools installer…")
        let response = await ShellExecutor.runDetailed(
            command: ["/usr/bin/xcode-select", "--install"],
            cwd: nil,
            env: nil,
            timeout: 10)

        let combined = [response.stdout, response.stderr]
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()

        if combined.contains("already installed") || combined.contains("softwareupdate") {
            await statusHandler(
                "Apple Developer Tools installer is already open or installed. Finish that step, then click “I've Installed It, Recheck”.")
            return
        }

        await statusHandler(
            "Complete Apple's developer tools installer dialog, then click “I've Installed It, Recheck”.")
    }

    static func install(statusHandler: @escaping @MainActor @Sendable (String) async -> Void) async {
        let expected = GatewayEnvironment.expectedGatewayVersionString() ?? "latest"
        let prefix = Self.installPrefix()
        await statusHandler("Installing openclaw CLI…")
        let cmd = self.installScriptCommand(version: expected, prefix: prefix)
        let response = await ShellExecutor.runDetailed(command: cmd, cwd: nil, env: nil, timeout: 900)

        if response.success {
            let parsed = self.parseInstallEvents(response.stdout)
            let installedVersion = parsed.last { $0.event == "done" }?.version
            let summary = installedVersion.map { "Installed openclaw \($0)." } ?? "Installed openclaw."
            await statusHandler(summary)
            return
        }

        let parsed = self.parseInstallEvents(response.stdout)
        if let error = parsed.last(where: { $0.event == "error" })?.message {
            await statusHandler("Install failed: \(error)")
            return
        }

        let detail = response.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        let fallback = response.errorMessage ?? "install failed"
        await statusHandler("Install failed: \(detail.isEmpty ? fallback : detail)")
    }

    private static func installPrefix() -> String {
        FileManager().homeDirectoryForCurrentUser
            .appendingPathComponent(".openclaw")
            .path
    }

    private static func installScriptCommand(version: String, prefix: String) -> [String] {
        let escapedVersion = self.shellEscape(version)
        let escapedPrefix = self.shellEscape(prefix)
        let script = """
        curl -fsSL https://openclaw.bot/install-cli.sh | \
        bash -s -- --json --no-onboard --prefix \(escapedPrefix) --version \(escapedVersion)
        """
        return ["/bin/bash", "-lc", script]
    }

    private static func parseInstallEvents(_ output: String) -> [InstallEvent] {
        let decoder = JSONDecoder()
        let lines = output
            .split(whereSeparator: \.isNewline)
            .map { String($0) }
        var events: [InstallEvent] = []
        for line in lines {
            guard let data = line.data(using: .utf8) else { continue }
            if let event = try? decoder.decode(InstallEvent.self, from: data) {
                events.append(event)
            }
        }
        return events
    }

    private static func shellEscape(_ raw: String) -> String {
        "'" + raw.replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
    }
}

private struct InstallEvent: Decodable {
    let event: String
    let version: String?
    let message: String?
}
