import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawChatUI

struct WorkspaceFileBrowserTests {
    @Test func `list params encode agent id path and offset`() throws {
        let json = try WorkspaceBrowserLoader.listParamsJSON(agentId: "main", path: "src/app", offset: 250)
        let decoded = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]
        #expect(decoded?["agentId"] as? String == "main")
        #expect(decoded?["path"] as? String == "src/app")
        #expect(decoded?["offset"] as? Int == 250)
    }

    @Test func `list params omit the root path`() throws {
        let json = try WorkspaceBrowserLoader.listParamsJSON(agentId: "main", path: "", offset: nil)
        let decoded = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]
        #expect(decoded?["agentId"] as? String == "main")
        #expect(decoded?["path"] == nil)
        #expect(decoded?["offset"] == nil)
    }

    @Test func `list decodes gateway payloads through the requester`() async throws {
        let payload = """
        {
          "agentId": "main",
          "workspace": "/tmp/workspace",
          "path": "",
          "entries": [
            {"path": "notes", "name": "notes", "kind": "directory", "updatedAtMs": 1},
            {"path": "report.txt", "name": "report.txt", "kind": "file", "size": 16, "updatedAtMs": 2}
          ],
          "truncated": true
        }
        """
        let result = try await WorkspaceBrowserLoader.list(agentId: "main", path: "", offset: nil) { method, _ in
            #expect(method == "agents.workspace.list")
            return Data(payload.utf8)
        }
        #expect(result.entries.count == 2)
        #expect(result.truncated == true)
        #expect(WorkspaceFileSupport.isDirectory(result.entries[0]))
        #expect(!WorkspaceFileSupport.isDirectory(result.entries[1]))
        #expect(result.entries[1].size == 16)
    }

    @Test func `read decodes utf8 and base64 files`() async throws {
        let payload = """
        {
          "agentId": "main",
          "workspace": "/tmp/workspace",
          "file": {
            "path": "pixel.png",
            "name": "pixel.png",
            "size": 68,
            "updatedAtMs": 3,
            "encoding": "base64",
            "mimeType": "image/png",
            "content": "aGk="
          }
        }
        """
        let file = try await WorkspaceBrowserLoader.read(agentId: "main", path: "pixel.png") { method, params in
            #expect(method == "agents.workspace.read")
            #expect(params.contains("\"pixel.png\""))
            return Data(payload.utf8)
        }
        #expect(WorkspaceFileSupport.isBase64(file))
        #expect(file.mimetype == "image/png")
    }

    @Test func `language id maps known code extensions and skips unknown ones`() {
        #expect(WorkspaceFileSupport.languageId(forFileName: "Main.swift") == "swift")
        #expect(WorkspaceFileSupport.languageId(forFileName: "index.ts") == "ts")
        #expect(WorkspaceFileSupport.languageId(forFileName: "config.json") == "json")
        #expect(WorkspaceFileSupport.languageId(forFileName: "README.md") == nil)
        #expect(WorkspaceFileSupport.languageId(forFileName: "no-extension") == nil)
    }

    @Test func `export writes utf8 text under the file name`() throws {
        let file = AgentsWorkspaceFile(
            path: "notes/todo.md",
            name: "todo.md",
            size: 6,
            updatedatms: 1,
            encoding: AnyCodable("utf8"),
            mimetype: "text/markdown",
            content: "# Todo")
        let url = try WorkspaceFileSupport.exportURL(for: file)
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        #expect(url.lastPathComponent == "todo.md")
        #expect(try String(contentsOf: url, encoding: .utf8) == "# Todo")
    }

    @Test func `export decodes base64 content to raw bytes`() throws {
        let file = AgentsWorkspaceFile(
            path: "pixel.png",
            name: "pixel.png",
            size: 2,
            updatedatms: 1,
            encoding: AnyCodable("base64"),
            mimetype: "image/png",
            content: Data([0x89, 0x50]).base64EncodedString())
        let url = try WorkspaceFileSupport.exportURL(for: file)
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        #expect(try Data(contentsOf: url) == Data([0x89, 0x50]))
    }
}
