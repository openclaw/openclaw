import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct GatewayProcessManagerTests {
    private func withGatewayConfig<T>(
        mode: String,
        _ body: () async throws -> T) async throws -> T
    {
        let configPath = TestIsolation.tempConfigPath()
        try Data(#"{"gateway":{"mode":"\#(mode)"}}"#.utf8)
            .write(to: URL(fileURLWithPath: configPath))
        defer { try? FileManager.default.removeItem(atPath: configPath) }
        return try await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": configPath], body)
    }

    private func withLocalGatewayConfig<T>(
        _ body: () async throws -> T) async throws -> T
    {
        try await self.withGatewayConfig(mode: "local", body)
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
            for _ in 0..<100 {
                if manager._testPendingLaunchAgentPort() == stalePort {
                    break
                }
                try? await Task.sleep(nanoseconds: 1_000_000)
            }
            #expect(manager._testPendingLaunchAgentPort() == stalePort)
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

    @Test func `stop discards queued enables and disables after the active request`() async throws {
        let firstPort = 19095
        let secondPort = 19096
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
                GatewayProcessManager.shared.setTestingDesiredActive(false)
            }

            let manager = GatewayProcessManager.shared
            manager.setTestingDesiredActive(true)
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
            let second = Task { @MainActor in
                await manager._testEnableLaunchAgentIfNeeded(
                    bundlePath: "/Applications/OpenClaw.app",
                    port: secondPort)
            }
            for _ in 0..<100 {
                if manager._testPendingLaunchAgentPort() == secondPort {
                    break
                }
                try? await Task.sleep(nanoseconds: 1_000_000)
            }
            #expect(manager._testPendingLaunchAgentPort() == secondPort)

            manager.stop()
            _ = await (first.value, second.value)
            try? await Task.sleep(nanoseconds: 150_000_000)

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
            #expect(installPorts == [String(firstPort)])
            #expect(calls.filter { $0.first == "uninstall" }.count == 1)
            #expect(manager._testPendingLaunchAgentPort() == nil)
            #expect(manager.status == .stopped)
        }
    }

    @Test func `restart waits for an in-progress disable`() async throws {
        let port = 19098
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
                GatewayProcessManager.shared.setTestingDesiredActive(false)
            }

            let manager = GatewayProcessManager.shared
            manager.setTestingDesiredActive(true)
            manager.stop()
            for _ in 0..<100 {
                if GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
                    .contains(where: { $0.first == "uninstall" })
                {
                    break
                }
                try? await Task.sleep(nanoseconds: 1_000_000)
            }
            #expect(GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
                .contains(where: { $0.first == "uninstall" }))

            manager._testBeginGatewayStartGeneration()
            _ = await manager._testEnableLaunchAgentIfNeeded(
                bundlePath: "/Applications/OpenClaw.app",
                port: port)

            let calls = GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
            #expect(calls.map(\.first) == ["uninstall", "status", "install"])
        }
    }

    @Test func `restart waits for disable before attaching`() async throws {
        let port = 19099
        let marker = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-launchagent-marker-\(UUID().uuidString)")
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
        let descriptor = PortGuardian.Descriptor(
            pid: 4242,
            command: "openclaw-gateway",
            executablePath: "/tmp/openclaw-gateway")

        try await self.withLocalGatewayConfig {
            GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(marker)
            GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(true)
            GatewayLaunchAgentManager.setTestingDaemonCommandDelayNanoseconds(100_000_000)
            GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            let manager = GatewayProcessManager.shared
            manager.setTestingConnection(connection)
            manager.setTestingSkipControlChannelRefresh(true)
            manager.setTestingDesiredActive(true)
            await PortGuardian.shared.setTestingDescriptor(descriptor, forPort: port)
            defer {
                GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(nil)
                GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(false)
                GatewayLaunchAgentManager.setTestingDaemonCommandDelayNanoseconds(0)
                GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
                manager.setTestingConnection(nil)
                manager.setTestingSkipControlChannelRefresh(false)
                manager.setTestingDesiredActive(false)
            }

            manager.stop()
            for _ in 0..<100 {
                if GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
                    .contains(where: { $0.first == "uninstall" })
                {
                    break
                }
                try? await Task.sleep(nanoseconds: 1_000_000)
            }
            manager._testBeginGatewayStartGeneration()

            let startedAt = Date()
            let attached = await manager._testAttachExistingGatewayAfterPendingDisable(port: port)
            let elapsed = Date().timeIntervalSince(startedAt)

            #expect(attached)
            #expect(elapsed >= 0.05)
            #expect(GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
                .filter { $0.first == "uninstall" }.count == 1)
            guard case .attachedExisting = manager.status else {
                Issue.record("expected attachedExisting status")
                await PortGuardian.shared.setTestingDescriptor(nil, forPort: port)
                await connection.shutdown()
                return
            }
            await PortGuardian.shared.setTestingDescriptor(nil, forPort: port)
            await connection.shutdown()
        }
    }

    @Test func `remote mode still removes the local launch agent`() async throws {
        let marker = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-launchagent-marker-\(UUID().uuidString)")
        try await self.withGatewayConfig(mode: "remote") {
            GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(marker)
            GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(true)
            GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            defer {
                GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(nil)
                GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(false)
                GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
                GatewayProcessManager.shared.setTestingDesiredActive(false)
            }

            let manager = GatewayProcessManager.shared
            manager.setTestingDesiredActive(true)
            manager.stop()
            for _ in 0..<100 {
                if GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
                    .contains(where: { $0.first == "uninstall" })
                {
                    break
                }
                try? await Task.sleep(nanoseconds: 1_000_000)
            }

            let calls = GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
            #expect(calls.filter { $0.first == "uninstall" }.count == 1)
            #expect(manager.status == .stopped)
        }
    }

    @Test func `inactive lifecycle skips persistence ensure`() async throws {
        let marker = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-launchagent-marker-\(UUID().uuidString)")
        try await self.withLocalGatewayConfig {
            GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(marker)
            GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(true)
            GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            defer {
                GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(nil)
                GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(false)
                GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            }

            let manager = GatewayProcessManager.shared
            manager.setTestingDesiredActive(false)
            await manager.ensureLaunchAgentEnabledIfNeeded()

            #expect(GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot().isEmpty)
        }
    }

    @Test func `newer inactive lifecycle retains the pending disable`() async throws {
        let marker = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-launchagent-marker-\(UUID().uuidString)")
        try await self.withLocalGatewayConfig {
            GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(marker)
            GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(true)
            GatewayLaunchAgentManager.setTestingDaemonCommandDelayNanoseconds(100_000_000)
            GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            defer {
                GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(nil)
                GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(false)
                GatewayLaunchAgentManager.setTestingDaemonCommandDelayNanoseconds(0)
                GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
                GatewayProcessManager.shared.setTestingDesiredActive(false)
            }

            let manager = GatewayProcessManager.shared
            manager.setTestingDesiredActive(true)
            manager.stop()
            manager.stop()
            for _ in 0..<200 {
                if GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
                    .contains(where: { $0.first == "uninstall" })
                {
                    break
                }
                try? await Task.sleep(nanoseconds: 1_000_000)
            }
            try? await Task.sleep(nanoseconds: 150_000_000)

            let calls = GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
            #expect(calls.filter { $0.first == "uninstall" }.count == 1)
            #expect(manager.status == .stopped)
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
                GatewayProcessManager.shared._testClearLaunchAgentReadinessFailure()
            }

            _ = await GatewayProcessManager.shared._testEnableLaunchAgentIfNeeded(
                bundlePath: "/Applications/OpenClaw.app",
                port: port)

            let calls = GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
            #expect(calls.filter { $0.first == "status" }.count == 1)
            #expect(calls.allSatisfy { $0.first != "install" })
        }
    }

    @Test func `repairs only a stable launch agent PID after readiness fails`() async throws {
        let port = 19085
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
                GatewayProcessManager.shared._testClearLaunchAgentReadinessFailure()
            }

            let manager = GatewayProcessManager.shared
            _ = await manager._testEnableLaunchAgentIfNeeded(
                bundlePath: "/Applications/OpenClaw.app",
                port: port)
            var calls = GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
            #expect(calls.filter { $0.first == "install" }.isEmpty)

            GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            await manager._testRecordLaunchAgentReadinessFailure(port: port, startingPID: 4242)
            GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()

            _ = await manager._testEnableLaunchAgentIfNeeded(
                bundlePath: "/Applications/OpenClaw.app",
                port: port)

            calls = GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
            #expect(calls.filter { $0.first == "status" }.count == 1)
            #expect(calls.filter { $0.first == "install" }.count == 1)
        }
    }

    @Test func `gives a replacement launch agent PID a full readiness cycle`() async throws {
        let port = 19086
        let marker = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-launchagent-marker-\(UUID().uuidString)")
        try await self.withLocalGatewayConfig {
            GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(marker)
            GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(true)
            GatewayLaunchAgentManager.setTestingDaemonStatusPayload(
                """
                {"ok":true,"service":{
                  "loaded":true,
                  "runtime":{"status":"running","pid":4243},
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
                GatewayProcessManager.shared._testClearLaunchAgentReadinessFailure()
            }

            let manager = GatewayProcessManager.shared
            await manager._testRecordLaunchAgentReadinessFailure(port: port, startingPID: 4242)
            GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()

            _ = await manager._testEnableLaunchAgentIfNeeded(
                bundlePath: "/Applications/OpenClaw.app",
                port: port)

            let calls = GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
            #expect(calls.filter { $0.first == "status" }.count == 1)
            #expect(calls.filter { $0.first == "install" }.isEmpty)
        }
    }

    @Test func `stop wins while a readiness failure audit is pending`() async throws {
        let port = 19089
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
            GatewayLaunchAgentManager.setTestingDaemonCommandDelayNanoseconds(100_000_000)
            GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            defer {
                GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(nil)
                GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(false)
                GatewayLaunchAgentManager.setTestingDaemonStatusPayload(nil)
                GatewayLaunchAgentManager.setTestingDaemonCommandDelayNanoseconds(0)
                GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
                GatewayProcessManager.shared.setTestingDesiredActive(false)
                GatewayProcessManager.shared._testClearLaunchAgentReadinessFailure()
            }

            let manager = GatewayProcessManager.shared
            manager.setTestingDesiredActive(true)
            let finish = Task { @MainActor in
                await manager._testFinishLaunchAgentReadinessFailure(
                    port: port,
                    startingPID: 4242)
            }
            for _ in 0..<100 {
                if GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
                    .contains(where: { $0.first == "status" })
                {
                    break
                }
                try? await Task.sleep(nanoseconds: 1_000_000)
            }
            #expect(GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
                .contains(where: { $0.first == "status" }))

            manager.stop()
            await finish.value
            try? await Task.sleep(nanoseconds: 150_000_000)

            #expect(manager.status == .stopped)
            #expect(!manager._testHasLaunchAgentReadinessFailure())
        }
    }

    @Test func `stale readiness audit cannot clear a restarted generation`() async throws {
        let port = 19090
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
            GatewayLaunchAgentManager.setTestingDaemonCommandDelayNanoseconds(200_000_000)
            GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            defer {
                GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(nil)
                GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(false)
                GatewayLaunchAgentManager.setTestingDaemonStatusPayload(nil)
                GatewayLaunchAgentManager.setTestingDaemonCommandDelayNanoseconds(0)
                GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
                GatewayProcessManager.shared.setTestingDesiredActive(false)
                GatewayProcessManager.shared._testClearLaunchAgentReadinessFailure()
            }

            let manager = GatewayProcessManager.shared
            manager.setTestingDesiredActive(true)
            let staleFinish = Task { @MainActor in
                await manager._testFinishLaunchAgentReadinessFailure(
                    port: port,
                    startingPID: 4242)
            }
            for _ in 0..<100 {
                if GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
                    .contains(where: { $0.first == "status" })
                {
                    break
                }
                try? await Task.sleep(nanoseconds: 1_000_000)
            }
            #expect(GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
                .contains(where: { $0.first == "status" }))

            GatewayLaunchAgentManager.setTestingDaemonCommandDelayNanoseconds(0)
            manager.stop()
            manager._testBeginGatewayStartGeneration()
            await manager._testFinishLaunchAgentReadinessFailure(
                port: port,
                startingPID: 4242)
            #expect(manager._testHasLaunchAgentReadinessFailure())

            await staleFinish.value

            #expect(manager.status == .failed("Gateway did not start in time"))
            #expect(manager._testHasLaunchAgentReadinessFailure())
        }
    }

    @Test func `repairs a stable launch agent PID with a wedged listener`() async throws {
        let port = 19087
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
                GatewayProcessManager.shared._testClearLaunchAgentReadinessFailure()
            }

            let manager = GatewayProcessManager.shared
            let listener = PortGuardian.Descriptor(
                pid: 4242,
                command: "openclaw-gateway",
                executablePath: "/tmp/openclaw-gateway")
            await PortGuardian.shared.setTestingDescriptor(listener, forPort: port)
            await manager._testRecordLaunchAgentReadinessFailure(port: port, startingPID: 4242)
            GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()

            _ = await manager._testEnableLaunchAgentIfNeeded(
                bundlePath: "/Applications/OpenClaw.app",
                port: port)

            let calls = GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
            #expect(calls.filter { $0.first == "status" }.count == 1)
            #expect(calls.filter { $0.first == "install" }.count == 1)
            await PortGuardian.shared.setTestingDescriptor(nil, forPort: port)
        }
    }

    @Test func `protects a foreign listener after launch agent readiness fails`() async throws {
        let port = 19088
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
                GatewayProcessManager.shared._testClearLaunchAgentReadinessFailure()
            }

            let manager = GatewayProcessManager.shared
            await manager._testRecordLaunchAgentReadinessFailure(port: port, startingPID: 4242)
            let listener = PortGuardian.Descriptor(
                pid: 4243,
                command: "foreign-listener",
                executablePath: "/tmp/foreign-listener")
            await PortGuardian.shared.setTestingDescriptor(listener, forPort: port)
            GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()

            _ = await manager._testEnableLaunchAgentIfNeeded(
                bundlePath: "/Applications/OpenClaw.app",
                port: port)

            let calls = GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
            #expect(calls.filter { $0.first == "status" }.count == 1)
            #expect(calls.filter { $0.first == "install" }.isEmpty)
            await PortGuardian.shared.setTestingDescriptor(nil, forPort: port)
        }
    }

    @Test func `protects an unmanaged listener during persistence ensure`() async throws {
        let port = 19100
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

            let listener = PortGuardian.Descriptor(
                pid: 4243,
                command: "manual-gateway",
                executablePath: "/tmp/manual-gateway")
            await PortGuardian.shared.setTestingDescriptor(listener, forPort: port)

            _ = await GatewayProcessManager.shared._testEnableLaunchAgentIfNeeded(
                bundlePath: "/Applications/OpenClaw.app",
                port: port)

            let calls = GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
            #expect(calls.filter { $0.first == "status" }.count == 2)
            #expect(calls.filter { $0.first == "install" }.isEmpty)
            await PortGuardian.shared.setTestingDescriptor(nil, forPort: port)
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
        manager._testSetLaunchAgentReadinessFailure(port: 19101, pid: 4242)
        defer {
            manager.setTestingConnection(nil)
            manager.setTestingDesiredActive(false)
            manager.setTestingLastFailureReason(nil)
            manager._testClearLaunchAgentReadinessFailure()
        }

        let ready = await manager.waitForGatewayReady(timeout: 0.5)
        #expect(ready)
        #expect(manager.lastFailureReason == nil)
        #expect(!manager._testHasLaunchAgentReadinessFailure())
    }

    @Test func `stale readiness wait cannot clear a newer launch failure`() async throws {
        let session = GatewayTestWebSocketSession(
            taskFactory: {
                GatewayTestWebSocketTask(
                    sendHook: { task, message, sendIndex in
                        guard sendIndex > 0 else { return }
                        guard let id = GatewayWebSocketTestSupport.requestID(from: message) else { return }
                        task.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
                    },
                    receiveHook: { _, receiveIndex in
                        if receiveIndex == 0 {
                            try await Task.sleep(nanoseconds: 100_000_000)
                        }
                        return .data(GatewayWebSocketTestSupport.connectChallengeData())
                    })
            })
        let url = try #require(URL(string: "ws://example.invalid"))
        let connection = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))

        let manager = GatewayProcessManager.shared
        manager.setTestingConnection(connection)
        manager._testBeginGatewayStartGeneration()
        defer {
            manager.setTestingConnection(nil)
            manager.setTestingDesiredActive(false)
            manager._testClearLaunchAgentReadinessFailure()
        }

        let staleWait = Task { @MainActor in
            await manager.waitForGatewayReady(timeout: 0.5)
        }
        for _ in 0..<100 {
            if session.snapshotMakeCount() > 0 { break }
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        #expect(session.snapshotMakeCount() == 1)
        manager._testBeginGatewayStartGeneration()
        manager._testSetLaunchAgentReadinessFailure(port: 19101, pid: 4242)

        #expect(await staleWait.value == false)
        #expect(manager._testHasLaunchAgentReadinessFailure())
        await connection.shutdown()
    }

    @Test func `readiness timeout includes a stalled socket connect`() async throws {
        let session = GatewayTestWebSocketSession(
            taskFactory: {
                GatewayTestWebSocketTask(
                    receiveHook: { _, receiveIndex in
                        if receiveIndex == 0 {
                            try await Task.sleep(nanoseconds: 30 * 1_000_000_000)
                        }
                        return .data(GatewayWebSocketTestSupport.connectChallengeData())
                    })
            })
        let url = try #require(URL(string: "ws://example.invalid"))
        let connection = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))

        let manager = GatewayProcessManager.shared
        manager.setTestingConnection(connection)
        manager.setTestingDesiredActive(true)
        defer {
            manager.setTestingConnection(nil)
            manager.setTestingDesiredActive(false)
        }

        let startedAt = Date()
        let ready = await manager.waitForGatewayReady(timeout: 0.1)
        let elapsed = Date().timeIntervalSince(startedAt)
        await connection.shutdown()

        #expect(!ready)
        #expect(elapsed < 1)
        #expect(session.snapshotMakeCount() == 1)
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
