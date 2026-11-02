import Foundation

extension GatewayLaunchAgentManager {
    static let resumeCommandKey = "gatewayNodeResumeCommand"

    private struct ResumeCommand: Codable {
        let prefix: [String]
        let sqliteLibrary: String?
        let usesGeneratedEnvironment: Bool?
        let hadRuntimePin: Bool?
        let isInferredLegacyInstall: Bool?
        let sourcePrefix: [String]?
    }

    static func resumeData(for cli: InstalledServiceCLI) throws -> Data {
        // Credentials remain in core's private service environment file, which uninstall retains.
        try JSONEncoder().encode(ResumeCommand(
            prefix: cli.prefix,
            sqliteLibrary: cli.sqliteLibrary,
            usesGeneratedEnvironment: cli.usesGeneratedEnvironment,
            hadRuntimePin: cli.hadRuntimePin,
            isInferredLegacyInstall: cli.isInferredLegacyInstall ? true : nil,
            sourcePrefix: cli.sourcePrefix))
    }

    static func resumeCLI(
        from data: Data,
        stateDirectory: URL,
        profile: AppProfile = .current) throws -> InstalledServiceCLI
    {
        try self.resumedServiceCLI(
            self.retainedServiceIntent(from: data, stateDirectory: stateDirectory, profile: profile),
            stateDirectory: stateDirectory,
            profile: profile)
    }

    static func retainedServiceIntent(
        from data: Data,
        stateDirectory: URL,
        profile: AppProfile = .current) throws -> InstalledServiceCLI
    {
        let command = try JSONDecoder().decode(ResumeCommand.self, from: data)
        guard let executable = command.prefix.first, let entry = command.prefix.last,
              executable.hasPrefix("/"), ["node", "bun"].contains(URL(fileURLWithPath: executable).lastPathComponent),
              self.isWithinState(entry, stateDirectory: stateDirectory)
        else {
            throw GatewayHostingError(
                message: "The retained Gateway command is invalid; repair its managed installation.")
        }
        let artifacts = self.generatedEnvironmentArtifacts(
            directory: stateDirectory.appendingPathComponent("service-env"), profile: profile)
        var environment: [String: String] = [:]
        if command.usesGeneratedEnvironment == true {
            guard FileManager.default.isReadableFile(atPath: artifacts.environment.path),
                  FileManager.default.isReadableFile(atPath: artifacts.wrapper.path)
            else {
                throw GatewayHostingError(
                    message: "The retained Gateway environment is unavailable; repair its service.")
            }
            environment = LaunchAgentPlist.readGeneratedEnvironment(
                programArguments: [artifacts.wrapper.path, artifacts.environment.path],
                fileURL: artifacts.environment,
                wrapperURL: artifacts.wrapper)
        }
        environment["OPENCLAW_SQLITE_LIBRARY"] = command.sqliteLibrary
        let snapshot = LaunchAgentPlistSnapshot(
            programArguments: command.prefix + ["gateway"],
            environment: environment,
            stdoutPath: nil,
            stderrPath: nil,
            port: nil,
            bind: nil,
            token: nil,
            password: nil)
        guard self.installedServiceCLI(
            snapshot: snapshot, environmentFile: artifacts.environment, environmentWrapper: artifacts.wrapper) != nil
        else {
            throw GatewayHostingError(
                message: "The retained Gateway entrypoint is invalid; repair its managed installation.")
        }
        // These paths were frozen before persistence. Re-resolving them here would adopt a
        // retargeted runtime/package directory before the dispatch guard could detect it.
        let cli = InstalledServiceCLI(
            prefix: command.prefix,
            sqliteLibrary: command.sqliteLibrary,
            environment: environment,
            usesGeneratedEnvironment: command.usesGeneratedEnvironment == true,
            hadRuntimePin: command.hadRuntimePin == true,
            isInferredLegacyInstall: command.isInferredLegacyInstall == true,
            sourcePrefix: command.sourcePrefix)
        if let error = self.serviceCommandPathError(for: cli) { throw GatewayHostingError(message: error) }
        return cli
    }

    static func updatedBundledResumeCLI(
        _ cli: InstalledServiceCLI,
        runtime: BundledRuntime,
        stateDirectory: URL) throws -> InstalledServiceCLI
    {
        if let error = self.bundledRuntimeReplacementError(
            appManaged: true, installedRuntimePath: cli.prefix.first, stateDirectory: stateDirectory)
        {
            throw GatewayHostingError(message: error)
        }
        guard cli.prefix.first.map({ URL(fileURLWithPath: $0).lastPathComponent }) == "bun" else {
            throw GatewayHostingError(
                message: "The retained Gateway uses Node; update it through its existing installation.")
        }
        var environment = cli.environment
        environment["OPENCLAW_SQLITE_LIBRARY"] = runtime.sqliteLibrary.path
        return InstalledServiceCLI(
            prefix: runtime.cliCommand,
            sqliteLibrary: runtime.sqliteLibrary.path,
            environment: environment,
            usesGeneratedEnvironment: cli.usesGeneratedEnvironment,
            hadRuntimePin: cli.hadRuntimePin,
            serviceAuthority: cli.serviceAuthority)
    }

    static func isWithinState(_ path: String, stateDirectory: URL) -> Bool {
        let url = URL(fileURLWithPath: path)
        return url.standardizedFileURL.path.hasPrefix(stateDirectory.standardizedFileURL.path + "/") &&
            url.resolvingSymlinksInPath().path.hasPrefix(stateDirectory.resolvingSymlinksInPath().path + "/")
    }

    static func isManagedNode(_ executable: String, stateDirectory: URL) -> Bool {
        let url = URL(fileURLWithPath: executable)
        guard executable.hasPrefix("/"), url.lastPathComponent == "node" else { return false }
        func owned(_ node: URL, root: URL) -> Bool {
            let tools = root.appendingPathComponent("tools").standardizedFileURL.path + "/"
            let path = node.standardizedFileURL.path
            guard path.hasPrefix(tools) else { return false }
            let parts = path.dropFirst(tools.count).split(separator: "/")
            return parts.count == 3 && (parts[0] == "node" || parts[0].hasPrefix("node-")) &&
                parts[1] == "bin" && parts[2] == "node"
        }
        return owned(url, root: stateDirectory) && owned(
            url.resolvingSymlinksInPath(), root: stateDirectory.resolvingSymlinksInPath())
    }
}
