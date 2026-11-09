import OpenClawKit
import Testing
@testable import OpenClaw

@Suite(.testWaitLimit)
struct MacNodeNotifyMalformedParamsTests {
    @Test(arguments: [
        nil,
        "{",
        "{}",
        #"{"title":7,"body":"Synthetic body"}"#,
        #"{"title":"Synthetic title","body":"Synthetic body","priority":"urgent"}"#,
        #"{"title":"Synthetic title","body":"Synthetic body","delivery":"invalid"}"#,
    ] as [String?])
    func rejectsMalformedParams(_ paramsJSON: String?) async {
        let runtime = self.makeRuntime()
        let response = await runtime.handleInvoke(BridgeInvokeRequest(
            id: "notify-malformed", command: "system.notify", paramsJSON: paramsJSON))

        #expect(response.id == "notify-malformed")
        #expect(!response.ok)
        #expect(response.payloadJSON == nil)
        #expect(response.error?.code == .invalidRequest)
        #expect(response.error?.message == "INVALID_REQUEST: invalid system.notify params")
    }

    @Test(arguments: [nil, "{", "{}"] as [String?])
    func rejectsMalformedCanvasNavigateParams(_ paramsJSON: String?) async {
        let runtime = self.makeRuntime()
        let response = await runtime.handleInvoke(BridgeInvokeRequest(
            id: "canvas-navigate-malformed", command: "canvas.navigate", paramsJSON: paramsJSON))

        #expect(response.id == "canvas-navigate-malformed")
        #expect(!response.ok)
        #expect(response.payloadJSON == nil)
        #expect(response.error?.code == .invalidRequest)
        #expect(response.error?.message == "INVALID_REQUEST: invalid canvas.navigate params")
    }

    @Test func preservesEmptyNotificationValidation() async {
        let runtime = self.makeRuntime()
        let response = await runtime.handleInvoke(BridgeInvokeRequest(
            id: "notify-empty",
            command: "system.notify",
            paramsJSON: #"{"title":"  ","body":"\n"}"#))

        #expect(!response.ok)
        #expect(response.error?.code == .invalidRequest)
        #expect(response.error?.message == "INVALID_REQUEST: empty notification")
    }

    private func makeRuntime() -> MacNodeRuntime {
        MacNodeRuntime(makeMainActorServices: {
            // Fail closed rather than constructing live permissions, location, or screen services.
            fatalError("Invalid command input must not initialize native services")
        })
    }
}
