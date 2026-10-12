import Foundation
import OpenClawIPC
import OpenClawKit
import Testing
@testable import OpenClaw

@Suite(.testWaitLimit)
@MainActor
struct MacNodePermissionTests {
    @Test(arguments: [
        OpenClawPermissionState.notDetermined, .denied, .restartRequired, .staleGrant, .disabledInOpenClaw,
    ])
    func `native commands preserve permission details without performing the operation`(
        state: OpenClawPermissionState) async
    {
        let cases: [(String, String, [Capability])] = [
            ("screen.snapshot", "{}", [.screenRecording]),
            ("screen.record", "{}", [.screenRecording]),
            ("camera.snap", "{}", [.camera]),
            ("camera.clip", #"{"includeAudio":true}"#, [.camera, .microphone]),
            ("camera.ptz.status", "{}", [.camera]),
            ("camera.ptz.control", "{}", [.camera]),
            ("location.get", "{}", [.location]),
            ("system.notify", #"{"title":"Synthetic","body":"Permission proof"}"#, [.notifications]),
            (
                "computer.act",
                #"{"action":"left_click","x":1,"y":1,"refWidth":10}"#,
                [.accessibility, .eventPosting, .screenRecording, .computerControl]),
        ]
        await TestIsolation.withUserDefaultsValues([
            cameraEnabledKey: true,
            locationModeKey: OpenClawLocationMode.whileUsing.rawValue,
        ]) {
            for (command, params, capabilities) in cases {
                let services = MacNodeRuntimeTests.MainActorServicesProbe()
                services.permissionStates = Dictionary(uniqueKeysWithValues: capabilities.map { ($0, state) })
                let runtime = MacNodeRuntime(
                    desktopAvailability: services.desktopAvailability,
                    makeMainActorServices: { services },
                    computerControlEnabled: { true },
                    computerControlProvider: { .peekaboo })
                let response = await runtime.handleInvoke(BridgeInvokeRequest(
                    id: command, command: command, paramsJSON: params))
                #expect(!response.ok)
                #expect(response.error?.code == .permissionMissing)
                #expect(response.error?.details == .init(capabilities: capabilities.map(\.rawValue), state: state))
                #expect(services.performCallCount == 0)
                #expect(services.snapshotCallCount == 0)
            }
        }
    }

    @Test func `wire error keeps permission details and does not suggest automatic retry`() throws {
        let error = try #require(PermissionManager.missingPermission([
            (.accessibility, .staleGrant), (.screenRecording, .denied), (.computerControl, .disabledInOpenClaw),
        ]))
        let data = try JSONEncoder().encode(error)
        let decoded = try JSONDecoder().decode(OpenClawNodeError.self, from: data)
        #expect(decoded == error)
        #expect(decoded.retryable == nil)
        #expect(decoded.details == .init(
            capabilities: ["accessibility", "screenRecording", "computerControl"], state: .disabledInOpenClaw))
    }
}
