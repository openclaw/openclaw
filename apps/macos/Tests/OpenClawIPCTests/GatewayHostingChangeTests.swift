import Foundation
import Testing
@testable import OpenClaw

@MainActor
struct GatewayHostingChangeTests {
    @MainActor
    private final class Fixture {
        var authorized = true
        var retireDuringPreparation = false
        var retireBeforeMutation = false
        var installationFails = false
        var unhealthyReplacement = false
        var recoveryFailure: Error?
        var calls: [String] = []
        let previous: GatewayHosting
        var hosting: GatewayHosting
        var target: GatewayHosting {
            self.previous == .app ? .service : .app
        }

        init(previous: GatewayHosting = .app) {
            self.previous = previous
            self.hosting = previous
        }

        var operations: GatewayProcessManager.HostingChangeOperations {
            .init(
                prepare: {
                    self.calls.append("prepare")
                    if self.retireDuringPreparation { self.authorized = false }
                },
                isAuthorized: { self.authorized },
                replace: { admit in
                    if self.retireBeforeMutation { self.authorized = false }
                    try admit()
                    self.calls.append("stop-\(self.previous.rawValue)")
                    self.hosting = self.target
                    self.calls.append("install-\(self.target.rawValue)")
                    if self.installationFails { throw GatewayHostingError(message: "install failed") }
                    return true
                },
                recover: {
                    if let error = self.recoveryFailure { throw error }
                    self.calls.append("stop-\(self.target.rawValue)")
                    self.hosting = self.previous
                    self.calls.append("restore-\(self.previous.rawValue)")
                },
                verifyHealth: {
                    self.calls.append("health-\(self.hosting.rawValue)")
                    if self.hosting == self.target, self.unhealthyReplacement {
                        throw GatewayHostingError(message: "service unhealthy")
                    }
                })
        }
    }

