import Foundation
import OSLog

enum AgentWorkspace {
    private static let logger = Logger(subsystem: "com.steipete.clawdis", category: "workspace")
    static let agentsFilename = "AGENTS.md"
    static let identityStartMarker = "<!-- clawdis:identity:start -->"
    static let identityEndMarker = "<!-- clawdis:identity:end -->"

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

    static func upsertIdentity(workspaceURL: URL, identity: AgentIdentity) throws {
        let agentsURL = try self.bootstrap(workspaceURL: workspaceURL)
        var content = (try? String(contentsOf: agentsURL, encoding: .utf8)) ?? ""
        let block = self.identityBlock(identity: identity)

        if let start = content.range(of: self.identityStartMarker),
           let end = content.range(of: self.identityEndMarker),
           start.lowerBound < end.upperBound
        {
            content.replaceSubrange(
                start.lowerBound..<end.upperBound,
                with: block.trimmingCharacters(in: .whitespacesAndNewlines))
        } else if let insert = self.identityInsertRange(in: content) {
            content.insert(contentsOf: "\n\n## Identity\n\(block)\n", at: insert.upperBound)
        } else {
            content = [content.trimmingCharacters(in: .whitespacesAndNewlines), "## Identity\n\(block)"]
                .filter { !$0.isEmpty }
                .joined(separator: "\n\n")
                .appending("\n")
        }

        try content.write(to: agentsURL, atomically: true, encoding: .utf8)
        self.logger.info("Updated identity in \(agentsURL.path, privacy: .public)")
    }

    static func defaultTemplate() -> String {
        """
        # AGENTS.md — Clawdis Workspace

        This folder is the assistant’s working directory.

        ## Backup tip (recommended)
        If you treat this workspace as the agent’s “memory”, make it a git repo (ideally private) so your identity
        and notes are backed up.

        ```bash
        git init
        git add AGENTS.md
        git commit -m "Add agent workspace"
        ```

        ## Safety defaults
        - Don’t exfiltrate secrets or private data.
        - Don’t run destructive commands unless explicitly asked.
        - Be concise in chat; write longer output to files in this workspace.

        ## Customize
        - Add your preferred style, rules, and “memory” here.
        """
    }

    private static func identityBlock(identity: AgentIdentity) -> String {
        let name = identity.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let theme = identity.theme.trimmingCharacters(in: .whitespacesAndNewlines)
        let emoji = identity.emoji.trimmingCharacters(in: .whitespacesAndNewlines)

        return """
        \(self.identityStartMarker)
        - Name: \(name)
        - Theme: \(theme)
        - Emoji: \(emoji)
        \(self.identityEndMarker)
        """
    }

    private static func identityInsertRange(in content: String) -> Range<String.Index>? {
        if let firstHeading = content.range(of: "\n") {
            // Insert after the first line (usually "# AGENTS.md …")
            return firstHeading
        }
        return nil
    }
}
