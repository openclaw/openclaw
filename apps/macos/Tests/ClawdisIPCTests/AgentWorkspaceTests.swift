import Foundation
import Testing
@testable import Clawdis

@Suite
struct AgentWorkspaceTests {
    @Test
    func displayPathUsesTildeForHome() {
        let home = FileManager.default.homeDirectoryForCurrentUser
        #expect(AgentWorkspace.displayPath(for: home) == "~")

        let inside = home.appendingPathComponent("Projects", isDirectory: true)
        #expect(AgentWorkspace.displayPath(for: inside).hasPrefix("~/"))
    }

    @Test
    func resolveWorkspaceURLExpandsTilde() {
        let url = AgentWorkspace.resolveWorkspaceURL(from: "~/tmp")
        #expect(url.path.hasSuffix("/tmp"))
    }

    @Test
    func agentsURLAppendsFilename() {
        let root = URL(fileURLWithPath: "/tmp/ws", isDirectory: true)
        let url = AgentWorkspace.agentsURL(workspaceURL: root)
        #expect(url.lastPathComponent == AgentWorkspace.agentsFilename)
    }

    @Test
    func bootstrapCreatesAgentsFileWhenMissing() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("clawdis-ws-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let agentsURL = try AgentWorkspace.bootstrap(workspaceURL: tmp)
        #expect(FileManager.default.fileExists(atPath: agentsURL.path))

        let contents = try String(contentsOf: agentsURL, encoding: .utf8)
        #expect(contents.contains("# AGENTS.md"))

        let identityURL = tmp.appendingPathComponent(AgentWorkspace.identityFilename)
        let userURL = tmp.appendingPathComponent(AgentWorkspace.userFilename)
        let bootstrapURL = tmp.appendingPathComponent(AgentWorkspace.bootstrapFilename)
        #expect(FileManager.default.fileExists(atPath: identityURL.path))
        #expect(FileManager.default.fileExists(atPath: userURL.path))
        #expect(FileManager.default.fileExists(atPath: bootstrapURL.path))

        let second = try AgentWorkspace.bootstrap(workspaceURL: tmp)
        #expect(second == agentsURL)
    }
}
