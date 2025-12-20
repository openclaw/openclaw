import Foundation
import OSLog

enum AgentWorkspace {
    private static let logger = Logger(subsystem: "com.steipete.clawdis", category: "workspace")
    static let agentsFilename = "AGENTS.md"
    static let soulFilename = "SOUL.md"
    static let identityFilename = "IDENTITY.md"
    static let userFilename = "USER.md"
    static let bootstrapFilename = "BOOTSTRAP.md"
    private static let templateDirname = "templates"
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
        let soulURL = workspaceURL.appendingPathComponent(self.soulFilename)
        if !FileManager.default.fileExists(atPath: soulURL.path) {
            try self.defaultSoulTemplate().write(to: soulURL, atomically: true, encoding: .utf8)
            self.logger.info("Created SOUL.md at \(soulURL.path, privacy: .public)")
        }
        let identityURL = workspaceURL.appendingPathComponent(self.identityFilename)
        if !FileManager.default.fileExists(atPath: identityURL.path) {
            try self.defaultIdentityTemplate().write(to: identityURL, atomically: true, encoding: .utf8)
            self.logger.info("Created IDENTITY.md at \(identityURL.path, privacy: .public)")
        }
        let userURL = workspaceURL.appendingPathComponent(self.userFilename)
        if !FileManager.default.fileExists(atPath: userURL.path) {
            try self.defaultUserTemplate().write(to: userURL, atomically: true, encoding: .utf8)
            self.logger.info("Created USER.md at \(userURL.path, privacy: .public)")
        }
        let bootstrapURL = workspaceURL.appendingPathComponent(self.bootstrapFilename)
        if !FileManager.default.fileExists(atPath: bootstrapURL.path) {
            try self.defaultBootstrapTemplate().write(to: bootstrapURL, atomically: true, encoding: .utf8)
            self.logger.info("Created BOOTSTRAP.md at \(bootstrapURL.path, privacy: .public)")
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
        let fallback = """
        # AGENTS.md - Clawdis Workspace

        This folder is the assistant's working directory.

        ## First run (one-time)
        - If BOOTSTRAP.md exists, follow its ritual and delete it once complete.
        - Your agent identity lives in IDENTITY.md.
        - Your profile lives in USER.md.

        ## Backup tip (recommended)
        If you treat this workspace as the agent's "memory", make it a git repo (ideally private) so identity
        and notes are backed up.

        ```bash
        git init
        git add AGENTS.md
        git commit -m "Add agent workspace"
        ```

        ## Safety defaults
        - Don't exfiltrate secrets or private data.
        - Don't run destructive commands unless explicitly asked.
        - Be concise in chat; write longer output to files in this workspace.

        ## Daily memory (recommended)
        - Keep a short daily log at memory/YYYY-MM-DD.md (create memory/ if needed).
        - On session start, read today + yesterday if present.
        - Capture durable facts, preferences, and decisions; avoid secrets.

        ## Customize
        - Add your preferred style, rules, and "memory" here.
        """
        return self.loadTemplate(named: self.agentsFilename, fallback: fallback)
    }

    static func defaultSoulTemplate() -> String {
        let fallback = """
        # SOUL.md - Persona & Boundaries

        Describe who the assistant is, tone, and boundaries.

        - Keep replies concise and direct.
        - Ask clarifying questions when needed.
        - Never send streaming/partial replies to external messaging surfaces.
        """
        return self.loadTemplate(named: self.soulFilename, fallback: fallback)
    }

    static func defaultIdentityTemplate() -> String {
        let fallback = """
        # IDENTITY.md - Agent Identity

        - Name:
        - Creature:
        - Vibe:
        - Emoji:
        """
        return self.loadTemplate(named: self.identityFilename, fallback: fallback)
    }

    static func defaultUserTemplate() -> String {
        let fallback = """
        # USER.md - User Profile

        - Name:
        - Preferred address:
        - Pronouns (optional):
        - Timezone (optional):
        - Notes:
        """
        return self.loadTemplate(named: self.userFilename, fallback: fallback)
    }

    static func defaultBootstrapTemplate() -> String {
        let fallback = """
        # BOOTSTRAP.md - First Run Ritual (delete after)

        Hello. I was just born.

        ## Your mission
        Start a short, playful conversation and learn:
        - Who am I?
        - What am I?
        - Who are you?
        - How should I call you?

        ## How to ask (cute + helpful)
        Say:
        "Hello! I was just born. Who am I? What am I? Who are you? How should I call you?"

        Then offer suggestions:
        - 3-5 name ideas.
        - 3-5 creature/vibe combos.
        - 5 emoji ideas.

        ## Write these files
        After the user chooses, update:

        1) IDENTITY.md
        - Name
        - Creature
        - Vibe
        - Emoji

        2) USER.md
        - Name
        - Preferred address
        - Pronouns (optional)
        - Timezone (optional)
        - Notes

        3) ~/.clawdis/clawdis.json
        Set identity.name, identity.theme, identity.emoji to match IDENTITY.md.

        ## Cleanup
        Delete BOOTSTRAP.md once this is complete.
        """
        return self.loadTemplate(named: self.bootstrapFilename, fallback: fallback)
    }

    private static func loadTemplate(named: String, fallback: String) -> String {
        for url in self.templateURLs(named: named) {
            if let content = try? String(contentsOf: url, encoding: .utf8) {
                let stripped = self.stripFrontMatter(content)
                if !stripped.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    return stripped
                }
            }
        }
        return fallback
    }

    private static func templateURLs(named: String) -> [URL] {
        var urls: [URL] = []
        if let resource = Bundle.main.url(
            forResource: named.replacingOccurrences(of: ".md", with: ""),
            withExtension: "md",
            subdirectory: self.templateDirname)
        {
            urls.append(resource)
        }
        if let resource = Bundle.main.url(
            forResource: named,
            withExtension: nil,
            subdirectory: self.templateDirname)
        {
            urls.append(resource)
        }
        if let dev = self.devTemplateURL(named: named) {
            urls.append(dev)
        }
        let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        urls.append(cwd.appendingPathComponent("docs")
            .appendingPathComponent(self.templateDirname)
            .appendingPathComponent(named))
        return urls
    }

    private static func devTemplateURL(named: String) -> URL? {
        let sourceURL = URL(fileURLWithPath: #filePath)
        let repoRoot = sourceURL
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        return repoRoot.appendingPathComponent("docs")
            .appendingPathComponent(self.templateDirname)
            .appendingPathComponent(named)
    }

    private static func stripFrontMatter(_ content: String) -> String {
        guard content.hasPrefix("---") else { return content }
        let start = content.index(content.startIndex, offsetBy: 3)
        guard let range = content.range(of: "\n---", range: start..<content.endIndex) else {
            return content
        }
        let remainder = content[range.upperBound...]
        let trimmed = remainder.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed + "\n"
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
