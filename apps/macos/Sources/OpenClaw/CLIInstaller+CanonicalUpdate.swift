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

    enum CanonicalUpdateResult: Sendable {
        case notRequired(PostAppUpdateReceipt)
        case repaired(PostAppUpdateReceipt)
        case superseded(PostAppUpdateReceipt, installedVersion: String, compatible: Bool)

        var receipt: PostAppUpdateReceipt {
            switch self {
            case let .notRequired(receipt), let .repaired(receipt):
                return receipt
            case let .superseded(receipt, _, _):
                // Continue live reconciliation without replaying an obsolete notice or
                // claiming core repair. Never acknowledge the CLI's recovery ledger here.
                return PostAppUpdateReceipt(
                    fromVersion: receipt.fromVersion, toVersion: receipt.toVersion, recordedAt: receipt.recordedAt,
                    runtimeBuildID: receipt.runtimeBuildID, setupRecovery: true)
            }
        }

        var isSuperseded: Bool {
            if case .superseded = self { return true }
            return false
        }
    }

    static func repairCanonicalUpdateIfNeeded(
        receipt: PostAppUpdateReceipt,
        checkCurrent: @escaping @MainActor @Sendable () async throws -> Void,
        statusHandler: @escaping @MainActor @Sendable (String) async -> Void) async throws -> CanonicalUpdateResult
    {
        guard receipt.coreUpdate == .legacyCanonical else { return .notRequired(receipt) }
        // Published incomplete receipts refer to install-cli's package, not whichever
        // service is selected now. The receipt requests repair; live custody admits it.
        let authority = try self.captureCanonicalUpdateAuthority(executable: self.managedExecutableLocation())
        let checkAuthority: @MainActor @Sendable () async throws -> Void = {
            try Task.checkCancellation()
            try await checkCurrent()
            try Task.checkCancellation()
            if let error = authority.currentError() { throw GatewayHostingError(message: error) }
        }
        try await checkAuthority()
        let status = await self.managedStatus(
            expectedVersion: receipt.toVersion, installedCLI: authority.cli, usesBundledRuntime: false)
        try await checkAuthority()
        let repair: Bool
        switch status {
        case let .ready(_, version) where version == receipt.toVersion:
            repair = true
        case let .incompatible(_, found, _) where
            CLIInstallPrompter.isManagedUpgrade(found: found, required: receipt.toVersion):
            repair = false
        case let .ready(_, found) where
            CLIInstallPrompter.isManagedUpgrade(found: receipt.toVersion, required: found):
            return .superseded(receipt, installedVersion: found, compatible: true)
        case let .incompatible(_, found, _) where
            CLIInstallPrompter.isManagedUpgrade(found: receipt.toVersion, required: found):
            // A newer but incompatible install is not declared ready. Its selected
            // runtime's compatibility owner still decides what can run; never downgrade it.
            return .superseded(receipt, installedVersion: found, compatible: false)
        default:
            throw GatewayHostingError(message: status.message)
        }
        var progress = receipt
        let outcome = await self.updateManaged(
            targetVersion: receipt.toVersion,
            restartGateway: false,
            repair: repair,
            checkCurrent: checkAuthority,
            onDispatch: {
                progress = PostAppUpdateReceiptStore.recordCoreUpdateDispatch(
                    receipt: progress, owner: .legacyCanonical)
            },
            statusHandler: statusHandler)
        switch outcome {
        case let .failure(message, details):
            throw GatewayHostingError(message: [message, details].compactMap(\.self).joined(separator: " "))
        case let .success(_, version):
            guard version == receipt.toVersion else {
                throw GatewayHostingError(
                    message: String(localized: "The managed runtime does not match the updated Mac app."))
            }
            // Record observed package success even if its caller retired meanwhile.
            // Callers recheck lifecycle before publishing stage facts or doing runtime work.
            return .repaired(PostAppUpdateReceiptStore.completeCoreRepair(receipt: progress, owner: .legacyCanonical))
        }
    }
}
