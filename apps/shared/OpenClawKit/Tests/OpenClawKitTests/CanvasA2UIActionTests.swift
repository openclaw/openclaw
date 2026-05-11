import OpenClawKit
import Foundation
import Testing

@Suite struct CanvasA2UIActionTests {
    @Test func sanitizeTagValueIsStable() {
        #expect(OpenClawCanvasA2UIAction.sanitizeTagValue("Hello World!") == "Hello_World_")
        #expect(OpenClawCanvasA2UIAction.sanitizeTagValue("  ") == "-")
        #expect(OpenClawCanvasA2UIAction.sanitizeTagValue("macOS 26.2") == "macOS_26.2")
    }

    @Test func extractActionNameAcceptsNameOrAction() {
        #expect(OpenClawCanvasA2UIAction.extractActionName(["name": "Hello"]) == "Hello")
        #expect(OpenClawCanvasA2UIAction.extractActionName(["action": "Wave"]) == "Wave")
        #expect(OpenClawCanvasA2UIAction.extractActionName(["name": "  ", "action": "Fallback"]) == "Fallback")
        #expect(OpenClawCanvasA2UIAction.extractActionName(["action": " "]) == nil)
    }

    @Test func talkRealtimeActionNamesAreRecognizedForNativeCanvasBridge() {
        #expect(OpenClawCanvasA2UIAction.isTalkRealtimeActionName("talk.realtime.toggle"))
        #expect(OpenClawCanvasA2UIAction.isTalkRealtimeActionName("talk.realtime.start"))
        #expect(OpenClawCanvasA2UIAction.isTalkRealtimeActionName("talk.realtime.stop"))
        #expect(OpenClawCanvasA2UIAction.isTalkRealtimeActionName(" Talk.Realtime.Toggle "))
        #expect(!OpenClawCanvasA2UIAction.isTalkRealtimeActionName("canvas.reveal"))
    }

    @Test func jsDispatchA2UIActionStatusCanReportSetupWithoutErrorText() {
        let js = OpenClawCanvasA2UIAction.jsDispatchA2UIActionStatus(
            actionId: "live-thomas-test",
            ok: false,
            error: nil,
            state: "setup",
            message: "Dedicated realtime bridge is being prepared.")

        #expect(js.contains("\"state\":\"setup\""))
        #expect(js.contains("\"message\":\"Dedicated realtime bridge is being prepared.\""))
        #expect(js.contains("\"error\":\"\""))
    }

    @Test func formatAgentMessageIsTokenEfficientAndUnambiguous() {
        let messageContext = OpenClawCanvasA2UIAction.AgentMessageContext(
            actionName: "Get Weather",
            session: .init(key: "main", surfaceId: "main"),
            component: .init(id: "btnWeather", host: "Peter’s iPad", instanceId: "ipad16,6"),
            contextJSON: "{\"city\":\"Vienna\"}")
        let msg = OpenClawCanvasA2UIAction.formatAgentMessage(messageContext)

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
