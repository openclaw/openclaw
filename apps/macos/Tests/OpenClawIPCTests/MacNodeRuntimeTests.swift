import CoreLocation
import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

struct MacNodeRuntimeTests {
    @Test func `handle invoke rejects unknown command`() async {
        let runtime = MacNodeRuntime()
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-1", command: "unknown.command"))
        #expect(response.ok == false)
    }

    @Test func `handle invoke rejects empty system run`() async throws {
        let runtime = MacNodeRuntime()
        let params = OpenClawSystemRunParams(command: [])
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-2", command: OpenClawSystemCommand.run.rawValue, paramsJSON: json))
        #expect(response.ok == false)
    }

    @Test func `handle invoke prepares system run payload`() async throws {
        struct PrepareParams: Encodable {
            var command: [String]
            var cwd: String?
            var agentId: String?
            var sessionKey: String?
        }

        struct PreparePayload: Decodable {
            struct Plan: Decodable {
                var argv: [String]
                var cwd: String?
                var rawCommand: String?
                var agentId: String?
                var sessionKey: String?
            }

            var cmdText: String
            var plan: Plan
        }

        let runtime = MacNodeRuntime()
        let params = PrepareParams(
            command: ["echo", "hello"],
            cwd: "  /tmp  ",
            agentId: "  agent-1  ",
            sessionKey: "  main  ")
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-prepare", command: OpenClawSystemCommand.runPrepare.rawValue, paramsJSON: json))
        #expect(response.ok == true)
        let payloadJSON = try #require(response.payloadJSON)
        let payload = try JSONDecoder().decode(PreparePayload.self, from: Data(payloadJSON.utf8))
        #expect(payload.cmdText == "echo hello")
        #expect(payload.plan.argv == ["echo", "hello"])
        #expect(payload.plan.cwd == "/tmp")
        #expect(payload.plan.rawCommand == "echo hello")
        #expect(payload.plan.agentId == "agent-1")
        #expect(payload.plan.sessionKey == "main")
    }

    @Test func `handle invoke rejects missing or empty system run prepare command`() async throws {
        struct PrepareParams: Encodable {
            var command: [String]?
        }

        let runtime = MacNodeRuntime()
        let payloads = [
            "{}",
            try #require(String(data: JSONEncoder().encode(PrepareParams(command: [])), encoding: .utf8)),
        ]

        for (index, paramsJSON) in payloads.enumerated() {
            let response = await runtime.handleInvoke(
                BridgeInvokeRequest(
                    id: "req-prepare-empty-\(index)",
                    command: OpenClawSystemCommand.runPrepare.rawValue,
                    paramsJSON: paramsJSON))
            #expect(response.ok == false)
            #expect(response.error?.message == "command required")
        }
    }

    @Test func `handle invoke rejects mismatched system run prepare raw command`() async throws {
        struct PrepareParams: Encodable {
            var command: [String]
            var rawCommand: String?
        }

        let runtime = MacNodeRuntime()
        let params = PrepareParams(command: ["echo", "hello"], rawCommand: "echo world")
        let json = try #require(String(data: JSONEncoder().encode(params), encoding: .utf8))
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(
                id: "req-prepare-raw-mismatch",
                command: OpenClawSystemCommand.runPrepare.rawValue,
                paramsJSON: json))
        #expect(response.ok == false)
        #expect(response.error?.message == "INVALID_REQUEST: rawCommand does not match command")
    }

    @Test func `handle invoke rejects empty system which`() async throws {
        let runtime = MacNodeRuntime()
        let params = OpenClawSystemWhichParams(bins: [])
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-2b", command: OpenClawSystemCommand.which.rawValue, paramsJSON: json))
        #expect(response.ok == false)
    }

    @Test func `handle invoke rejects empty notification`() async throws {
        let runtime = MacNodeRuntime()
        let params = OpenClawSystemNotifyParams(title: "", body: "")
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-3", command: OpenClawSystemCommand.notify.rawValue, paramsJSON: json))
        #expect(response.ok == false)
    }

    @Test func `handle invoke camera list requires enabled camera`() async {
        await TestIsolation.withUserDefaultsValues([cameraEnabledKey: false]) {
            let runtime = MacNodeRuntime()
            let response = await runtime.handleInvoke(
                BridgeInvokeRequest(id: "req-4", command: OpenClawCameraCommand.list.rawValue))
            #expect(response.ok == false)
            #expect(response.error?.message.contains("CAMERA_DISABLED") == true)
        }
    }

    @Test func `handle invoke screen record uses injected services`() async throws {
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
                    .appendingPathComponent("openclaw-test-screen-record-\(UUID().uuidString).mp4")
                try Data("ok".utf8).write(to: url)
                return (path: url.path, hasAudio: false)
            }

            func locationAuthorizationStatus() -> CLAuthorizationStatus {
                .authorizedAlways
            }

            func locationAccuracyAuthorization() -> CLAccuracyAuthorization {
                .fullAccuracy
            }

            func currentLocation(
                desiredAccuracy: OpenClawLocationAccuracy,
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

    @Test func `handle invoke browser proxy uses injected request`() async {
        let runtime = MacNodeRuntime(browserProxyRequest: { paramsJSON in
            #expect(paramsJSON?.contains("/tabs") == true)
            return #"{"result":{"ok":true,"tabs":[{"id":"tab-1"}]}}"#
        })
        let paramsJSON = #"{"method":"GET","path":"/tabs","timeoutMs":2500}"#
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(
                id: "req-browser",
                command: OpenClawBrowserCommand.proxy.rawValue,
                paramsJSON: paramsJSON))

        #expect(response.ok == true)
        #expect(response.payloadJSON == #"{"result":{"ok":true,"tabs":[{"id":"tab-1"}]}}"#)
    }

    @Test func `handle invoke browser proxy rejects disabled browser control`() async throws {
        let override = TestIsolation.tempConfigPath()
        try await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": override]) {
            try JSONSerialization.data(withJSONObject: ["browser": ["enabled": false]])
                .write(to: URL(fileURLWithPath: override))

            let runtime = MacNodeRuntime(browserProxyRequest: { _ in
                Issue.record("browserProxyRequest should not run when browser control is disabled")
                return "{}"
            })
            let response = await runtime.handleInvoke(
                BridgeInvokeRequest(
                    id: "req-browser-disabled",
                    command: OpenClawBrowserCommand.proxy.rawValue,
                    paramsJSON: #"{"method":"GET","path":"/tabs"}"#))

            #expect(response.ok == false)
            #expect(response.error?.message.contains("BROWSER_DISABLED") == true)
        }
    }
}
