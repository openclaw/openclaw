import ClawdisKit
import Foundation
import Testing

@Suite struct CanvasA2UIActionTests {
    @Test func sanitizeTagValueIsStable() {
        #expect(ClawdisCanvasA2UIAction.sanitizeTagValue("Hello World!") == "Hello_World_")
        #expect(ClawdisCanvasA2UIAction.sanitizeTagValue("  ") == "-")
        #expect(ClawdisCanvasA2UIAction.sanitizeTagValue("macOS 26.2") == "macOS_26.2")
    }

    @Test func extractActionNameAcceptsNameOrAction() {
        #expect(ClawdisCanvasA2UIAction.extractActionName(["name": "Hello"]) == "Hello")
        #expect(ClawdisCanvasA2UIAction.extractActionName(["action": "Wave"]) == "Wave")
        #expect(ClawdisCanvasA2UIAction.extractActionName(["name": "  ", "action": "Fallback"]) == "Fallback")
        #expect(ClawdisCanvasA2UIAction.extractActionName(["action": " "]) == nil)
    }

    @Test func formatAgentMessageIsTokenEfficientAndUnambiguous() {
        let msg = ClawdisCanvasA2UIAction.formatAgentMessage(
            actionName: "Get Weather",
            sessionKey: "main",
            surfaceId: "main",
            sourceComponentId: "btnWeather",
            host: "Peter’s iPad",
            instanceId: "ipad16,6",
            contextJSON: "{\"city\":\"Vienna\"}")

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
