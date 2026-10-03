import Foundation

extension CLIInstaller {
    struct CanonicalUpdateAuthority: Sendable {
        let executable: URL
        let file: GatewayLaunchAgentManager.ServiceFileCapture?
        let cli: GatewayLaunchAgentManager.InstalledServiceCLI
        let selection: CLIInstallPolicy.ManagedUpdateSelection
        let localGateway: Bool

        nonisolated func currentError() -> String? {
            guard CLIInstallPolicy.permitsManagedUpdate(self.selection) else {
                return "The managed update policy changed before dispatch; retry with its current installation owner."
            }
            if self.localGateway, GatewayLaunchAgentManager.isLaunchAgentWriteDisabled() {
                return "Gateway service changes are disabled"
            }
            do {
                guard try GatewayLaunchAgentManager.captureServiceFile(at: self.executable) == self.file,
                      let command = try GatewayLaunchAgentManager.legacyManagedNodeCommand(
                          stateDirectory: self.executable.deletingLastPathComponent().deletingLastPathComponent()),
                      GatewayLaunchAgentManager.concreteServicePrefix(command) == self.cli.prefix
                else {
                    return "The managed CLI wrapper changed before dispatch; retry."
                }
            } catch { return "The managed CLI wrapper could not be verified before dispatch; retry." }
            return GatewayLaunchAgentManager.serviceCommandPathError(for: self.cli)
        }
    }

    static func captureCanonicalUpdateAuthority(executable: String) throws -> CanonicalUpdateAuthority {
        let url = URL(fileURLWithPath: executable)
        let state = url.deletingLastPathComponent().deletingLastPathComponent()
        let file = try GatewayLaunchAgentManager.captureServiceFile(at: url)
        let command: [String]
        if let file {
            guard let attributes = try? FileManager.default.attributesOfItem(atPath: executable),
                  attributes[.type] as? FileAttributeType == .typeRegular,
                  let text = String(data: file.contents, encoding: .utf8),
                  let recognized = BundledRuntime.legacyManagedNodeCommand(text, stateDirectory: state)
            else {
                throw GatewayHostingError(
                    message: "The canonical managed Node CLI changed ownership; it was preserved.")
            }
            command = recognized
        } else {
            guard let recognized = try GatewayLaunchAgentManager.legacyManagedNodeCommand(stateDirectory: state) else {
                throw GatewayHostingError(
                    message: "The canonical managed Node CLI is unavailable; restore it before retrying.")
            }
            command = recognized
        }
        let concrete = GatewayLaunchAgentManager.concreteServicePrefix(command)
        let resolvedState = state.resolvingSymlinksInPath()
        guard GatewayLaunchAgentManager.isManagedNode(concrete[0], stateDirectory: resolvedState),
              GatewayLaunchAgentManager.isWithinState(concrete[1], stateDirectory: resolvedState)
        else {
            throw GatewayHostingError(message: "The canonical managed Node CLI changed ownership; it was preserved.")
        }
        return CanonicalUpdateAuthority(
            executable: url,
            file: file,
            cli: .init(prefix: concrete, sqliteLibrary: nil, sourcePrefix: command),
            selection: CLIInstallPolicy.managedUpdateSelection(),
            localGateway: !CommandResolver.connectionModeIsRemote())
    }
}
