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

    @Test func `possible stale Accessibility still requests first-use registration`() {
        #expect(PermissionManager.accessibilityMissingState(
            .accessibilityGrantMayBeStale, requestAttempted: false) == .notDetermined)
        #expect(PermissionManager.accessibilityMissingState(
            .accessibilityGrantMayBeStale, requestAttempted: true) == .staleGrant)
        #expect(PermissionManager.accessibilityMissingState(.granted, requestAttempted: true) == nil)
    }

    @Test(arguments: [false, true])
    func `camera toggle remediation follows OpenClaw consent without an OS settings destination`(enabled: Bool) async {
        await TestIsolation.withUserDefaultsValues([cameraEnabledKey: enabled]) {
            let missing = await PermissionManager.missingPermissions([.cameraEnabled])
            #expect(missing?.details == (enabled ? nil : .init(
                capabilities: ["cameraEnabled"], state: .disabledInOpenClaw)))
            #expect(await PermissionManager.ensure([.cameraEnabled], interactive: false) == [.cameraEnabled: enabled])
            #expect(SystemSettingsURLSupport.settingsCandidates(for: .cameraEnabled).isEmpty)
        }
    }

    @Test func `an unsuccessful Event Posting request offers relaunch recovery`() {
        #expect(PermissionManager.eventPostingMissingState(granted: false, requestAttempted: false) == .notDetermined)
        #expect(PermissionManager.eventPostingMissingState(granted: false, requestAttempted: true) == .restartRequired)
        #expect(PermissionManager.eventPostingMissingState(granted: true, requestAttempted: true) == nil)
    }

    @Test func `retired permission requests do not start native authorization`() async {
        let accessibilityAttempted = PermissionManager.accessibilityRequestAttempted
        let eventPostingAttempted = PermissionManager.eventPostingRequestAttempted
        let results = await PermissionManager.ensure(
            [.accessibility, .eventPosting, .notifications, .location], interactive: true, isCurrent: { false })
        #expect(results.isEmpty)
        #expect(PermissionManager.accessibilityRequestAttempted == accessibilityAttempted)
        #expect(PermissionManager.eventPostingRequestAttempted == eventPostingAttempted)
    }

    @Test func `stale grant recovery leaves a pending screen restart for the next action`() throws {
        let first = try #require(PermissionManager.primaryRemediation([
            (.screenRecording, .restartRequired), (.accessibility, .staleGrant), (.eventPosting, .notDetermined),
        ]))
        #expect(first.state == .staleGrant)
        #expect(first.capabilities == [.accessibility])

        let afterAccessibilityGrant = try #require(PermissionManager.primaryRemediation([
            (.screenRecording, .restartRequired), (.eventPosting, .notDetermined),
        ]))
        #expect(afterAccessibilityGrant.state == .restartRequired)
        #expect(afterAccessibilityGrant.capabilities == [.screenRecording])
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
