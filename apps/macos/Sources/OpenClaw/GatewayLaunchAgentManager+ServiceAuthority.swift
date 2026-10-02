import CryptoKit
import Foundation

extension GatewayLaunchAgentManager {
    /// Ephemeral custody of the service files. Resume records retain command intent, never this authority.
    struct ServiceAuthority: Equatable, Sendable {
        let plist: URL
        let environment: URL
        let wrapper: URL
        let definition: ServiceDefinitionDigest
        let isLocalGateway: Bool
        let updateSelection: CLIInstallPolicy.ManagedUpdateSelection

        func currentError() -> String? {
            guard let current = try? GatewayLaunchAgentManager.serviceDefinitionDigest(
                plist: self.plist, environment: self.environment, wrapper: self.wrapper),
                current == self.definition
            else { return "The Gateway service changed before dispatch; retry." }
            return nil
        }

        var afterUninstall: Self {
            Self(
                plist: self.plist,
                environment: self.environment,
                wrapper: self.wrapper,
                definition: self.definition.withoutPlist,
                isLocalGateway: self.isLocalGateway,
                updateSelection: self.updateSelection)
        }
    }

    struct ServiceDefinitionDigest: Equatable, Sendable {
        let plist: String?
        let environment: String?
        let wrapper: String?

        init(plist: Data?, environment: Data?, wrapper: Data?) {
            func digest(_ data: Data) -> String {
                SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            }
            self.plist = plist.map(digest)
            self.environment = environment.map(digest)
            self.wrapper = wrapper.map(digest)
        }

        private init(plistDigest: String?, environmentDigest: String?, wrapperDigest: String?) {
            self.plist = plistDigest
            self.environment = environmentDigest
            self.wrapper = wrapperDigest
        }

        var withoutPlist: Self {
            Self(plistDigest: nil, environmentDigest: self.environment, wrapperDigest: self.wrapper)
        }
    }

    struct ServiceFileCapture: Equatable, Sendable {
        let resolvedPath: String
        let contents: Data

        var digestData: Data {
            Data((self.resolvedPath + "\0").utf8) + self.contents
        }
    }

    static func captureServiceFile(at url: URL) throws -> ServiceFileCapture? {
        let contents: Data
        do { contents = try Data(contentsOf: url) } catch let error as NSError where
            error.domain == NSCocoaErrorDomain &&
            (error.code == NSFileReadNoSuchFileError || error.code == NSFileNoSuchFileError)
        {
            return nil
        }
        return ServiceFileCapture(resolvedPath: url.resolvingSymlinksInPath().path, contents: contents)
    }

    static func serviceDefinitionDigest(
        plist: URL, environment: URL, wrapper: URL) throws -> ServiceDefinitionDigest
    {
        try ServiceDefinitionDigest(
            plist: self.captureServiceFile(at: plist)?.digestData,
            environment: self.captureServiceFile(at: environment)?.digestData,
            wrapper: self.captureServiceFile(at: wrapper)?.digestData)
    }

    static func gatewayServiceAuthority(
        stateDirectory: URL = OpenClawPaths.stateDirURL,
        profile: AppProfile = .current,
        homeDirectory: URL = LaunchAgentPlist.homeDirectoryURL) throws -> ServiceAuthority
    {
        let artifacts = self.generatedEnvironmentArtifacts(
            directory: stateDirectory.appendingPathComponent("service-env"), profile: profile)
        let plist = self.plistURL(homeDirectory: homeDirectory, profile: profile)
        return try ServiceAuthority(
            plist: plist,
            environment: artifacts.environment,
            wrapper: artifacts.wrapper,
            definition: self.serviceDefinitionDigest(
                plist: plist, environment: artifacts.environment, wrapper: artifacts.wrapper),
            isLocalGateway: true,
            updateSelection: CLIInstallPolicy.managedUpdateSelection())
    }

    static func captureServiceCLI(
        plist: URL,
        environmentFile: URL,
        environmentWrapper: URL,
        subcommand: String = "gateway") -> InstalledServiceCLI?
    {
        guard let definition = try? self.serviceDefinitionDigest(
            plist: plist, environment: environmentFile, wrapper: environmentWrapper),
            let snapshot = LaunchAgentPlist.snapshot(
                url: plist,
                generatedEnvironmentFileURL: environmentFile,
                generatedEnvironmentWrapperURL: environmentWrapper),
            var cli = self.installedServiceCLI(
                snapshot: snapshot,
                environmentFile: environmentFile,
                environmentWrapper: environmentWrapper,
                subcommand: subcommand)
        else { return nil }
        let authority = ServiceAuthority(
            plist: plist,
            environment: environmentFile,
            wrapper: environmentWrapper,
            definition: definition,
            isLocalGateway: subcommand == "gateway",
            updateSelection: CLIInstallPolicy.managedUpdateSelection())
        guard authority.currentError() == nil else { return nil }
        cli.serviceAuthority = authority
        return cli
    }

    static func concreteServicePrefix(_ prefix: [String]) -> [String] {
        prefix.enumerated().map { index, argument in
            index == 0 || index == prefix.count - 1
                ? URL(fileURLWithPath: argument).resolvingSymlinksInPath().path : argument
        }
    }

    static func serviceCommandPathError(for cli: InstalledServiceCLI) -> String? {
        self.concreteServicePrefix(cli.sourcePrefix ?? cli.prefix) == cli.prefix
            ? nil : "The Gateway runtime or entrypoint changed before dispatch; retry."
    }

    static func serviceUpdateAuthorityError(for cli: InstalledServiceCLI) -> String? {
        guard let authority = cli.serviceAuthority else {
            return "The Gateway service authority could not be verified; retry."
        }
        // Remote Node service updates have their own service owner, independent of this Gateway marker.
        if authority.isLocalGateway, self.isLaunchAgentWriteDisabled() {
            return "Gateway service changes are disabled"
        }
        guard CLIInstallPolicy.permitsManagedUpdate(authority.updateSelection) else {
            return "The Gateway update policy changed before dispatch; retry with its current installation owner."
        }
        return authority.currentError() ?? self.serviceCommandPathError(for: cli) ??
            self.legacyServiceAuthorityError(for: cli)
    }

    static func resumedServiceCLI(
        _ retained: InstalledServiceCLI,
        stateDirectory: URL = OpenClawPaths.stateDirURL,
        profile: AppProfile = .current) throws -> InstalledServiceCLI
    {
        var cli = retained
        let authority = try cli.serviceAuthority?.afterUninstall ?? self.gatewayServiceAuthority(
            stateDirectory: stateDirectory, profile: profile)
        guard authority.definition.plist == nil,
              authority.currentError() == nil,
              self.serviceCommandPathError(for: cli) == nil
        else { throw GatewayHostingError(message: "The retained Gateway service changed; retry.") }
        cli.serviceAuthority = authority
        return cli
    }
}
