import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import Testing
import UIKit
@testable import OpenClaw

struct AgentAvatarPresentationTests {
    @Test @MainActor
    func `configured portrait replaces initials and is retired when its source changes`() async throws {
        let model = NodeAppModel()
        model.enterScreenshotFixtureMode()
        defer { model.disconnectGateway() }
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: CGSize(width: 24, height: 24), format: format).pngData { context in
            UIColor.magenta.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 24, height: 24))
        }
        let source = "data:image/png;base64," + image.base64EncodedString()
        model.gatewayAgents = [Self.agent(avatar: source)]
        await model.refreshAgentAvatars(model.agentAvatarRequest)

        let portrait = try #require(model.agentAvatarImage(for: "main"))
        #expect(portrait.size == CGSize(width: 24, height: 24))
        #expect(model.chatPresentation.presentationAgentAvatar === portrait)

        model.selectedAgentId = "research"
        #expect(model.agentAvatarImage(for: "main") === portrait)
        model.selectedAgentId = nil

        model.gatewayAgents = [Self.agent(avatar: "data:image/png;base64,aW52YWxpZA==")]
        #expect(model.agentAvatarImage(for: "main") == nil)
        await model.refreshAgentAvatars(model.agentAvatarRequest)
        #expect(model.agentAvatarImage(for: "main") == nil)
        #expect(model.chatPresentation.presentationAgentAvatar == nil)
        #expect(model.chatPresentation.presentationAgentBadge == "🦞")
    }

    @Test func `agent portraits use the configured Gateway image instead of treating an image path as badge text`() {
        #expect(AgentIdentityPresentation.imageSource(identity: [
            "avatarUrl": AnyCodable("/avatar/main?v=2"),
            "avatar": AnyCodable("/avatar/main?v=1"),
            "emoji": AnyCodable("🦞"),
        ]) == "/avatar/main?v=2")
        #expect(AgentIdentityPresentation.imageSource(identity: ["emoji": AnyCodable("🦞")]) == nil)
        #expect(AgentIdentityPresentation.imageSource(identity: [
            "avatarUrl": AnyCodable("https://other-origin.example/avatar/main"),
        ]) == nil)
    }

    private actor IdentityRequests {
        private(set) var agentIDs: [String] = []

        func record(_ message: URLSessionWebSocketTask.Message) throws -> String {
            let data: Data = switch message {
            case let .data(value): value
            case let .string(value): Data(value.utf8)
            @unknown default: throw URLError(.cannotParseResponse)
            }
            let frame = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            let params = try #require(frame["params"] as? [String: Any])
            let agentID = try #require(params["agentId"] as? String)
            self.agentIDs.append(agentID)
            return agentID
        }
    }

    @Test(.testWaitLimit) @MainActor
    func `chat names the agent by its Gateway identity, never the placeholder name`() async throws {
        let requests = IdentityRequests()
        let socketSession = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
                guard sendIndex > 0 else { return }
                let id = try #require(GatewayWebSocketTestSupport.requestID(from: message))
                var payload = "{}"
                if GatewayWebSocketTestSupport.requestMethod(from: message) == "agent.identity.get" {
                    let agentID = try await requests.record(message)
                    let identity = agentID == "main"
                        ? AgentIdentityResult(agentid: agentID, name: "Molty", namesource: "workspace", avatar: "P")
                        : AgentIdentityResult(agentid: agentID, name: "Assistant", namesource: "default", avatar: "A")
                    payload = try String(bytes: JSONEncoder().encode(identity), encoding: .utf8) ?? "{}"
                }
                socket.emitReceiveSuccess(.data(Data(
                    #"{"type":"res","id":"\#(id)","ok":true,"payload":\#(payload)}"#.utf8)))
            })
        })
        let model = NodeAppModel()
        // A fresh Gateway each run: the resolved identity is cached per Gateway across launches.
        model.connectedGatewayID = "manual|identity-test-\(UUID().uuidString)|1"
        model.selectedAgentId = "main"
        var options = GatewayWebSocketTestSupport.identityFreeOperatorConnectOptions
        options.allowStoredDeviceAuth = false
        options.deviceAuthGatewayID = model.connectedGatewayID
        do {
            try await model.operatorSession.connect(
                url: #require(URL(string: "ws://identity-test.invalid")),
                credentials: .init(),
                connectOptions: options,
                sessionBox: WebSocketSessionBox(session: socketSession),
                onConnected: {},
                onDisconnected: { _ in },
                onInvoke: { BridgeInvokeResponse(id: $0.id, ok: true) })
            model.apply(.connected(GatewaySessionInfo()), to: .operator, route: nil)
            model.gatewayAgents = [
                Self.agent(id: "main", name: "main", identity: nil),
                Self.agent(id: "ops", name: "Operations", identity: nil),
            ]
            #expect(model.chatAgentName == "main")
            await model.refreshAgentAvatars(model.agentAvatarRequest)

            #expect(model.chatAgentName == "Molty")
            #expect(model.chatPresentation.presentationAgentName == "Molty")
            // The Gateway's "Assistant" placeholder is not an identity; the roster name stays.
            #expect(model.chatAgentDisplayName(for: "ops") == "Operations")
            #expect(await requests.agentIDs.sorted() == ["main", "ops"])

            // A roster change keeps resolved names and asks only about changed entries.
            model.gatewayAgents = [
                Self.agent(id: "main", name: "main", identity: nil),
                Self.agent(id: "ops", name: "Ops team", identity: nil),
            ]
            #expect(model.chatAgentName == "Molty")
            await model.refreshAgentAvatars(model.agentAvatarRequest)
            #expect(model.chatAgentName == "Molty")
            #expect(model.chatAgentDisplayName(for: "ops") == "Ops team")
            #expect(await requests.agentIDs.sorted() == ["main", "ops", "ops"])
            await model.makeChatOfflineStore()?.storeAgentIdentities([])
            await model.operatorSession.disconnect()
        } catch {
            await model.makeChatOfflineStore()?.storeAgentIdentities([])
            await model.operatorSession.disconnect()
            throw error
        }
    }

    @Test @MainActor
    func `a cold start draws the last known agent before the Gateway answers`() async throws {
        let gatewayID = "manual|cold-start-\(UUID().uuidString)|1"
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let portrait = UIGraphicsImageRenderer(size: CGSize(width: 24, height: 24), format: format).pngData { context in
            UIColor.magenta.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 24, height: 24))
        }
        let previousLaunch = NodeAppModel()
        previousLaunch.connectedGatewayID = gatewayID
        let store = try #require(previousLaunch.makeChatOfflineStore())
        await store.storeAgentIdentities([
            OpenClawChatCachedAgentIdentity(
                agentID: "main", rosterName: "main", identityName: "Molty", emoji: nil, isDefault: true,
                avatar: portrait),
            OpenClawChatCachedAgentIdentity(
                agentID: "ops", rosterName: "Operations", identityName: nil, emoji: "🦞", isDefault: false,
                avatar: nil),
        ])

        let model = NodeAppModel()
        model.connectedGatewayID = gatewayID

        // Nothing has come from the Gateway yet, so nothing may draw a placeholder.
        #expect(model.gatewayAgents.isEmpty)
        #expect(model.displayAgents.map(\.id) == ["main", "ops"])
        #expect(model.chatAgentDisplayName(for: "main") == "Molty")
        #expect(model.chatAgentDisplayName(for: "") == "Molty")
        #expect(model.chatAgentDisplayName(for: "ops") == "Operations")
        #expect(model.agentAvatarImage(for: "main")?.size == CGSize(width: 24, height: 24))
        #expect(model.agentAvatarImage(for: "ops") == nil)
        #expect(model.knowsAgentAvatar(for: "ops"))
        #expect(!model.hasResolvedAgentAvatar(for: "main"))
        await store.storeAgentIdentities([])
    }

    private static func agent(avatar: String) -> AgentSummary {
        self.agent(id: "main", name: "Portrait", identity: ["avatarUrl": AnyCodable(avatar), "emoji": AnyCodable("🦞")])
    }

    private static func agent(id: String, name: String?, identity: [String: AnyCodable]?) -> AgentSummary {
        AgentSummary(
            id: id,
            name: name,
            identity: identity,
            workspace: nil,
            workspacegit: nil,
            model: nil,
            agentruntime: nil,
            thinkinglevels: nil,
            thinkingoptions: nil,
            thinkingdefault: nil)
    }
}
