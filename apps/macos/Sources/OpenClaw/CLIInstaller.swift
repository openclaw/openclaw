import Foundation

@MainActor
enum CLIInstaller {
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

    static func install(statusHandler: @escaping @MainActor @Sendable (String) async -> Void) async {
        let prefix = Self.installPrefix()
        await statusHandler("Installing openclaw CLI…")

        let cmd = self.installScriptCommand(version: "latest", prefix: prefix)
        let response = await ShellExecutor.runDetailed(command: cmd, cwd: nil, env: nil, timeout: 900)

        if response.success {
            let parsed = self.parseInstallEvents(response.stdout)
            let installedVersion = parsed.last { $0.event == "done" }?.version
            let summary = installedVersion.map { "Installed openclaw \($0)." } ?? "Installed openclaw."
            await statusHandler(summary)
            return
        }

        await statusHandler("Install failed: \(self.cleanErrorMessage(response))")
    }

    private static func cleanErrorMessage(_ response: ShellExecutor.ShellResult) -> String {
        // Prefer structured JSON error events from the install script.
        let parsed = self.parseInstallEvents(response.stdout)
        if let error = parsed.last(where: { $0.event == "error" })?.message {
            return error
        }
        // Filter out shell profile noise (lines from .bash_profile, .zshrc, etc.)
        let lines = response.stderr.components(separatedBy: CharacterSet.newlines)
        let relevantLines = lines
            .filter { line in
                let l = line.lowercased()
                if l.contains("npm err") || l.contains("npm error") { return true }
                if l.contains("openclaw") || l.contains("install") { return true }
                if l.contains("error") && !l.contains("bash_profile") && !l.contains("zshrc")
                    && !l.contains("profile:")
                { return true }
                return false
            }
            .joined(separator: "\n")
            .trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
        if !relevantLines.isEmpty { return relevantLines }
        return response.errorMessage ?? "install failed"
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
