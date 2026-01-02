import ClawdisKit
import Foundation
import Testing
@testable import Clawdis

@Suite(.serialized)
struct MacNodeRuntimeTests {
    @Test func handleInvokeRejectsUnknownCommand() async {
        let runtime = MacNodeRuntime()
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-1", command: "unknown.command"))
        #expect(response.ok == false)
    }

    @Test func handleInvokeRejectsEmptySystemRun() async throws {
        let runtime = MacNodeRuntime()
        let params = ClawdisSystemRunParams(command: [])
        let json = String(data: try JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-2", command: ClawdisSystemCommand.run.rawValue, paramsJSON: json))
        #expect(response.ok == false)
    }

    @Test func handleInvokeRejectsEmptyNotification() async throws {
        let runtime = MacNodeRuntime()
        let params = ClawdisSystemNotifyParams(title: "", body: "")
        let json = String(data: try JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-3", command: ClawdisSystemCommand.notify.rawValue, paramsJSON: json))
        #expect(response.ok == false)
    }

    @Test func handleInvokeCameraListRequiresEnabledCamera() async {
        let defaults = UserDefaults.standard
        let previous = defaults.object(forKey: cameraEnabledKey)
        defaults.set(false, forKey: cameraEnabledKey)
        defer {
            if let previous {
                defaults.set(previous, forKey: cameraEnabledKey)
            } else {
                defaults.removeObject(forKey: cameraEnabledKey)
            }
        }

        let runtime = MacNodeRuntime()
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-4", command: ClawdisCameraCommand.list.rawValue))
        #expect(response.ok == false)
        #expect(response.error?.message.contains("CAMERA_DISABLED") == true)
    }
}
