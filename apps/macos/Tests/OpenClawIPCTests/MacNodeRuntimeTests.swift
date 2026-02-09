import EasyHubKit
import CoreLocation
import Foundation
import Testing
@testable import EasyHub

struct MacNodeRuntimeTests {
    @Test func handleInvokeRejectsUnknownCommand() async {
        let runtime = MacNodeRuntime()
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-1", command: "unknown.command"))
        #expect(response.ok == false)
    }

    @Test func handleInvokeRejectsEmptySystemRun() async throws {
        let runtime = MacNodeRuntime()
        let params = EasyHubSystemRunParams(command: [])
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-2", command: EasyHubSystemCommand.run.rawValue, paramsJSON: json))
        #expect(response.ok == false)
    }

    @Test func handleInvokeRejectsEmptySystemWhich() async throws {
        let runtime = MacNodeRuntime()
        let params = EasyHubSystemWhichParams(bins: [])
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-2b", command: EasyHubSystemCommand.which.rawValue, paramsJSON: json))
        #expect(response.ok == false)
    }

    @Test func handleInvokeRejectsEmptyNotification() async throws {
        let runtime = MacNodeRuntime()
        let params = EasyHubSystemNotifyParams(title: "", body: "")
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-3", command: EasyHubSystemCommand.notify.rawValue, paramsJSON: json))
        #expect(response.ok == false)
    }

    @Test func handleInvokeCameraListRequiresEnabledCamera() async {
        await TestIsolation.withUserDefaultsValues([cameraEnabledKey: false]) {
            let runtime = MacNodeRuntime()
            let response = await runtime.handleInvoke(
                BridgeInvokeRequest(id: "req-4", command: EasyHubCameraCommand.list.rawValue))
            #expect(response.ok == false)
            #expect(response.error?.message.contains("CAMERA_DISABLED") == true)
        }
    }

    @Test func handleInvokeScreenRecordUsesInjectedServices() async throws {
        @MainActor
        final class FakeMainActorServices: MacNodeRuntimeMainActorServices, @unchecked Sendable {
            func recordScreen(
                screenIndex: Int?,
                durationMs: Int?,
                fps: Double?,
                includeAudio: Bool?,
                outPath: String?) async throws -> (path: String, hasAudio: Bool)
            {
                let url = FileManager().temporaryDirectory
                    .appendingPathComponent("EasyHub-test-screen-record-\(UUID().uuidString).mp4")
                try Data("ok".utf8).write(to: url)
                return (path: url.path, hasAudio: false)
            }

            func locationAuthorizationStatus() -> CLAuthorizationStatus { .authorizedAlways }
            func locationAccuracyAuthorization() -> CLAccuracyAuthorization { .fullAccuracy }
            func currentLocation(
                desiredAccuracy: EasyHubLocationAccuracy,
                maxAgeMs: Int?,
                timeoutMs: Int?) async throws -> CLLocation
            {
                CLLocation(latitude: 0, longitude: 0)
            }
        }

        let services = await MainActor.run { FakeMainActorServices() }
        let runtime = MacNodeRuntime(makeMainActorServices: { services })

        let params = MacNodeScreenRecordParams(durationMs: 250)
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-5", command: MacNodeScreenCommand.record.rawValue, paramsJSON: json))
        #expect(response.ok == true)
        let payloadJSON = try #require(response.payloadJSON)

        struct Payload: Decodable {
            var format: String
            var base64: String
        }
        let payload = try JSONDecoder().decode(Payload.self, from: Data(payloadJSON.utf8))
        #expect(payload.format == "mp4")
        #expect(!payload.base64.isEmpty)
    }
}
