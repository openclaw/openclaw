import ConcurrencyExtras
import Foundation
import OpenClawKit
import SwiftUI
import Testing
@testable import OpenClaw
@testable import OpenClawChatUI

@Suite(.serialized)
@MainActor
struct WebChatManagerTests {
    @Test func `route identity includes the session and normalized agent`() {
        let work = WebChatRoute(sessionKey: "global", agentID: " Work ")
        let sameWork = WebChatRoute(sessionKey: "global", agentID: "work")
        let main = WebChatRoute(sessionKey: "global", agentID: "main")

        #expect(work == sameWork)
        #expect(work != main)
        #expect(work != WebChatRoute(sessionKey: "main", agentID: "work"))
    }

    @Test func `blank agent route normalizes to nil`() {
        #expect(WebChatRoute(sessionKey: "global", agentID: "  ") ==
            WebChatRoute(sessionKey: "global", agentID: nil))
    }

    @Test(arguments: [
        ("main", "research", "/chat/research"),
        ("Main", "research", "/chat/research"),
        ("global", "research", "/chat/research"),
        ("Global", "research", "/chat/research"),
        ("agent:research:main", "main", "/chat/research"),
        ("agent:research:Main", "main", "/chat/research"),
        ("agent:research:global", "main", "/chat/research/~key/global"),
        ("agent:research:Global", "main", "/chat/research/~key/Global"),
        ("AGENT:RESEARCH:GlObAl", "main", "/chat/research/~key/GlObAl"),
        ("agent:research:global:notes", "main", "/chat/research/global/notes"),
    ])
    func `Dashboard URLs distinguish home aliases from qualified literal sessions`(
        sessionKey: String,
        agentID: String,
        expectedPath: String)
    {
        #expect(WebChatRoute.dashboardPath(sessionKey: sessionKey, agentID: agentID) == expectedPath)
    }
}

extension WebChatManagerTests {
    @Test(arguments: [false, true])
    func `copied links preserve Gateway mounts and exact session keys without credentials`(preview: Bool) throws {
        let base = try #require(URL(string: "wss://user:password@example.test/control/?token=private#fragment"))
        let url = try #require(WebChatManager.sessionLink(
            base: base,
            sessionKey: "agent:bulk:release/#?",
            agentID: "main",
            preview: preview))
        #expect(url
            .absoluteString == "https://example.test/control" + (preview ? "/share" : "") +
            "/chat/bulk/~key/release%2F%23%3F")
    }
}

