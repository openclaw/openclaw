import Testing
@testable import OpenClaw

@MainActor
struct StaleGatewayServiceReplacementTests {
    private final class Recorder {
        var steps: [String] = []
    }

    private func replacement(_ recorder: Recorder, stopError: String? = nil) -> StaleGatewayServiceReplacement {
        StaleGatewayServiceReplacement(
            stop: { recorder.steps.append("stop")
                return stopError
            },
            restore: { recorder.steps.append("restore") },
            install: { recorder.steps.append("install")
                return nil
            })
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
        let admission = StaleGatewayServiceReplacement.admission(
            connectionMode: mode,
            hostsLocalGateway: hostsLocalGateway,
            isPaused: paused,
            launchAgentUsesManagedCLI: true,
            gatewayUpdateChannel: nil,
            installPolicy: nil,
            launchAgentWriteDisabled: false)
        #expect(admission == (expected ? .admitted : .notHosted))
    }

    @Test(arguments: [AppState.ConnectionMode.local, .remote])
    func `detection keeps operator-selected Gateway versions and names their owner`(mode: AppState.ConnectionMode) {
        func admission(
            managed: Bool = true,
            channel: String? = nil,
            policy: String? = nil,
            writeDisabled: Bool = false) -> StaleGatewayServiceReplacement.Admission
        {
            StaleGatewayServiceReplacement.admission(
                connectionMode: mode,
                hostsLocalGateway: true,
                isPaused: false,
                launchAgentUsesManagedCLI: managed,
                gatewayUpdateChannel: channel,
                installPolicy: policy,
                launchAgentWriteDisabled: writeDisabled)
        }
        #expect(admission() == .admitted)
        #expect(admission(channel: "beta", policy: "exact") == .admitted)
        #expect(admission(channel: "extended-stable") == .excluded(.extendedStable))
        #expect(admission(policy: "beta") == .excluded(.installPolicy("beta")))
        #expect(admission(policy: "stable") == .excluded(.installPolicy("stable")))
        #expect(admission(managed: false) == .excluded(.independentlyManaged))
        #expect(admission(writeDisabled: true) == .excluded(.independentlyManaged))
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
