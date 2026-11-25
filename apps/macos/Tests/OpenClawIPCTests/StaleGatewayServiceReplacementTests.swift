import Testing
@testable import OpenClaw

@MainActor
struct StaleGatewayServiceReplacementTests {
    private final class Recorder {
        var steps: [String] = []
    }

    private func replacement(_ recorder: Recorder, stopError: String? = nil) -> StaleGatewayServiceReplacement {
        StaleGatewayServiceReplacement(
            stop: { recorder.steps.append("stop"); return stopError },
            restore: { recorder.steps.append("restore") },
            install: { recorder.steps.append("install"); return nil })
    }

    @Test func `credentials are prepared after the stale service stops and before this build installs`() async throws {
        let recorder = Recorder()
        let failure = try await self.replacement(recorder).run { recorder.steps.append("credentials") }
        #expect(failure == nil)
        #expect(recorder.steps == ["stop", "credentials", "install"])
    }

    @Test func `failed credential preparation restores the previous service instead of installing`() async throws {
        let recorder = Recorder()
        await #expect(throws: GatewayHostingError.self) {
            _ = try await self.replacement(recorder).run {
                recorder.steps.append("credentials")
                throw GatewayHostingError(message: "synthetic preparation failure")
            }
        }
        #expect(recorder.steps == ["stop", "credentials", "restore"])
    }

    @Test(arguments: [
        (AppState.ConnectionMode.local, false, false, true),
        (.local, true, false, true),
        (.local, false, true, false),
        (.remote, true, false, true),
        (.remote, false, false, false),
        (.remote, true, true, false),
        (.unconfigured, true, false, false),
    ])
    func `detection replaces only active local Gateways`(
        mode: AppState.ConnectionMode, hostsLocalGateway: Bool, paused: Bool, expected: Bool)
    {
        #expect(StaleGatewayServiceReplacement.admits(
            connectionMode: mode,
            hostsLocalGateway: hostsLocalGateway,
            isPaused: paused,
            launchAgentUsesManagedCLI: true,
            gatewayUpdateChannel: nil,
            installPolicy: nil,
            launchAgentWriteDisabled: false) == expected)
    }

    @Test(arguments: [AppState.ConnectionMode.local, .remote])
    func `detection keeps operator-selected Gateway versions`(mode: AppState.ConnectionMode) {
        func admits(channel: String? = nil, policy: String? = nil) -> Bool {
            StaleGatewayServiceReplacement.admits(
                connectionMode: mode,
                hostsLocalGateway: true,
                isPaused: false,
                launchAgentUsesManagedCLI: true,
                gatewayUpdateChannel: channel,
                installPolicy: policy,
                launchAgentWriteDisabled: false)
        }
        #expect(admits())
        #expect(admits(channel: "beta", policy: "exact"))
        #expect(!admits(channel: "extended-stable"))
        #expect(!admits(policy: "beta"))
        #expect(!admits(policy: "stable"))
    }

    @Test(arguments: [AppState.ConnectionMode.local, .remote])
    func `detection preserves unmanaged services and disabled service writes`(mode: AppState.ConnectionMode) {
        for (managed, writeDisabled) in [(false, false), (true, true)] {
            #expect(!StaleGatewayServiceReplacement.admits(
                connectionMode: mode,
                hostsLocalGateway: true,
                isPaused: false,
                launchAgentUsesManagedCLI: managed,
                gatewayUpdateChannel: nil,
                installPolicy: nil,
                launchAgentWriteDisabled: writeDisabled))
        }
    }

    @Test func `a refused stop never runs credential preparation`() async throws {
        let recorder = Recorder()
        await #expect(throws: GatewayHostingError.self) {
            _ = try await self.replacement(recorder, stopError: "stop refused").run {
                recorder.steps.append("credentials")
            }
        }
        #expect(recorder.steps == ["stop"])
    }
}
