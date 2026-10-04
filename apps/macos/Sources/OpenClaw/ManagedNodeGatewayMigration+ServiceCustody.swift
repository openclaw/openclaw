import CryptoKit
import Foundation
import OpenClawNativeState

extension ManagedNodeGatewayMigration {
    struct ServiceCustody: Equatable, Sendable {
        let definition: GatewayLaunchAgentManager.ServiceDefinitionDigest
        let runtimePin: OpenClawNativeStateConfigValue?

        func serviceAuthority() throws -> GatewayLaunchAgentManager.ServiceAuthority {
            let authority = try GatewayLaunchAgentManager.gatewayServiceAuthority()
            guard authority.definition == self.definition else {
                throw Failure(message: "Gateway service changed before dispatch; the newer service was preserved.")
            }
            return authority
        }

        var afterUninstall: Self {
            Self(definition: self.definition.withoutPlist, runtimePin: nil)
        }
    }

    enum RestorationAction: Equatable {
        case restoreNode
        case verifyOriginalNode
    }

    @MainActor
    final class RestorationCustody {
        var original: ServiceCustody?
        var installed: ServiceCustody?

        func finishInstall(
            error installError: String?,
            capture: () async throws -> ServiceCustody) async throws
        {
            if let installError, installError.contains(GatewayLaunchAgentManager.runtimePinSelectionChanged) {
                throw Failure(message: installError)
            }
            do { self.installed = try await capture() } catch {
                if let installError { throw Failure(message: installError) }
                throw error
            }
            if let installError { throw Failure(message: installError) }
        }

        func action(current: ServiceCustody) throws -> RestorationAction {
            if let installed, current == installed { return .restoreNode }
            if let original, original.runtimePin == nil, current == original {
                return original.definition.plist == nil ? .restoreNode : .verifyOriginalNode
            }
            throw Failure(message: "Gateway service or runtime pin changed during migration. " +
                "The newer service was preserved; inspect it before retrying.")
        }
    }

    private struct RuntimePin: Decodable {
        struct Pin: Decodable {
            let runtime: String
            let path: String
        }

        let version: Int
        let pin: Pin
        let definition: String
    }

    static func captureServiceCustody(
        profile: AppProfile = .current,
        requireService: Bool = true) async throws -> ServiceCustody
    {
        let state = profile.stateDirectoryURL()
        let artifacts = GatewayLaunchAgentManager.generatedEnvironmentArtifacts(
            directory: state.appendingPathComponent("service-env"), profile: profile)
        let plist = GatewayLaunchAgentManager.plistURL(
            homeDirectory: LaunchAgentPlist.homeDirectoryURL, profile: profile)
        let definition = try GatewayLaunchAgentManager.serviceDefinitionDigest(
            plist: plist,
            environment: artifacts.environment,
            wrapper: artifacts.wrapper)
        guard !requireService || definition.plist != nil else {
            throw Failure(message: "The Gateway service definition could not be inspected for recovery.")
        }
        let pin = try await GatewayLaunchAgentManager.runtimePinRecord(stateDirectory: state, profile: profile)
        guard try GatewayLaunchAgentManager.serviceDefinitionDigest(
            plist: plist,
            environment: artifacts.environment,
            wrapper: artifacts.wrapper) == definition
        else { throw Failure(message: "Gateway service changed while its ownership was being checked; retry.") }
        return ServiceCustody(definition: definition, runtimePin: pin)
    }

    static func installedServiceCustody(
        runtime: BundledRuntime,
        port: Int,
        allowUnconfigured: Bool,
        profile: AppProfile = .current,
        allowMissingRuntimePin: Bool = false) async throws -> ServiceCustody
    {
        let claim = try await self.captureServiceCustody(profile: profile)
        guard let snapshot = GatewayLaunchAgentManager.launchdConfigSnapshot() else {
            throw Failure(message: "The installed Bun service could not be inspected for recovery.")
        }
        let state = profile.stateDirectoryURL()
        let artifacts = GatewayLaunchAgentManager.generatedEnvironmentArtifacts(
            directory: state.appendingPathComponent("service-env"), profile: profile)
        let plistURL = GatewayLaunchAgentManager.plistURL(
            homeDirectory: LaunchAgentPlist.homeDirectoryURL, profile: profile)
        let plistData = try Data(contentsOf: plistURL)
        guard let plist = try PropertyListSerialization.propertyList(from: plistData, format: nil) as? [String: Any],
              let command = GatewayLaunchAgentManager.installedGatewayCommand(
                  programArguments: snapshot.programArguments,
                  environmentFile: artifacts.environment,
                  environmentWrapper: artifacts.wrapper),
              let cli = GatewayLaunchAgentManager.installedServiceCLI(
                  snapshot: snapshot, environmentFile: artifacts.environment, environmentWrapper: artifacts.wrapper),
              cli.prefix.first == runtime.bun.path,
              let entrypoint = cli.prefix.last,
              Self.bundledEntrypoints(runtime: runtime).contains(entrypoint),
              snapshot.environment["OPENCLAW_SQLITE_LIBRARY"] == runtime.sqliteLibrary.path,
              snapshot.port == port,
              snapshot.programArguments.contains("--allow-unconfigured") == allowUnconfigured
        else { throw Failure(message: "The Gateway service does not match this Bun installation; it was preserved.") }
        // Core binds runtime intent to the unwrapped command and working directory.
        let workingDirectory = (plist["WorkingDirectory"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        guard plist["WorkingDirectory"] == nil || plist["WorkingDirectory"] is String else {
            throw Failure(message: "The installed Gateway working directory could not be inspected.")
        }
        let binding: [Any] = [command, workingDirectory as Any? ?? NSNull()]
        let bindingData = try JSONSerialization.data(withJSONObject: binding, options: [.withoutEscapingSlashes])
        let definition = SHA256.hash(data: bindingData).map { String(format: "%02x", $0) }.joined()
        let expectedCommand = [runtime.bun.path, entrypoint, "gateway", "--port", String(port)] +
            (allowUnconfigured ? ["--allow-unconfigured"] : [])
        // A failed writer may publish the service before committing its pin. Without that
        // binding, only the exact packaged installer command and profile working directory qualify.
        let allowsAbsentPin = allowMissingRuntimePin && command == expectedCommand && workingDirectory == state.path
        guard self.runtimePinMatchesInstallation(
            claim.runtimePin, runtime: runtime, definition: definition, allowMissing: allowsAbsentPin),
            try await self.captureServiceCustody(profile: profile) == claim
        else {
            throw Failure(message: "Gateway service or runtime pin changed after Bun installation; it was preserved.")
        }
        return claim
    }

    static func runtimePinMatchesInstallation(
        _ record: OpenClawNativeStateConfigValue?,
        runtime: BundledRuntime,
        definition: String,
        allowMissing: Bool) -> Bool
    {
        guard let record else { return allowMissing }
        guard let pin = try? JSONDecoder().decode(RuntimePin.self, from: Data(record.value.utf8)) else { return false }
        return pin.version == 1 && pin.pin.runtime == "bun" && pin.pin.path == runtime.bun.path &&
            pin.definition == definition
    }

    private static func bundledEntrypoints(runtime: BundledRuntime) -> Set<String> {
        Set(["openclaw.mjs", "dist/index.js", "dist/index.mjs", "dist/entry.js", "dist/entry.mjs"].map {
            runtime.packageRoot.appendingPathComponent($0).path
        })
    }
}