    @Test(arguments: [true, false])
    func `retired Dashboard authority prevents the first hosting effect`(duringPreparation: Bool) async {
        let fixture = Fixture()
        fixture.retireDuringPreparation = duringPreparation
        fixture.retireBeforeMutation = !duringPreparation
        await #expect(throws: CancellationError.self) {
            try await GatewayProcessManager.changeHosting(operations: fixture.operations)
        }
        #expect(fixture.calls == ["prepare"])
        #expect(fixture.hosting == .app)
    }

    @Test(arguments: [GatewayHosting.app, .service], [true, false])
    func `failed hosting replacements restore the previous host and verify health`(
        previous: GatewayHosting,
        installFails: Bool) async
    {
        let fixture = Fixture(previous: previous)
        fixture.installationFails = installFails
        fixture.unhealthyReplacement = !installFails
        await #expect(throws: GatewayHostingError.self) {
            try await GatewayProcessManager.changeHosting(operations: fixture.operations)
        }
        #expect(fixture.hosting == previous)
        let target = fixture.target.rawValue
        let old = previous.rawValue
        #expect(fixture.calls == ["prepare", "stop-\(old)", "install-\(target)"] +
            (installFails ? [] : ["health-\(target)"]) + ["stop-\(target)", "restore-\(old)", "health-\(old)"])
    }

    @Test func `admitted replacement finishes recovery even if its Dashboard document retires`() async {
        let fixture = Fixture()
        fixture.unhealthyReplacement = true
        var operations = fixture.operations
        let verify = operations.verifyHealth
        operations.verifyHealth = {
            fixture.authorized = false
            try await verify()
        }
        await #expect(throws: GatewayHostingError.self) {
            try await GatewayProcessManager.changeHosting(operations: operations)
        }
        #expect(fixture.calls.suffix(2) == ["restore-app", "health-app"])
    }

    @Test func `CLI custody refusal ends the hosting change without recovery`() async {
        let fixture = Fixture()
        var operations = fixture.operations
        let replace = operations.replace
        let refusal = "Gateway service or runtime pin changed before installation. " +
            "The newer selection was preserved; inspect it before retrying."
        operations.replace = { admit in
            _ = try await replace(admit)
            throw GatewayHostingError(message: refusal)
        }
        do {
            try await GatewayProcessManager.changeHosting(operations: operations)
            Issue.record("Expected the CLI custody refusal")
        } catch {
            #expect(error.localizedDescription == refusal)
        }
        #expect(fixture.calls == ["prepare", "stop-app", "install-service"])
    }

    @Test(arguments: [true, false])
    func `recovery failure is reported without retrying or claiming health`(operatorChanged: Bool) async {
        let fixture = Fixture()
        fixture.installationFails = true
        fixture.recoveryFailure = operatorChanged
            ? GatewayHostingError(message: "operator changed the service") : CancellationError()
        await #expect(throws: GatewayHostingError.self) {
            try await GatewayProcessManager.changeHosting(operations: fixture.operations)
        }
        #expect(fixture.calls == ["prepare", "stop-app", "install-service"])
    }

    @Test func `retained service environment reaches child relaunch and service install without supervisor markers`() throws {
        let directory = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: directory) }
        let profile = AppProfile(environment: ["OPENCLAW_PROFILE": "hosting-environment"])
        let artifacts = GatewayLaunchAgentManager.generatedEnvironmentArtifacts(
            directory: directory.appendingPathComponent("service-env"), profile: profile)
        #expect(try GatewayLaunchAgentManager.retainedServiceEnvironment(
            stateDirectory: directory, profile: profile).isEmpty)
        try FileManager.default.createDirectory(
            at: artifacts.wrapper.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "#!/bin/sh\n".write(to: artifacts.wrapper, atomically: false, encoding: .utf8)
        #expect(throws: GatewayHostingError.self) {
            try GatewayLaunchAgentManager.retainedServiceEnvironment(stateDirectory: directory, profile: profile)
        }
        try """
        # Generated by OpenClaw. Do not edit while the gateway service is installed.
        export FIXTURE_CHANNEL_SETTING='service-value'
        export PATH='/fixture/custom/bin:/usr/bin'
        export OPENCLAW_SQLITE_LIBRARY='/fixture/old/libsqlite3.dylib'
        export OPENCLAW_PROFILE='old-profile'
        export OPENCLAW_STATE_DIR='/fixture/old-state'
        export OPENCLAW_LAUNCHD_LABEL='ai.openclaw.fixture'
        export XPC_SERVICE_NAME='ai.openclaw.fixture'
        export LAUNCH_JOB_LABEL='ai.openclaw.fixture'

        """.write(to: artifacts.environment, atomically: false, encoding: .utf8)
        let runtime = BundledRuntime(root: directory.appendingPathComponent("runtime/new-build"))
        do {
            let retained = try GatewayLaunchAgentManager.retainedServiceEnvironment(
                stateDirectory: directory, profile: profile)
            let environment = GatewayProcessManager.appHostedEnvironment(
                runtime: runtime,
                profile: profile,
                processEnvironment: ["FIXTURE_CHANNEL_SETTING": "ambient-value", "PATH": "/fixture/ambient/bin"],
                retainedEnvironment: retained,
                searchPaths: ["/usr/bin"])
            let child = GatewayChildSupervisor.Configuration(
                bun: runtime.bun, packageRoot: runtime.packageRoot, environment: environment,
                logPath: directory.appendingPathComponent("gateway.log").path, port: 29871, allowUnconfigured: false)
                .childEnvironment
            #expect(child["FIXTURE_CHANNEL_SETTING"] == "service-value")
            #expect(child["PATH"] == "\(runtime.bun.deletingLastPathComponent().path):/fixture/custom/bin:/usr/bin")
            #expect(child["OPENCLAW_SQLITE_LIBRARY"] == runtime.sqliteLibrary.path)
            #expect(child["OPENCLAW_PROFILE"] == "hosting-environment")
            #expect(child["OPENCLAW_STATE_DIR"] == profile.stateDirectoryURL().path)
            #expect(child["OPENCLAW_LAUNCHD_LABEL"] == nil)
            #expect(child["XPC_SERVICE_NAME"] == nil)
            #expect(child["LAUNCH_JOB_LABEL"] == nil)
            #expect(child["OPENCLAW_GATEWAY_HOST_LIFELINE"] == "stdin")
            let installer = GatewayLaunchAgentManager.daemonEnvironment(
                runtime: runtime,
                installedCLI: .init(
                    prefix: runtime.cliCommand, sqliteLibrary: runtime.sqliteLibrary.path, environment: environment),
                environment: [:], profile: profile, searchPaths: ["/usr/bin"])
            #expect(installer["FIXTURE_CHANNEL_SETTING"] == "service-value")
            #expect(installer["PATH"]?.contains("/fixture/custom/bin") == true)
            #expect(installer["OPENCLAW_GATEWAY_HOST_LIFELINE"] == nil)
        }
        try FileManager.default.removeItem(at: artifacts.wrapper)
        #expect(throws: GatewayHostingError.self) {
            try GatewayLaunchAgentManager.retainedServiceEnvironment(stateDirectory: directory, profile: profile)
        }
        try "#!/bin/sh\n".write(to: artifacts.wrapper, atomically: false, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: artifacts.environment.path)
        #expect(throws: GatewayHostingError.self) {
            try GatewayLaunchAgentManager.retainedServiceEnvironment(stateDirectory: directory, profile: profile)
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: artifacts.environment.path)
        try "export FIXTURE_CHANNEL_SETTING=$(unsupported)\n"
            .write(to: artifacts.environment, atomically: false, encoding: .utf8)
        #expect(throws: GatewayHostingError.self) {
            try GatewayLaunchAgentManager.retainedServiceEnvironment(stateDirectory: directory, profile: profile)
        }
    }

    @Test func `uninstalled service custody still rejects environment and wrapper replacement`() async throws {
        let directory = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: directory) }
        let profile = AppProfile(environment: ["OPENCLAW_PROFILE": "custody-" + UUID().uuidString.lowercased()])
        try #require(profile.isActive)
        let state = profile.stateDirectoryURL()
        defer { try? FileManager.default.removeItem(at: state) }
        try await TestIsolation.withIsolatedState(launchAgentHomeDirectory: directory) {
            let plist = GatewayLaunchAgentManager.plistURL(homeDirectory: directory, profile: profile)
            let artifacts = GatewayLaunchAgentManager.generatedEnvironmentArtifacts(
                directory: state.appendingPathComponent("service-env"), profile: profile)
            try FileManager.default.createDirectory(
                at: plist.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            try FileManager.default.createDirectory(
                at: artifacts.environment.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data("service definition".utf8).write(to: plist)
            let environment = Data("export FIXTURE='original'\n".utf8)
            try environment.write(to: artifacts.environment)
            try Data("original wrapper".utf8).write(to: artifacts.wrapper)
            let original = try await ManagedNodeGatewayMigration.captureServiceCustody(profile: profile)
            try FileManager.default.removeItem(at: plist)
            await #expect(throws: ManagedNodeGatewayMigration.Failure.self) {
                try await ManagedNodeGatewayMigration.captureServiceCustody(profile: profile)
            }
            let stopped = try await ManagedNodeGatewayMigration.captureServiceCustody(
                profile: profile,
                requireService: false)
            #expect(stopped == original.afterUninstall)
            try Data("export FIXTURE='operator-change'\n".utf8).write(to: artifacts.environment)
            #expect(try await ManagedNodeGatewayMigration.captureServiceCustody(
                profile: profile, requireService: false) != stopped)
            try environment.write(to: artifacts.environment)
            try Data("operator wrapper".utf8).write(to: artifacts.wrapper)
            #expect(try await ManagedNodeGatewayMigration.captureServiceCustody(
                profile: profile, requireService: false) != stopped)
        }
    }
}
