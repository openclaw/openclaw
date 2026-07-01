import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct GatewayProcessManagerTests {
    @Test func `clears last failure when health succeeds`() async throws {
        let session = GatewayTestWebSocketSession(
            taskFactory: {
                GatewayTestWebSocketTask(
                    sendHook: { task, message, sendIndex in
                        guard sendIndex > 0 else { return }
                        guard let id = GatewayWebSocketTestSupport.requestID(from: message) else { return }
                        task.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
                    })
            })
        let url = try #require(URL(string: "ws://example.invalid"))
        let connection = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))

        let manager = GatewayProcessManager.shared
        manager.setTestingConnection(connection)
        manager.setTestingDesiredActive(true)
        manager.setTestingLastFailureReason("health failed")
        defer {
            manager.setTestingConnection(nil)
            manager.setTestingDesiredActive(false)
            manager.setTestingLastFailureReason(nil)
            manager.setTestingStatus(.stopped)
        }

        let ready = await manager.waitForGatewayReady(timeout: 0.5)
        #expect(ready)
        #expect(manager.lastFailureReason == nil)
    }

    @Test func `attaches to existing gateway without spawning launchd`() async throws {
        let port = 19097
        try await TestIsolation.withEnvValues(["OPENCLAW_GATEWAY_PORT": "\(port)"]) {
            let healthData = Data(
                """
                {
                  "ok": true,
                  "ts": 1,
                  "durationMs": 0,
                  "channels": {
                    "telegram": {
                      "configured": true,
                      "linked": true,
                      "authAgeMs": 60000
                    }
                  },
                  "channelOrder": ["telegram"],
                  "channelLabels": {
                    "telegram": "Telegram"
                  },
                  "heartbeatSeconds": 30,
                  "sessions": {
                    "path": "/tmp/sessions",
                    "count": 1,
                    "recent": []
                  }
                }
                """.utf8)
            let session = GatewayTestWebSocketSession(
                taskFactory: {
                    GatewayTestWebSocketTask(
                        sendHook: { task, message, sendIndex in
                            guard sendIndex > 0 else { return }
                            guard let id = GatewayWebSocketTestSupport.requestID(from: message) else { return }
                            let json = """
                            {
                              "type": "res",
                              "id": "\(id)",
                              "ok": true,
                              "payload": \(String(decoding: healthData, as: UTF8.self))
                            }
                            """
                            task.emitReceiveSuccess(.data(Data(json.utf8)))
                        })
                })
            let url = try #require(URL(string: "ws://example.invalid"))
            let connection = GatewayConnection(
                configProvider: { (url: url, token: nil, password: nil) },
                sessionBox: WebSocketSessionBox(session: session))
            let descriptor = PortGuardian.Descriptor(
                pid: 4242,
                command: "openclaw-gateway",
                executablePath: "/tmp/openclaw-gateway")

            let manager = GatewayProcessManager.shared
            await PortGuardian.shared.setTestingDescriptor(descriptor, forPort: port)
            manager.setTestingConnection(connection)
            manager.setTestingSkipControlChannelRefresh(true)
            manager.setTestingLastFailureReason("stale")

            @MainActor
            func cleanup() async {
                manager.setTestingConnection(nil)
                manager.setTestingSkipControlChannelRefresh(false)
                manager.setTestingDesiredActive(false)
                manager.setTestingLastFailureReason(nil)
                manager.setTestingStatus(.stopped)
                await PortGuardian.shared.setTestingDescriptor(nil, forPort: port)
            }

            do {
                let attached = await manager._testAttachExistingGatewayIfAvailable()
                #expect(attached)
                #expect(manager.lastFailureReason == nil)
                guard case let .attachedExisting(statusDetails) = manager.status else {
                    Issue.record("expected attachedExisting status")
                    await cleanup()
                    return
                }
                let details = try #require(statusDetails)
                #expect(details.contains("port \(port)"))
                #expect(details.contains("Telegram linked"))
                #expect(details.contains("auth 1m"))
                #expect(details.contains("pid 4242 openclaw-gateway @ /tmp/openclaw-gateway"))
                await cleanup()
            } catch {
                await cleanup()
                throw error
            }
        }
    }

    @Test func `start ensures launch agent after attaching existing gateway`() async throws {
        let port = 19098
        try await TestIsolation.withEnvValues(["OPENCLAW_GATEWAY_PORT": "\(port)"]) {
            let healthData = Data(
                """
                {
                  "ok": true,
                  "ts": 1,
                  "durationMs": 0,
                  "channels": {},
                  "channelOrder": [],
                  "channelLabels": {},
                  "heartbeatSeconds": 30,
                  "sessions": {
                    "path": "/tmp/sessions",
                    "count": 0,
                    "recent": []
                  }
                }
                """.utf8)
            let session = GatewayTestWebSocketSession(
                taskFactory: {
                    GatewayTestWebSocketTask(
                        sendHook: { task, message, sendIndex in
                            guard sendIndex > 0 else { return }
                            guard let id = GatewayWebSocketTestSupport.requestID(from: message) else { return }
                            let json = """
                            {
                              "type": "res",
                              "id": "\(id)",
                              "ok": true,
                              "payload": \(String(decoding: healthData, as: UTF8.self))
                            }
                            """
                            task.emitReceiveSuccess(.data(Data(json.utf8)))
                        })
                })
            let url = try #require(URL(string: "ws://example.invalid"))
            let connection = GatewayConnection(
                configProvider: { (url: url, token: nil, password: nil) },
                sessionBox: WebSocketSessionBox(session: session))
            let descriptor = PortGuardian.Descriptor(
                pid: 4243,
                command: "openclaw-gateway",
                executablePath: "/tmp/openclaw-gateway")

            let manager = GatewayProcessManager.shared
            await PortGuardian.shared.setTestingDescriptor(descriptor, forPort: port)
            GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(true)
            GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            manager.setTestingStatus(.stopped)
            manager.setTestingConnection(connection)
            manager.setTestingSkipControlChannelRefresh(true)
            manager.setTestingDesiredActive(true)

            @MainActor
            func cleanup() async {
                manager.setTestingConnection(nil)
                manager.setTestingSkipControlChannelRefresh(false)
                manager.setTestingDesiredActive(false)
                manager.setTestingStatus(.stopped)
                GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(false)
                GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
                await PortGuardian.shared.setTestingDescriptor(nil, forPort: port)
            }

            manager.startIfNeeded()
            let calls = await self.waitForLaunchdInstallCall()
            let installCalls = calls.filter { $0.first == "install" }

            #expect(installCalls.count == 1)
            #expect(calls.contains { $0.first == "status" })
            guard case .attachedExisting = manager.status else {
                Issue.record("expected attachedExisting status")
                await cleanup()
                return
            }
            await cleanup()
        }
    }

    private func waitForLaunchdInstallCall(timeout: TimeInterval = 1) async -> [[String]] {
        let deadline = Date().addingTimeInterval(timeout)
        var calls = GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
        while !calls.contains(where: { $0.first == "install" }), Date() < deadline {
            try? await Task.sleep(nanoseconds: 20_000_000)
            calls = GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
        }
        return calls
    }
}
