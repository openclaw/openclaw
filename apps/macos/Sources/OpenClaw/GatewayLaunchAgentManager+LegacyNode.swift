import Foundation

extension GatewayLaunchAgentManager {
    private enum LegacyNodeInstallation {
        case absent, managed([String]), external
    }

    static func legacyNodeInstallIsExternal(
        profile: AppProfile = .current,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser) throws -> Bool
    {
        if case .external = try self
            .legacyNodeInstallation(profile: profile, homeDirectory: homeDirectory) { return true }
        return false
    }

    static func hasLegacyManagedNodeInstall(
        profile: AppProfile = .current,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser) throws -> Bool
    {
        if case .managed = try self
            .legacyNodeInstallation(profile: profile, homeDirectory: homeDirectory) { return true }
        return false
    }

    static func legacyManagedNodeCLI(
        profile: AppProfile = .current,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser) throws -> InstalledServiceCLI?
    {
        guard case let .managed(command) = try self.legacyNodeInstallation(
            profile: profile, homeDirectory: homeDirectory)
        else {
            return nil
        }
        let state = profile.stateDirectoryURL(homeDirectory: homeDirectory)
        let artifacts = self.generatedEnvironmentArtifacts(
            directory: state.appendingPathComponent("service-env"), profile: profile)
        let hasEnvironment = FileManager.default.fileExists(atPath: artifacts.environment.path)
        let hasWrapper = FileManager.default.fileExists(atPath: artifacts.wrapper.path)
        var environment: [String: String] = [:]
        if hasEnvironment || hasWrapper {
            guard FileManager.default.isReadableFile(atPath: artifacts.environment.path),
                  FileManager.default.isReadableFile(atPath: artifacts.wrapper.path)
            else {
                throw GatewayHostingError(
                    message: "The managed Gateway environment is unavailable; repair its service.")
            }
            environment = LaunchAgentPlist.readGeneratedEnvironment(
                programArguments: [artifacts.wrapper.path, artifacts.environment.path],
                fileURL: artifacts.environment,
                wrapperURL: artifacts.wrapper)
        }
        // Inferred argv is also authority: keep its physical paths across awaits and relaunches.
        return try InstalledServiceCLI(
            prefix: command.map { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path },
            sqliteLibrary: environment["OPENCLAW_SQLITE_LIBRARY"],
            environment: environment,
            usesGeneratedEnvironment: hasEnvironment,
            isInferredLegacyInstall: true,
            serviceAuthority: self.gatewayServiceAuthority(
                stateDirectory: state, profile: profile, homeDirectory: homeDirectory))
    }

    static func legacyServiceAuthorityError(for cli: InstalledServiceCLI) -> String? {
        guard cli.isInferredLegacyInstall else { return nil }
        let message = "The legacy Gateway installation changed during setup; retry."
        guard !CommandResolver.connectionModeIsRemote(),
              [nil, "exact"].contains(CLIInstallPolicy.storedPolicy()) else { return message }
        do {
            guard case let .managed(command) = try self.legacyNodeInstallation(
                profile: .current, homeDirectory: LaunchAgentPlist.homeDirectoryURL) else { return message }
            // Seeding may replace our wrapper with the bundled shim; the surviving Node package
            // still proves ownership. An operator wrapper or different package cannot authorize it.
            let currentPaths = command.map { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path }
            return currentPaths == cli.prefix ? nil : message
        } catch { return message }
    }

    private static func legacyNodeInstallation(
        profile: AppProfile,
        homeDirectory: URL) throws -> LegacyNodeInstallation
    {
        try self.legacyNodeInstallation(state: profile.stateDirectoryURL(homeDirectory: homeDirectory))
    }

    static func legacyManagedNodeCommand(stateDirectory: URL) throws -> [String]? {
        guard case let .managed(command) = try self.legacyNodeInstallation(state: stateDirectory) else { return nil }
        return command
    }

    private static func legacyNodeInstallation(state: URL) throws -> LegacyNodeInstallation {
        let fileManager = FileManager.default
        let wrapper = state.appendingPathComponent("bin/openclaw")
        var operatorWrapper = false
        if fileManager.fileExists(atPath: wrapper.path) {
            let attributes = try fileManager.attributesOfItem(atPath: wrapper.path)
            if attributes[.type] as? FileAttributeType == .typeRegular {
                let text = try String(contentsOf: wrapper, encoding: .utf8)
                if let command = BundledRuntime.legacyManagedNodeCommand(text, stateDirectory: state),
                   self.validLegacyNodeCommand(command, stateDirectory: state) { return .managed(command) }
                operatorWrapper = !BundledRuntime.isManagedShim(text, stateDirectory: state)
            } else {
                operatorWrapper = true
            }
        }
        let tools = state.appendingPathComponent("tools")
        let alias = tools.appendingPathComponent("node")
        if let command = try self.managedNodePackageCommand(nodeRoot: alias, stateDirectory: state) {
            return operatorWrapper ? .external : .managed(command)
        }
        guard fileManager.fileExists(atPath: tools.path) else { return .absent }
        let roots = try fileManager.contentsOfDirectory(at: tools, includingPropertiesForKeys: nil)
            .filter { $0.lastPathComponent.hasPrefix("node-") }
        let commands = try roots.compactMap { try self.managedNodePackageCommand(nodeRoot: $0, stateDirectory: state) }
        if operatorWrapper, !commands.isEmpty { return .external }
        guard commands.count <= 1 else {
            throw GatewayHostingError(
                message: "Several legacy Node installations remain; restore the managed CLI first.")
        }
        return commands.first.map(LegacyNodeInstallation.managed) ?? .absent
    }

    private static func managedNodePackageCommand(nodeRoot: URL, stateDirectory: URL) throws -> [String]? {
        let fileManager = FileManager.default
        let package = nodeRoot.appendingPathComponent("lib/node_modules/openclaw")
        let manifest = package.appendingPathComponent("package.json")
        guard self.isWithinState(manifest.path, stateDirectory: stateDirectory),
              fileManager.fileExists(atPath: manifest.path) else { return nil }
        let metadata = try JSONSerialization.jsonObject(with: Data(contentsOf: manifest)) as? [String: Any]
        guard metadata?["name"] as? String == "openclaw" else { return nil }
        for entry in ["dist/entry.js", "openclaw.mjs"] {
            let command = [
                nodeRoot.appendingPathComponent("bin/node").path,
                package.appendingPathComponent(entry).path,
            ]
            if self.validLegacyNodeCommand(command, stateDirectory: stateDirectory) { return command }
        }
        return nil
    }

    private static func validLegacyNodeCommand(_ command: [String], stateDirectory: URL) -> Bool {
        command.count == 2 && self.isManagedNode(command[0], stateDirectory: stateDirectory) &&
            self.isWithinState(command[1], stateDirectory: stateDirectory) &&
            FileManager.default.isExecutableFile(atPath: command[0]) &&
            FileManager.default.isReadableFile(atPath: command[1])
    }
}