extension WebChatManagerTests {
    @Test(arguments: [true, false])
    func `window Gateway wiring enables menus before native menu presentation`(local: Bool) async throws {
        let methods = LockIsolated<[String]>([])
        let sockets = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { socket, message, index in
                guard index > 0, let id = GatewayWebSocketTestSupport.requestID(from: message),
                      let method = GatewayWebSocketTestSupport.requestMethod(from: message) else { return }
                methods.withValue { $0.append(method) }
                let payload = switch method {
                case "users.self": #"{"profile":{"id":"me","emails":[]}}"#
                case "users.list": #"{"profiles":[{"id":"me","emails":[]},{"id":"ada","emails":[],"displayName":"Ada"}]}"#
                case "worktrees.list": #"{"worktrees":[{"id":"copy","name":"copy","repoFingerprint":"repo","repoRoot":"/work/repo","path":"/work/copy","branch":"launch","baseRef":"main","ownerKind":"session","createdAt":1,"lastActiveAt":2}]}"#
                case "chat.history": #"{"sessionId":"launch-id","messages":[{"role":"user","content":[{"type":"text","text":"Ready to launch"}]}]}"#
                default: #"{"ok":true}"#
                }
                socket.emitReceiveSuccess(.data(Data(
                    #"{"type":"res","id":"\#(id)","ok":true,"payload":\#(payload)}"#.utf8)))
            }, receiveHook: { socket, index in
                if index == 0 { return .data(GatewayWebSocketTestSupport.connectChallengeData()) }
                let hello = GatewayWebSocketTestSupport.connectOkData(
                    id: socket.snapshotConnectRequestID() ?? "connect",
                    methods: [
                        "sessions.patch",
                        "sessions.assignOwner",
                        "chat.history",
                        "sessions.groups.rename",
                        "sessions.groups.put",
                        "sessions.groups.delete",
                        "sessions.setInvolvement",
                    ], scopes: ["operator.admin"])
                var frame = try #require(JSONSerialization.jsonObject(with: hello) as? [String: Any])
                var payload = try #require(frame["payload"] as? [String: Any])
                var policy = try #require(payload["policy"] as? [String: Any])
                policy["hasMultipleSessionSharingIdentities"] = true
                payload["policy"] = policy
                frame["payload"] = payload
                return try .data(JSONSerialization.data(withJSONObject: frame))
            })
        })
        let gateway = GatewayConnection(
            configProvider: { (url: URL(string: "wss://menu.example.test/control/")!, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: sockets))
        let suite = "WebChatMenuTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        do {
            let transport = MacGatewayChatTransport(connection: gateway, defaultGlobalAgentID: "research")
            let commands = OpenClawChatWindowCommands()
            _ = try await gateway.acquireServerLease()
            var deliveries = await gateway.subscribe().makeAsyncIterator()
            let delivery = try #require(await deliveries.next())
            let target: DashboardGatewayTarget = local ? .local : .profile("menu-fixture")
            WebChatSwiftUIWindowController.configureSessionMenus(
                commands, connection: gateway, target: target, delivery: delivery)
            let connection = try #require(commands.sessionMenuActions.connection)
            #expect(connection.allows("sessions.patch"))
            let vm = OpenClawChatViewModel(
                sessionKey: "agent:research:launch", transport: transport,
                modelPickerStore: ChatModelPickerStore(defaults: defaults))
            defer { vm.detachTransport() }
            let row = try JSONDecoder().decode(
                OpenClawChatSessionEntry.self,
                from: Data(
                    #"{"key":"agent:research:launch","sessionId":"launch-id","label":"Launch plan","pinned":true,"hiddenFromInvolvingMe":false,"worktree":{"id":"copy"},"owner":{"actor":{"type":"human","id":"ada"}}}"#
                        .utf8))
            let sidebar = ChatSessionSidebar(
                viewModel: vm, query: .constant(""), groups: .constant([]),
                previews: ChatSessionSidebarPreviews(), menuActions: commands.sessionMenuActions)
            func makeMenu() -> NSMenu {
                let menu = NSHostingMenu(rootView: sidebar.contextMenu(for: row, isChild: false))
                menu.update()
                return menu
            }
            let initialMenu = makeMenu()
            #expect(try #require(initialMenu.items.first { $0.title == "Icon & color…" }).isEnabled)
            #expect(try #require(initialMenu.items.first { $0.title == "Hide from Involving me" }).isEnabled)
            // Admission starts the owner's prefetch; native menu contents need no appearance task.
            await commands.sessionMenuActions.refreshTask?.value
            let menu = makeMenu()
            for title in ["Assign to…", "Copy", "Open in"] {
                let item = try #require(menu.items.first { $0.title == title })
                let submenu = try #require(item.submenu)
                submenu.update()
                let items = submenu.items.filter { !$0.isSeparatorItem }
                if title == "Assign to…" {
                    #expect(items.map(\.isEnabled) == [true, false])
                } else {
                    let enabled = items.allSatisfy(\.isEnabled)
                    #expect(enabled)
                }
                if title == "Open in" {
                    #expect(items
                        .map(\.title) ==
                        (local ? ["New window", "Cursor", "VS Code", "Windsurf", "Zed"] : ["New window"]))
                }
            }
            let group = NSHostingMenu(rootView: sidebar.groupMenu("Research"))
            group.update()
            let groupItems = group.items.filter { !$0.isSeparatorItem }
            #expect(groupItems.map(\.title) == ["Rename…", "New group…", "Delete…"])
            let groupEnabled = groupItems.allSatisfy(\.isEnabled)
            #expect(groupEnabled)
            #expect(connection.link(row, false)?
                .absoluteString == "https://menu.example.test/control/chat/research/~key/launch")
            #expect(connection.link(row, true)?
                .absoluteString == "https://menu.example.test/control/share/chat/research/~key/launch")
            #expect(try await vm.sidebarMarkdown(session: row, connection: connection).contains("Ready to launch"))
            try await connection.request(OpenClawChatGatewayRequests.sessionMenu(
                "sessions.patch", session: row, fields: ["icon": .init("rocket")]))
            #expect(methods.value.contains("sessions.patch"))
            #expect(methods.value.contains("worktrees.list") == local)
            await gateway.shutdown()
            let disconnected = try #require(await deliveries.next())
            WebChatSwiftUIWindowController.configureSessionMenus(
                commands, connection: gateway, target: target, delivery: disconnected)
            #expect(commands.sessionMenuActions.connection == nil)
            #expect(!connection.allows("sessions.patch"))
            #expect(connection.link(row, false) == nil)
            WebChatSwiftUIWindowController.configureSessionMenus(
                commands, connection: gateway, target: target, delivery: delivery)
            #expect(commands.sessionMenuActions.connection == nil)
        } catch {
            await gateway.shutdown()
            throw error
        }
    }
}
