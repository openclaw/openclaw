import Foundation
import OSLog

enum AgentWorkspace {
    private static let logger = Logger(subsystem: "com.steipete.clawdis", category: "workspace")
    static let agentsFilename = "AGENTS.md"

    static func displayPath(for url: URL) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let path = url.path
        if path == home { return "~" }
        if path.hasPrefix(home + "/") {
            return "~/" + String(path.dropFirst(home.count + 1))
        }
        return path
    }

    static func resolveWorkspaceURL(from userInput: String?) -> URL {
        let trimmed = userInput?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if trimmed.isEmpty { return ClawdisConfigFile.defaultWorkspaceURL() }
        let expanded = (trimmed as NSString).expandingTildeInPath
        return URL(fileURLWithPath: expanded, isDirectory: true)
    }

    static func agentsURL(workspaceURL: URL) -> URL {
        workspaceURL.appendingPathComponent(self.agentsFilename)
    }

    static func bootstrap(workspaceURL: URL) throws -> URL {
        try FileManager.default.createDirectory(at: workspaceURL, withIntermediateDirectories: true)
        let agentsURL = self.agentsURL(workspaceURL: workspaceURL)
        if !FileManager.default.fileExists(atPath: agentsURL.path) {
            try self.defaultTemplate().write(to: agentsURL, atomically: true, encoding: .utf8)
            self.logger.info("Created AGENTS.md at \(agentsURL.path, privacy: .public)")
        }
        return agentsURL
    }

    static func defaultTemplate() -> String {
        """
        # AGENTS.md — Clawdis Workspace

        This folder is the assistant’s working directory.

        ## Safety defaults
        - Don’t exfiltrate secrets or private data.
        - Don’t run destructive commands unless explicitly asked.
        - Be concise in chat; write longer output to files in this workspace.

        ## Customize
        - Add your preferred style, rules, and “memory” here.
        """
    }
}
