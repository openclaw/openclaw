import Foundation
import Testing
@testable import OpenClaw

@MainActor
struct StaleGatewayServiceReplacementTests {
    private final class Recorder {
        var steps: [String] = []
        var stateSchema: Int? = 36
    }

    private func replacement(_ recorder: Recorder, stopError: String? = nil) -> StaleGatewayServiceReplacement {
        StaleGatewayServiceReplacement(
            stop: { recorder.steps.append("stop")
                return stopError
            },
            restore: { recorder.steps.append("restore") },
            install: { recorder.steps.append("install")
                return nil
            },
            canRestore: {
                recorder.steps.append("check compatibility")
                return recorder.stateSchema == 36
            },
            serviceEntrypoint: "/stale/openclaw.mjs")
    }

    @Test func `credentials are prepared after the stale service stops and before this build installs`() async throws {
        let recorder = Recorder()
        let failure = try await self.replacement(recorder).run { recorder.steps.append("credentials for \($0)") }
        #expect(failure == nil)
        #expect(recorder.steps == ["stop", "credentials for /stale/openclaw.mjs", "install"])
    }

    @Test func `preparation failure before migration restores the compatible service`() async throws {
        let recorder = Recorder()
        await #expect(throws: GatewayHostingError.self) {
            _ = try await self.replacement(recorder).run { _ in
                recorder.steps.append("credentials")
                throw GatewayHostingError(message: "synthetic preparation failure")
            }
        }
        #expect(recorder.steps == ["stop", "credentials", "check compatibility", "restore"])
    }

    @Test(arguments: [41, nil] as [Int?])
    func `failed preparation leaves the service stopped if compatibility is lost or unknown`(
        schemaAfterPreparation: Int?) async throws
    {
        let recorder = Recorder()
        let message = "Invalid client identity requires explicit repair; startup preserved it."
        do {
            _ = try await self.replacement(recorder).run { _ in
                recorder.stateSchema = schemaAfterPreparation
                recorder.steps.append("credentials")
                throw GatewayHostingError(message: message)
            }
            Issue.record("The credential failure was lost")
        } catch let error as GatewayHostingError {
            #expect(error.message == message)
        }
        #expect(recorder.steps == ["stop", "credentials", "check compatibility"])
    }

    @Test func `an unsettled Doctor never starts another service`() async throws {
        let recorder = Recorder()
        await #expect(throws: CLIInstaller.DoctorProcessesUnsettled.self) {
            _ = try await self.replacement(recorder).run { _ in
                throw CLIInstaller.DoctorProcessesUnsettled(message: "timeout")
            }
        }
        #expect(recorder.steps == ["stop"])
    }

    @Test func `admission reads the stopped service's state and config`() throws {
        let service = LaunchAgentPlistSnapshot(
            programArguments: ["/bin/bun", "/old/openclaw.mjs", "gateway"],
            environment: [
                "HOME": "/old-home", "OPENCLAW_STATE_DIR": "/service/state",
                "OPENCLAW_CONFIG_PATH": "/service/config.json", "OPENCLAW_PROFILE": "work",
                "OPENCLAW_UPDATE_IN_PROGRESS": "1", "OPENCLAW_REPLACING_GATEWAY_SERVICE_ENTRYPOINT": "/old",
            ],
            stdoutPath: nil,
            stderrPath: nil,
            port: nil,
            bind: nil,
            token: nil,
            password: nil)
        let env = try #require(StaleGatewayServiceReplacement.admissionEnvironment(
            service: service, package: "/old", version: "2026.11.5"))
        #expect(env["OPENCLAW_STATE_DIR"] == "/service/state")
        #expect(env["OPENCLAW_CONFIG_PATH"] == "/service/config.json")
        #expect(env["OPENCLAW_PROFILE"] == "work")
        #expect(env["OPENCLAW_UPDATE_IN_PROGRESS"] == nil)
        #expect(env["OPENCLAW_REPLACING_GATEWAY_SERVICE_ENTRYPOINT"] == nil)
    }

    @Test func `restoration needs the previous build's explicit schema admission`() {
        func admits(_ output: String, version: String = "2026.11.5") -> Bool {
            StaleGatewayServiceReplacement.admitsRestore(
                .init(stdout: output, stderr: "", exitCode: 0, timedOut: false, success: true),
                version: version)
        }
        let accepted = """
        {"protocol":1,"verdict":"admit","reasons":[],"warnings":[],
        "facts":{"candidateVersion":"2026.11.5","installedVersion":"2026.11.5",
        "checks":[{"name":"config","status":"ok"},{"name":"database-schema","status":"ok"}]}}
        """
        #expect(admits(accepted))
        #expect(!admits(accepted, version: "2026.11.4"))
        #expect(!admits(accepted.replacingOccurrences(of: "database-schema", with: "node-runtime")))
        #expect(!admits(accepted.replacingOccurrences(of: "admit", with: "refuse")))
        let projected = accepted.replacingOccurrences(
            of: #""config","status":"ok""#, with: #""config","status":"warn""#)
        #expect(!admits(projected))
        #expect(!admits(""))
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
            _ = try await self.replacement(recorder, stopError: "stop refused").run { _ in
                recorder.steps.append("credentials")
            }
        }
        #expect(recorder.steps == ["stop"])
    }
}
