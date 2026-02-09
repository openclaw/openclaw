import EasyHubKit
import Foundation
import Testing

@Suite struct CanvasA2UIActionTests {
    @Test func sanitizeTagValueIsStable() {
        #expect(EasyHubCanvasA2UIAction.sanitizeTagValue("Hello World!") == "Hello_World_")
        #expect(EasyHubCanvasA2UIAction.sanitizeTagValue("  ") == "-")
        #expect(EasyHubCanvasA2UIAction.sanitizeTagValue("macOS 26.2") == "macOS_26.2")
    }

    @Test func extractActionNameAcceptsNameOrAction() {
        #expect(EasyHubCanvasA2UIAction.extractActionName(["name": "Hello"]) == "Hello")
        #expect(EasyHubCanvasA2UIAction.extractActionName(["action": "Wave"]) == "Wave")
        #expect(EasyHubCanvasA2UIAction.extractActionName(["name": "  ", "action": "Fallback"]) == "Fallback")
        #expect(EasyHubCanvasA2UIAction.extractActionName(["action": " "]) == nil)
    }

    @Test func formatAgentMessageIsTokenEfficientAndUnambiguous() {
        let messageContext = EasyHubCanvasA2UIAction.AgentMessageContext(
            actionName: "Get Weather",
            session: .init(key: "main", surfaceId: "main"),
            component: .init(id: "btnWeather", host: "Peter’s iPad", instanceId: "ipad16,6"),
            contextJSON: "{\"city\":\"Vienna\"}")
        let msg = EasyHubCanvasA2UIAction.formatAgentMessage(messageContext)

        #expect(msg.contains("CANVAS_A2UI "))
        #expect(msg.contains("action=Get_Weather"))
        #expect(msg.contains("session=main"))
        #expect(msg.contains("surface=main"))
        #expect(msg.contains("component=btnWeather"))
        #expect(msg.contains("host=Peter_s_iPad"))
        #expect(msg.contains("instance=ipad16_6 ctx={\"city\":\"Vienna\"}"))
        #expect(msg.hasSuffix(" default=update_canvas"))
    }
}
