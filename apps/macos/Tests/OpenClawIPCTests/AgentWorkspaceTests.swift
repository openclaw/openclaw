import Foundation
import Testing
@testable import OpenClaw

struct AgentWorkspaceTests {
    @Test
    func `display path uses tilde for home`() {
        let home = FileManager().homeDirectoryForCurrentUser
        #expect(AgentWorkspace.displayPath(for: home) == "~")

        let inside = home.appendingPathComponent("Projects", isDirectory: true)
        #expect(AgentWorkspace.displayPath(for: inside).hasPrefix("~/"))
    }

    @Test
    func `resolve workspace URL expands tilde`() {
        let url = AgentWorkspace.resolveWorkspaceURL(from: "~/tmp")
        #expect(url.path.hasSuffix("/tmp"))
    }

    @Test
    func `agents URL appends filename`() {
        let root = URL(fileURLWithPath: "/tmp/ws", isDirectory: true)
        let url = AgentWorkspace.agentsURL(workspaceURL: root)
        #expect(url.lastPathComponent == AgentWorkspace.agentsFilename)
    }

    @Test
    func `bootstrap creates agents file when missing`() throws {
        let tmp = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-ws-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: tmp) }

        let agentsURL = try AgentWorkspace.bootstrap(workspaceURL: tmp)
        #expect(FileManager().fileExists(atPath: agentsURL.path))

        let contents = try String(contentsOf: agentsURL, encoding: .utf8)
        #expect(contents.contains("# AGENTS.md"))

        let identityURL = tmp.appendingPathComponent(AgentWorkspace.identityFilename)
        let userURL = tmp.appendingPathComponent(AgentWorkspace.userFilename)
        let bootstrapURL = tmp.appendingPathComponent(AgentWorkspace.bootstrapFilename)
        #expect(FileManager().fileExists(atPath: identityURL.path))
        #expect(FileManager().fileExists(atPath: userURL.path))
        #expect(FileManager().fileExists(atPath: bootstrapURL.path))

        let second = try AgentWorkspace.bootstrap(workspaceURL: tmp)
        #expect(second == agentsURL)
    }

    @Test
    func `bootstrap safety rejects non empty folder without agents`() throws {
        let tmp = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-ws-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: tmp) }
        try FileManager().createDirectory(at: tmp, withIntermediateDirectories: true)
        let marker = tmp.appendingPathComponent("notes.txt")
        try "hello".write(to: marker, atomically: true, encoding: .utf8)

        let result = AgentWorkspace.bootstrapSafety(for: tmp)
        #expect(result.unsafeReason != nil)
    }

    @Test
    func `bootstrap safety allows existing agents file`() throws {
        let tmp = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-ws-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: tmp) }
        try FileManager().createDirectory(at: tmp, withIntermediateDirectories: true)
        let agents = tmp.appendingPathComponent(AgentWorkspace.agentsFilename)
        try "# AGENTS.md".write(to: agents, atomically: true, encoding: .utf8)

        let result = AgentWorkspace.bootstrapSafety(for: tmp)
        #expect(result.unsafeReason == nil)
    }

    @Test
    func `bootstrap skips bootstrap file when workspace has content`() throws {
        let tmp = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-ws-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: tmp) }
        try FileManager().createDirectory(at: tmp, withIntermediateDirectories: true)
        let marker = tmp.appendingPathComponent("notes.txt")
        try "hello".write(to: marker, atomically: true, encoding: .utf8)

        _ = try AgentWorkspace.bootstrap(workspaceURL: tmp)

        let bootstrapURL = tmp.appendingPathComponent(AgentWorkspace.bootstrapFilename)
        #expect(!FileManager().fileExists(atPath: bootstrapURL.path))
    }

    @Test
    func `needs bootstrap false when identity already set`() throws {
        let tmp = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-ws-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: tmp) }
        try FileManager().createDirectory(at: tmp, withIntermediateDirectories: true)
        let identityURL = tmp.appendingPathComponent(AgentWorkspace.identityFilename)
        try """
        # IDENTITY.md - Agent Identity

        - Name: Nexus
        - Creature: Spider
        - Vibe: Helpful
        - Emoji: spider
        """.write(to: identityURL, atomically: true, encoding: .utf8)
        let bootstrapURL = tmp.appendingPathComponent(AgentWorkspace.bootstrapFilename)
        try "bootstrap".write(to: bootstrapURL, atomically: true, encoding: .utf8)

        #expect(!AgentWorkspace.needsBootstrap(workspaceURL: tmp))
    }
}
