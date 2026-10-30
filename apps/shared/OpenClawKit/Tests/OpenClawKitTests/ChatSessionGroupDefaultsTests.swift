#if os(macOS)
import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawChatUI

@MainActor
struct ChatSessionGroupDefaultsTests {
    private let defaults = Data(#"{"defaults":[{"name":"Research","cwd":"/work/repo","worktree":true},{"name":"Ops"}]}"#
        .utf8)

    private func model(
        request: ((OpenClawChatGatewayRequest) async throws -> Data)? = nil,
        list: @escaping (String?) async throws -> FsListDirResult = { _ in throw URLError(.cannotFindHost) },
        inspect: @escaping (String) async throws -> WorktreeRepositoryStatus = { _ in .git }) throws
        -> ChatSessionGroupDefaultsModel
    {
        var connection = try sidebarMenuConnection(request: request ?? { _ in self.defaults })
        connection.groupDefaultsBrowser = OpenClawGroupDefaultsBrowser(listDirectory: list, inspectRepository: inspect)
        return ChatSessionGroupDefaultsModel(
            name: "Research",
            connection: connection,
            agentWorkspace: " /agent/workspace ")
    }

    @Test func `defaults failure retries the defaults RPC and a missing group cannot be saved`() async throws {
        var failing = true
        var reads = 0
        let model = try self.model(request: { request in
            #expect(request.method == "sessions.groups.defaults")
            reads += 1
            if failing { throw URLError(.networkConnectionLost) }
            return self.defaults
        })
        await model.load()
        #expect(model.failure != nil)
        #expect(!model.canSave)
        failing = false
        await model.load()
        #expect(reads == 2)
        #expect(model.cwd == "/work/repo")
        #expect(model.failure == nil)
        #expect(model.canSave)
        #expect(model.worktree)
        let missing = try self.model(request: { _ in Data(#"{"defaults":[{"name":"Ops"}]}"#.utf8) })
        await missing.load()
        #expect(missing.saved == nil)
        #expect(missing.failure != nil)
        #expect(await missing.save() == false)
    }

    @Test func `repository retry restores saved mode and selecting a folder resets it`() async throws {
        var result: WorktreeRepositoryStatus = .unavailable
        var paths: [String] = []
        let model = try self.model(inspect: { path in paths.append(path)
            return result
        })
        await model.load()
        await model.inspect(restoreSaved: true)
        #expect(!model.canSave)
        #expect(!model.worktree)
        result = .git
        await model.inspect(restoreSaved: true)
        #expect(model.worktree)
        #expect(model.canSave)
        await model.select(" /work/other ")
        #expect(model.cwd == "/work/other")
        #expect(!model.worktree)
        result = .notGit
        await model.select("")
        #expect(paths.last == "/agent/workspace")
        #expect(model.canSave)
        #expect(!model.worktree)
    }

    @Test func `save failure retains selections and empty cwd clears the Gateway default`() async throws {
        var failing = true
        var sent: [OpenClawChatGatewayRequest] = []
        let model = try self.model(request: { request in
            if request.method == "sessions.groups.defaults" { return self.defaults }
            sent.append(request)
            if failing { throw URLError(.networkConnectionLost) }
            return Data(#"{"ok":true,"defaults":[{"name":"Research","worktree":false}]}"#.utf8)
        }, inspect: { _ in .notGit })
        await model.load()
        await model.select("")
        #expect(await model.save() == false)
        #expect(model.failure != nil)
        #expect(model.canSave)
        failing = false
        #expect(await model.save())
        #expect(model.failure == nil)
        #expect(sent.count == 2)
        let payload = try JSONSerialization.jsonObject(with: JSONEncoder().encode(sent[1].params)) as? NSDictionary
        #expect(sent[1].method == "sessions.groups.update")
        #expect(payload == ["name": "Research", "cwd": NSNull(), "worktree": false] as NSDictionary)
    }

    @Test func `validation completion cannot reapply an earlier visit to the same folder`() async throws {
        var held: CheckedContinuation<WorktreeRepositoryStatus, Never>?
        var entered: CheckedContinuation<Void, Never>?
        var connection = try sidebarMenuConnection { _ in self.defaults }
        connection.groupDefaultsBrowser = .init(
            listDirectory: { _ in throw CancellationError() },
            inspectRepository: { _ in
                if let entered {
                    return await withCheckedContinuation { held = $0
                        entered.resume()
                    }
                }
                return .notGit
            })
        let overlapping = ChatSessionGroupDefaultsModel(name: "Research", connection: connection, agentWorkspace: nil)
        await overlapping.load()
        let first = Task { await overlapping.inspect(restoreSaved: true) }
        await withCheckedContinuation { entered = $0 }
        entered = nil
        await overlapping.select("/work/other")
        await overlapping.select("/work/repo")
        held?.resume(returning: .git)
        await first.value
        #expect(overlapping.repository == .notGit)
        #expect(!overlapping.worktree)
    }

    @Test func `directory failure retries root once and preserves loaded folders`() async throws {
        var paths: [String?] = []
        var failRoot = false
        let model = try self.model(list: { path in
            paths.append(path)
            if path != nil || failRoot { throw URLError(.cannotOpenFile) }
            return try JSONDecoder().decode(
                FsListDirResult.self,
                from: Data(
                    #"{"path":"/home","parent":"/","home":"/home","entries":[{"name":"repo","path":"/home/repo","hidden":false}]}"#
                        .utf8))
        })
        await model.navigate("/missing")
        #expect(paths.count == 2)
        #expect(paths[0] == "/missing")
        #expect(paths[1] == nil)
        #expect(model.browserError != nil)
        #expect(model.listing?.path == "/home")
        await model.navigate("/inaccessible")
        #expect(paths.count == 3)
        #expect(model.listing?.path == "/home")
        model.closeBrowser()
        failRoot = true
        await model.navigate(nil)
        #expect(model.browserError != nil)
        failRoot = false
        await model.navigate(nil)
        #expect(model.browserError == nil)
        #expect(model.entries.map(\.name) == ["repo"])
    }

    @Test func `Gateway directory filtering preserves spelling and hidden folder rules`() async throws {
        let listing = try JSONDecoder().decode(
            FsListDirResult.self,
            from: Data(
                #"""
                {"path":"/home","parent":"/","home":"/home","entries":[\#
                {"name":"App","path":"/home/App","hidden":false},\#
                {"name":"app","path":"/home/app","hidden":false},\#
                {"name":"app2","path":"/home/app2","hidden":false},\#
                {"name":"myapp","path":"/home/myapp","hidden":false},\#
                {"name":".app","path":"/home/.app","hidden":true}]}
                """#.utf8))
        let model = try self.model(list: { _ in listing })
        await model.navigate(nil)
        model.editDraft(" /home ")
        #expect(model.entries.count == 5)
        model.editDraft("/home/app")
        #expect(model.entries.map(\.name) == ["app", "App", "app2", "myapp"])
        model.moveHighlight(1)
        #expect(model.completeHighlighted())
        #expect(model.draft == "/home/App")
        model.editDraft("/home/.a")
        #expect(model.entries.map(\.name) == [".app"])
        model.editDraft("/home/")
        #expect(model.entries.count == 5)
        model.editDraft("relative")
        #expect(model.usablePath == nil)
        await model.activate()
        #expect(model.draft == "relative")
        model.editDraft("")
        #expect(model.usablePath?.isEmpty == true)
        model.editDraft("/other/")
        #expect(!model.hasNoSubfolders)
        model.closeBrowser()
    }

    @Test(arguments: [
        ("C:\\Repo\\..\\Work", "c:/work"),
        ("//host/share/../folder", "//HOST/share/folder"),
        ("/one/../two/", "/two"),
    ])
    func `remote paths follow Gateway platform spelling`(_ paths: (String, String)) {
        #expect(ChatSessionGroupDefaultsModel.samePath(paths.0, paths.1))
        #expect(!ChatSessionGroupDefaultsModel.samePath("/App", "/app"))
    }

    @Test func `folder RPC builders preserve remote paths and request repository status`() throws {
        let directory = OpenClawChatGatewayRequests.groupDefaultsDirectory(nil)
        #expect(directory.method == "fs.listDir")
        #expect(directory.params.isEmpty)
        let request = OpenClawChatGatewayRequests.groupDefaultsRepository("C:\\work\\repo")
        #expect(request.method == "worktrees.branches")
        let payload = try JSONSerialization.jsonObject(with: JSONEncoder().encode(request.params)) as? NSDictionary
        #expect(payload == ["repoRoot": "C:\\work\\repo", "includeRepositoryStatus": true] as NSDictionary)
    }

    @Test func `agent catalog keeps Gateway workspace through identity enrichment`() throws {
        let catalog = try OpenClawChatGatewayPayloadCodec
            .decodeAgentsList(
                Data(
                    #"{"defaultId":"research","mainKey":"main","scope":"per-sender","agents":[{"id":"research","name":"Research","workspace":"/work/research","workspaceGit":true}]}"#
                        .utf8))
        let agent = try #require(catalog.agents.first)
        let identity = try JSONDecoder().decode(
            AgentIdentityResult.self,
            from: Data(#"{"agentId":"research","name":"Assistant","emoji":"🦞"}"#.utf8))
        #expect(agent.workspace == "/work/research")
        #expect(agent.resolving(identity).workspace == "/work/research")
        #expect(agent.resolving(identity).displayName == "Research")
    }

    @Test func `submission excludes duplicate saves and refuses a retired connection`() async throws {
        var reply: CheckedContinuation<Data, Never>?
        var entered: CheckedContinuation<Void, Never>?
        var current = true
        var writes = 0
        var connection = try sidebarMenuConnection(current: { current }, request: { request in
            if request.method == "sessions.groups.defaults" { return self.defaults }
            writes += 1
            return await withCheckedContinuation { reply = $0
                entered?.resume()
            }
        })
        connection.groupDefaultsBrowser = .init(
            listDirectory: { _ in throw CancellationError() },
            inspectRepository: { _ in .git })
        let model = ChatSessionGroupDefaultsModel(name: "Research", connection: connection, agentWorkspace: nil)
        await model.load()
        await model.inspect(restoreSaved: true)
        let saving = Task { await model.save() }
        await withCheckedContinuation { entered = $0 }
        #expect(model.submitting)
        #expect(await model.save() == false)
        #expect(writes == 1)
        current = false
        reply?.resume(returning: Data(#"{"ok":true,"defaults":[]}"#.utf8))
        #expect(await saving.value == false)
        #expect(model.failure != nil)
        #expect(!model.submitting)
        #expect(await model.save() == false)
        #expect(writes == 1)
    }

    @Test func `closed browser drops its pending listing and relative Enter stays put`() async throws {
        var reply: CheckedContinuation<FsListDirResult, Never>?
        var entered: CheckedContinuation<Void, Never>?
        var requests = 0
        let model = try self.model(list: { _ in
            requests += 1
            return await withCheckedContinuation { reply = $0
                entered?.resume()
            }
        })
        let browsing = Task { await model.navigate(nil) }
        await withCheckedContinuation { entered = $0 }
        model.closeBrowser()
        reply?.resume(returning: FsListDirResult(path: "/old", home: "/old", entries: []))
        await browsing.value
        #expect(model.listing == nil)
        #expect(!model.browserVisible)
        model.editDraft("relative")
        await model.activate()
        #expect(requests == 1)
    }
}
#endif
