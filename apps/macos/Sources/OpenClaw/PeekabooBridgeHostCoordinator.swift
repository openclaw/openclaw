import Darwin
import Foundation
import os
import PeekabooBridge

protocol PeekabooBridgeRuntimeControlling: Sendable {
    func startChecked() async throws -> PeekabooEmbeddedBridgeRuntimeSnapshot
    func stopChecked() async
    func snapshot() async -> PeekabooEmbeddedBridgeRuntimeSnapshot
}

extension PeekabooEmbeddedBridgeRuntime: PeekabooBridgeRuntimeControlling {}

struct LegacyPeekabooSocketAliasManager {
    let targetSocketPath: String
    let aliasSocketPaths: [String]

    func ensureAliases(logger: Logger) {
        for aliasPath in self.aliasSocketPaths {
            self.ensureAlias(at: aliasPath, logger: logger)
        }
    }

    private func ensureAlias(at aliasPath: String, logger: Logger) {
        let fileManager = FileManager.default
        let aliasURL = URL(fileURLWithPath: aliasPath)
        do {
            try fileManager.createDirectory(
                at: aliasURL.deletingLastPathComponent(),
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700])

            var pathInfo = Darwin.stat()
            if lstat(aliasPath, &pathInfo) == 0 {
                guard pathInfo.st_mode & S_IFMT == S_IFLNK else {
                    logger.debug(
                        "Preserving non-symlink legacy PeekabooBridge path at \(aliasPath, privacy: .public)")
                    return
                }
                let destination = try fileManager.destinationOfSymbolicLink(atPath: aliasPath)
                let destinationURL = URL(
                    fileURLWithPath: destination,
                    relativeTo: aliasURL.deletingLastPathComponent()).standardizedFileURL
                let targetURL = URL(fileURLWithPath: self.targetSocketPath).standardizedFileURL
                guard destinationURL.path == targetURL.path else {
                    logger.debug(
                        "Preserving unowned legacy PeekabooBridge symlink at \(aliasPath, privacy: .public)")
                    return
                }
                return
            }
            guard errno == ENOENT else {
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
            try fileManager.createSymbolicLink(
                atPath: aliasPath,
                withDestinationPath: self.targetSocketPath)
        } catch {
            let message = "Failed to create legacy PeekabooBridge socket symlink: \(error.localizedDescription)"
            logger.debug("\(message, privacy: .public)")
        }
    }
}

@MainActor
final class PeekabooBridgeHostCoordinator {
    typealias RuntimeFactory = @MainActor () -> any PeekabooBridgeRuntimeControlling

    static let shared = PeekabooBridgeHostCoordinator()

    static let allowedClientTeamIDs = PeekabooBridgeConstants.trustedReleaseTeamIDs
    static let allowedClientBundleIDs: Set<String> = ["boo.peekaboo.peekaboo"]

    private let logger = Logger(subsystem: "ai.openclaw", category: "PeekabooBridge")
    private let runtimeFactory: RuntimeFactory
    private let aliasManager: LegacyPeekabooSocketAliasManager

    private var desiredEnabled = false
    private var retainedRuntime: (any PeekabooBridgeRuntimeControlling)?
    private var reconciliationTail: Task<Void, Never>?

    init() {
        let fileManager = FileManager.default
        let base = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
        let socketPath = Self.makeSocketPath(for: "OpenClaw", in: base)
        self.runtimeFactory = {
            PeekabooEmbeddedBridgeRuntime.make(
                configuration: .init(
                    socketPath: socketPath,
                    allowlistedTeams: Self.allowedClientTeamIDs,
                    allowlistedBundles: Self.allowedClientBundleIDs,
                    hostKind: .gui),
                snapshotOptions: .init(
                    snapshotValidityWindow: 600,
                    maxSnapshots: 50,
                    deleteArtifactsOnCleanup: false,
                    copyArtifactsOnStore: true))
        }
        self.aliasManager = LegacyPeekabooSocketAliasManager(
            targetSocketPath: socketPath,
            aliasSocketPaths: ["clawdbot", "clawdis", "moltbot"].map { Self.makeSocketPath(for: $0, in: base) })
    }

    init(runtimeFactory: @escaping RuntimeFactory, aliasManager: LegacyPeekabooSocketAliasManager) {
        self.runtimeFactory = runtimeFactory
        self.aliasManager = aliasManager
    }

    func setEnabled(_ enabled: Bool) async {
        self.desiredEnabled = enabled
        let predecessor = self.reconciliationTail
        let operation = Task { @MainActor [weak self] in
            await predecessor?.value
            guard let self else { return }
            if self.desiredEnabled {
                await self.ensureStarted()
            } else {
                await self.ensureStopped()
            }
        }
        self.reconciliationTail = operation
        await operation.value
    }

    func shutdown() async {
        await self.setEnabled(false)
    }

    private static func makeSocketPath(for directoryName: String, in baseDirectory: URL) -> String {
        baseDirectory
            .appendingPathComponent(directoryName, isDirectory: true)
            .appendingPathComponent(PeekabooBridgeConstants.socketName, isDirectory: false)
            .path
    }

    private func ensureStarted() async {
        let retained = self.retainedRuntime
        if let retained {
            let snapshot = await retained.snapshot()
            guard snapshot.state != .ready else { return }
        }
        let candidate = retained ?? self.runtimeFactory()
        do {
            let started = try await candidate.startChecked()
            guard started.state == .ready else {
                if retained != nil {
                    self.logger.error("PeekabooBridge retained runtime did not become ready")
                } else {
                    await self.stopCandidate(candidate)
                    self.logger.error("PeekabooBridge runtime returned before becoming ready")
                }
                return
            }
            if retained == nil, !self.desiredEnabled {
                await self.stopCandidate(candidate)
                return
            }

            if retained == nil { self.retainedRuntime = candidate }
            self.aliasManager.ensureAliases(logger: self.logger)
            if retained == nil {
                self.logger.info("PeekabooBridge host ready at \(started.socketPath, privacy: .public)")
            }
        } catch let PeekabooBridgeHostError.socketAlreadyOwned(path) {
            self.logSocketServedElsewhere(path)
        } catch {
            if retained != nil {
                let message = "Failed to restart retained PeekabooBridge runtime: \(error.localizedDescription)"
                self.logger.error("\(message, privacy: .public)")
            } else {
                self.logger
                    .error("Failed to start PeekabooBridge host: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    private func logSocketServedElsewhere(_ path: String) {
        self.logger.info(
            "PeekabooBridge host not started: \(path, privacy: .public) is already served by another host; " +
                "this per-user socket is shared by all OpenClaw profiles")
    }

    private func ensureStopped() async {
        guard let retainedRuntime else { return }
        await retainedRuntime.stopChecked()
        let snapshot = await retainedRuntime.snapshot()
        guard snapshot.state == .stopped else {
            // A runtime that still owns the socket must stay retained so the next reconciliation can finish teardown.
            let state = snapshot.state.rawValue
            self.logger.error("PeekabooBridge host retained after incomplete stop in state \(state, privacy: .public)")
            return
        }
        self.retainedRuntime = nil
        self.logger.info("PeekabooBridge host stopped")
    }

    private func stopCandidate(_ candidate: any PeekabooBridgeRuntimeControlling) async {
        await candidate.stopChecked()
        let snapshot = await candidate.snapshot()
        guard snapshot.state == .stopped else {
            self.retainedRuntime = candidate
            let state = snapshot.state.rawValue
            let message = "PeekabooBridge candidate retained after incomplete stop in state \(state)"
            self.logger.error("\(message, privacy: .public)")
            return
        }
    }
}
