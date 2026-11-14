import OpenClawProtocol
import Testing
import UIKit
@testable import OpenClaw

struct AgentAvatarPresentationTests {
    @Test @MainActor func `configured portrait replaces initials and is retired when its source changes`() async throws {
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

    private static func agent(avatar: String) -> AgentSummary {
        AgentSummary(
            id: "main", name: "Portrait", identity: ["avatarUrl": AnyCodable(avatar), "emoji": AnyCodable("🦞")],
            workspace: nil, workspacegit: nil, model: nil, agentruntime: nil,
            thinkinglevels: nil, thinkingoptions: nil, thinkingdefault: nil)
    }
}
