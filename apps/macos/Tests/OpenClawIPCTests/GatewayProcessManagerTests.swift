import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct GatewayProcessManagerTests {
    private func withLocalGatewayConfig<T>(
        _ body: () async throws -> T) async throws -> T
    {
        let configPath = TestIsolation.tempConfigPath()
        try Data(#"{"gateway":{"mode":"local"}}"#.utf8)
            .write(to: URL(fileURLWithPath: configPath))
        defer { try? FileManager.default.removeItem(atPath: configPath) }
        return try await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": configPath], body)
    }

    @Test func `coalesces concurrent launch agent enable requests`() async throws {
        let port = 19081
        let marker = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-launchagent-marker-\(UUID().uuidString)")
        try await self.withLocalGatewayConfig {
            GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(marker)
            GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(true)
            GatewayLaunchAgentManager.setTestingDaemonStatusPayload(
                #"{"ok":true,"service":{"loaded":false}}"#)
            GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            defer {
                GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(nil)
                GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(false)
                GatewayLaunchAgentManager.setTestingDaemonStatusPayload(nil)
                GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            }

            let manager = GatewayProcessManager.shared
            async let first: String? = manager._testEnableLaunchAgentIfNeeded(
                bundlePath: "/Applications/OpenClaw.app",
                port: port)
            async let second: String? = manager._testEnableLaunchAgentIfNeeded(
                bundlePath: "/Applications/OpenClaw.app",
                port: port)
            _ = await (first, second)

            let calls = GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
            #expect(calls.filter { $0.first == "status" }.count == 1)
            #expect(calls.filter { $0.first == "install" }.count == 1)
        }
    }

    @Test func `queues a changed launch agent request behind an in-flight request`() async throws {
        let firstPort = 19091
        let secondPort = 19092
        let marker = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-launchagent-marker-\(UUID().uuidString)")
        try await self.withLocalGatewayConfig {
            GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(marker)
            GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(true)
            GatewayLaunchAgentManager.setTestingDaemonStatusPayload(
                #"{"ok":true,"service":{"loaded":false}}"#)
            GatewayLaunchAgentManager.setTestingDaemonCommandDelayNanoseconds(100_000_000)
            GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            defer {
                GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(nil)
                GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(false)
                GatewayLaunchAgentManager.setTestingDaemonStatusPayload(nil)
                GatewayLaunchAgentManager.setTestingDaemonCommandDelayNanoseconds(0)
                GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            }

            let manager = GatewayProcessManager.shared
            let first = Task { @MainActor in
                await manager._testEnableLaunchAgentIfNeeded(
                    bundlePath: "/Applications/OpenClaw.app",
                    port: firstPort)
            }
            for _ in 0..<100 {
                if !GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot().isEmpty {
                    break
                }
                try? await Task.sleep(nanoseconds: 1_000_000)
            }
            #expect(!GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot().isEmpty)

            let second = Task { @MainActor in
                await manager._testEnableLaunchAgentIfNeeded(
                    bundlePath: "/Applications/OpenClaw.app",
                    port: secondPort)
            }
            #expect(await first.value == nil)
            #expect(await second.value == nil)

            let calls = GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
            let installPorts = calls.compactMap { arguments -> String? in
                guard arguments.first == "install",
                      let portIndex = arguments.firstIndex(of: "--port"),
                      arguments.indices.contains(portIndex + 1)
                else {
                    return nil
                }
                return arguments[portIndex + 1]
            }
            #expect(installPorts == [String(firstPort), String(secondPort)])

            GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            let newestPort = 19093
            let stalePort = 19094
            let current = Task { @MainActor in
                await manager._testEnableLaunchAgentIfNeeded(
                    bundlePath: "/Applications/OpenClaw.app",
                    port: newestPort)
            }
            for _ in 0..<100 {
                if !GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot().isEmpty {
                    break
                }
                try? await Task.sleep(nanoseconds: 1_000_000)
            }
            let stale = Task { @MainActor in
                await manager._testEnableLaunchAgentIfNeeded(
                    bundlePath: "/Applications/OpenClaw.app",
                    port: stalePort)
            }
            await Task.yield()
            let newest = Task { @MainActor in
                await manager._testEnableLaunchAgentIfNeeded(
                    bundlePath: "/Applications/OpenClaw.app",
                    port: newestPort)
            }
            #expect(await current.value == nil)
            #expect(await stale.value == nil)
            #expect(await newest.value == nil)

            let finalInstallPorts = GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
                .compactMap { arguments -> String? in
                    guard arguments.first == "install",
                          let portIndex = arguments.firstIndex(of: "--port"),
                          arguments.indices.contains(portIndex + 1)
                    else {
                        return nil
                    }
                    return arguments[portIndex + 1]
                }
            #expect(finalInstallPorts == [String(newestPort)])
        }
    }

    @Test func `keeps a reusable launch agent running`() async throws {
        let port = 19082
        let marker = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-launchagent-marker-\(UUID().uuidString)")
        try await self.withLocalGatewayConfig {
            GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(marker)
            GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(true)
            GatewayLaunchAgentManager.setTestingDaemonStatusPayload(
                """
                {"ok":true,"service":{
                  "loaded":true,
                  "runtime":{"status":"running","pid":4242},
                  "command":{"programArguments":["openclaw","gateway","--port","\(port)"]},
                  "configAudit":{"ok":true,"issues":[]}
                }}
                """)
            GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            defer {
                GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(nil)
                GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(false)
                GatewayLaunchAgentManager.setTestingDaemonStatusPayload(nil)
                GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            }

            _ = await GatewayProcessManager.shared._testEnableLaunchAgentIfNeeded(
                bundlePath: "/Applications/OpenClaw.app",
                port: port)

            let calls = GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
            #expect(calls.filter { $0.first == "status" }.count == 1)
            #expect(calls.allSatisfy { $0.first != "install" })
        }
    }

    @Test func `repairs loaded launch agents that are not reusable`() async throws {
        let port = 19083
        let marker = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-launchagent-marker-\(UUID().uuidString)")
        try await self.withLocalGatewayConfig {
            GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(marker)
            GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(true)
            defer {
                GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(nil)
                GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(false)
                GatewayLaunchAgentManager.setTestingDaemonStatusPayload(nil)
                GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            }

            let staleStatuses = [
                """
                {"ok":true,"service":{
                  "loaded":true,
                  "runtime":{"status":"stopped"},
                  "command":{"programArguments":["openclaw","gateway","--port","\(port)"]},
                  "configAudit":{"ok":true,"issues":[]}
                }}
                """,
                """
                {"ok":true,"service":{
                  "loaded":true,
                  "runtime":{"status":"running","pid":4242},
                  "command":{"programArguments":["openclaw","gateway","--port","19084"]},
                  "configAudit":{"ok":true,"issues":[]}
                }}
                """,
                """
                {"ok":true,"service":{
                  "loaded":true,
                  "runtime":{"status":"running","pid":4242},
                  "command":{"programArguments":["openclaw","gateway","--port","\(port)"]},
                  "configAudit":{"ok":false,"issues":[{"code":"gateway-service-version-mismatch"}]}
                }}
                """,
            ]

            for status in staleStatuses {
                GatewayLaunchAgentManager.setTestingDaemonStatusPayload(status)
                GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()

                _ = await GatewayProcessManager.shared._testEnableLaunchAgentIfNeeded(
                    bundlePath: "/Applications/OpenClaw.app",
                    port: port)

                let calls = GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
                #expect(calls.filter { $0.first == "status" }.count == 1)
                #expect(calls.filter { $0.first == "install" }.count == 1)
            }
        }
    }

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
        }

        let ready = await manager.waitForGatewayReady(timeout: 0.5)
        #expect(ready)
        #expect(manager.lastFailureReason == nil)
    }

    @Test func `attaches to existing gateway without spawning launchd`() async throws {
        let port = 19097
        do {
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
                await PortGuardian.shared.setTestingDescriptor(nil, forPort: port)
            }

            do {
                let attached = await manager._testAttachExistingGatewayIfAvailable(port: port)
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
}
