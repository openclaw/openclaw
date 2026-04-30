import Foundation
import OpenClawIPC
import OpenClawKit
import OpenClawProtocol
import OSLog

private let computerUseServerId = "computer-use"
private let computerUseRequiredPermissions = [Capability.accessibility.rawValue, Capability.screenRecording.rawValue]
private let computerUseEnvCommandKey = "OPENCLAW_COMPUTER_USE_MCP_COMMAND"
private let computerUseEnvArgsKey = "OPENCLAW_COMPUTER_USE_MCP_ARGS"
private let computerUseEnvPackageDirKey = "OPENCLAW_COMPUTER_USE_MCP_PACKAGE_DIR"
private let computerUseEnvInstallDirKey = "OPENCLAW_COMPUTER_USE_MCP_INSTALL_DIR"
private let computerUseAppSupportDirName = "CodexComputerUseMCP"
private let computerUsePackageDirName = "computer-use"
private let computerUseBundledResourcePath = "CodexComputerUseMCP/computer-use"
private let computerUseManagedMetadataFileName = ".openclaw-computer-use-source.json"
private let computerUsePackageInstallBeginCommand = "mcp.package.install.begin"
private let computerUsePackageInstallChunkCommand = "mcp.package.install.chunk"
private let computerUsePackageInstallFinishCommand = "mcp.package.install.finish"
private let computerUsePackageInstallCancelCommand = "mcp.package.install.cancel"

struct MacMcpLaunchConfig {
    var command: URL
    var args: [String]
    var cwd: URL?
    var source: String
}

private struct MacMcpPackageSource {
    var directory: URL
    var source: String
}

private struct MacMcpPackageFingerprint: Codable, Equatable {
    var fileCount: Int
    var totalSize: UInt64
    var latestModifiedAt: TimeInterval
}

private struct MacMcpManagedPackageMetadata: Codable, Equatable {
    var source: String
    var sourcePath: String
    var sourceFingerprint: MacMcpPackageFingerprint
}

private struct MacMcpPackageInstallBeginParams: Decodable {
    var transferId: String
    var nodeId: String
    var serverId: String
    var packageName: String?
    var sourcePath: String?
    var fileCount: Int?
    var totalBytes: UInt64?
}

private struct MacMcpPackageInstallChunkParams: Decodable {
    var transferId: String
    var relativePath: String
    var dataBase64: String
    var executable: Bool?
}

private struct MacMcpPackageInstallFinishParams: Decodable {
    var transferId: String
}

private struct MacMcpPackageInstallCancelParams: Decodable {
    var transferId: String
}

private struct CodexMcpManifest: Decodable {
    struct Server: Decodable {
        var command: String
        var args: [String]?
        var cwd: String?
    }

    var mcpServers: [String: Server]
}

private struct MacMcpPackageInstallPayload: Encodable {
    var ok: Bool
    var transferId: String
    var serverId: String?
    var fileCount: Int?
    var totalBytes: UInt64?
}

private final class ActiveMacMcpSession: @unchecked Sendable {
    let sessionId: String
    let nodeId: String
    let process: Process
    let input: Pipe
    var nextSeq = 0
    var closeRequested = false

    init(sessionId: String, nodeId: String, process: Process, input: Pipe) {
        self.sessionId = sessionId
        self.nodeId = nodeId
        self.process = process
        self.input = input
    }
}

private struct ActiveMacMcpPackageInstall {
    var transferId: String
    var nodeId: String
    var serverId: String
    var sourcePath: String
    var expectedFileCount: Int?
    var expectedTotalBytes: UInt64?
    var directory: URL
    var files: Set<String> = []
    var totalBytes: UInt64 = 0
}

actor MacComputerUseMcpHost {
    private let logger = Logger(subsystem: "ai.openclaw", category: "mac-mcp")
    private let appSupportRoot: URL?
    private var sessions: [String: ActiveMacMcpSession] = [:]
    private var activeInstall: ActiveMacMcpPackageInstall?

    init(appSupportRoot: URL? = nil) {
        self.appSupportRoot = appSupportRoot
    }

    nonisolated static var packageInstallCommands: [String] {
        [
            computerUsePackageInstallBeginCommand,
            computerUsePackageInstallChunkCommand,
            computerUsePackageInstallFinishCommand,
            computerUsePackageInstallCancelCommand,
        ]
    }

    nonisolated static func computerUseDescriptor(permissions: [String: Bool]) -> NodeMcpServerDescriptor {
        let hasRequiredPermissions = computerUseRequiredPermissions.allSatisfy { permissions[$0] == true }
        let launch = Self.resolveComputerUseLaunchConfig()
        let status = if !hasRequiredPermissions {
            "missing_permissions"
        } else if launch == nil {
            "missing_backend"
        } else {
            "ready"
        }
        var metadata: [String: AnyCodable] = [:]
        if let launch {
            metadata["source"] = AnyCodable(launch.source)
            metadata["command"] = AnyCodable(launch.command.lastPathComponent)
        }
        return NodeMcpServerDescriptor(
            id: computerUseServerId,
            displayname: "Computer Use",
            provider: "codex",
            transport: "stdio",
            source: launch?.source ?? "codex-bundled",
            status: status,
            requiredpermissions: computerUseRequiredPermissions,
            metadata: metadata.isEmpty ? nil : metadata)
    }

    func handleInvoke(
        _ req: BridgeInvokeRequest,
        permissions: [String: Bool],
        sendMcpServersUpdate: (@Sendable (String, [NodeMcpServerDescriptor]) async -> Void)? = nil) async
        -> BridgeInvokeResponse?
    {
        do {
            switch req.command {
            case computerUsePackageInstallBeginCommand:
                return try self.handlePackageInstallBegin(req)
            case computerUsePackageInstallChunkCommand:
                return try self.handlePackageInstallChunk(req)
            case computerUsePackageInstallFinishCommand:
                let nodeId = self.activeInstall?.nodeId
                let response = try self.handlePackageInstallFinish(req)
                if response.ok, let nodeId {
                    await sendMcpServersUpdate?(
                        nodeId,
                        [Self.computerUseDescriptor(permissions: permissions)])
                }
                return response
            case computerUsePackageInstallCancelCommand:
                return try self.handlePackageInstallCancel(req)
            default:
                return nil
            }
        } catch {
            return Self.errorResponse(req, code: .unavailable, message: error.localizedDescription)
        }
    }

    func open(_ event: NodeMcpSessionOpenEvent, gateway: GatewayNodeSession) async {
        guard event.serverid == computerUseServerId else {
            await gateway.sendMcpSessionOpenResult(Self.openResult(
                event: event,
                ok: false,
                errorCode: "UNKNOWN_SERVER",
                message: "unknown MCP server"))
            return
        }
        guard let launch = Self.resolveComputerUseLaunchConfig() else {
            await gateway.sendMcpSessionOpenResult(Self.openResult(
                event: event,
                ok: false,
                errorCode: "MISSING_BACKEND",
                message: "Codex Computer Use MCP backend is not installed"))
            return
        }

        let process = Process()
        process.executableURL = launch.command
        process.arguments = launch.args
        process.currentDirectoryURL = launch.cwd

        let stdin = Pipe()
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = stderr

        let active = ActiveMacMcpSession(
            sessionId: event.sessionid,
            nodeId: event.nodeid,
            process: process,
            input: stdin)
        self.sessions[event.sessionid] = active

        stdout.fileHandleForReading.readabilityHandler = { [weak self] fileHandle in
            let data = fileHandle.availableData
            guard !data.isEmpty else { return }
            Task { await self?.emitOutput(sessionId: event.sessionid, stream: "stdout", data: data, gateway: gateway) }
        }
        stderr.fileHandleForReading.readabilityHandler = { [weak self] fileHandle in
            let data = fileHandle.availableData
            guard !data.isEmpty else { return }
            Task { await self?.emitOutput(sessionId: event.sessionid, stream: "stderr", data: data, gateway: gateway) }
        }
        process.terminationHandler = { [weak self] process in
            Task { await self?.handleTermination(sessionId: event.sessionid, process: process, gateway: gateway) }
        }

        do {
            try process.run()
        } catch {
            stdout.fileHandleForReading.readabilityHandler = nil
            stderr.fileHandleForReading.readabilityHandler = nil
            self.sessions[event.sessionid] = nil
            await gateway.sendMcpSessionOpenResult(Self.openResult(
                event: event,
                ok: false,
                errorCode: "SPAWN_FAILED",
                message: error.localizedDescription))
            return
        }

        await gateway.sendMcpSessionOpenResult(NodeMcpSessionOpenResultParams(
            sessionid: event.sessionid,
            nodeid: event.nodeid,
            serverid: event.serverid,
            ok: true,
            pid: Int(process.processIdentifier),
            error: nil))
        self.logger.info("computer-use MCP session opened pid=\(process.processIdentifier, privacy: .public)")
    }

    func input(_ event: NodeMcpSessionInputEvent) async {
        guard let active = self.sessions[event.sessionid], active.nodeId == event.nodeid else {
            return
        }
        guard let data = Data(base64Encoded: event.database64) else {
            return
        }
        active.input.fileHandleForWriting.write(data)
    }

    func close(_ event: NodeMcpSessionCloseEvent) async {
        guard let active = self.sessions[event.sessionid], active.nodeId == event.nodeid else {
            return
        }
        active.closeRequested = true
        try? active.input.fileHandleForWriting.close()
        if active.process.isRunning {
            active.process.terminate()
        }
    }

    private func emitOutput(sessionId: String, stream: String, data: Data, gateway: GatewayNodeSession) async {
        guard let active = self.sessions[sessionId] else { return }
        let seq = active.nextSeq
        active.nextSeq += 1
        await gateway.sendMcpSessionOutput(NodeMcpSessionOutputParams(
            sessionid: active.sessionId,
            nodeid: active.nodeId,
            seq: seq,
            stream: stream,
            database64: data.base64EncodedString()))
    }

    private func handleTermination(sessionId: String, process: Process, gateway: GatewayNodeSession) async {
        guard let active = self.sessions.removeValue(forKey: sessionId) else { return }
        let ok = active.closeRequested || process.terminationStatus == 0
        let signal = Self.signalName(
            for: process.terminationStatus,
            reason: process.terminationReason)
        await gateway.sendMcpSessionClosed(NodeMcpSessionClosedParams(
            sessionid: active.sessionId,
            nodeid: active.nodeId,
            ok: ok,
            exitcode: AnyCodable(Int(process.terminationStatus)),
            signal: signal.map { AnyCodable($0) },
            error: ok
                ? nil
                : [
                    "code": AnyCodable("PROCESS_EXITED"),
                    "message": AnyCodable("MCP backend exited with status \(process.terminationStatus)"),
                ]))
    }

    private static func signalName(for status: Int32, reason: Process.TerminationReason) -> String? {
        guard reason == .uncaughtSignal else { return nil }
        switch Int(status) {
        case 1: return "SIGHUP"
        case 2: return "SIGINT"
        case 3: return "SIGQUIT"
        case 4: return "SIGILL"
        case 5: return "SIGTRAP"
        case 6: return "SIGABRT"
        case 7: return "SIGEMT"
        case 8: return "SIGFPE"
        case 9: return "SIGKILL"
        case 10: return "SIGBUS"
        case 11: return "SIGSEGV"
        case 12: return "SIGSYS"
        case 13: return "SIGPIPE"
        case 14: return "SIGALRM"
        case 15: return "SIGTERM"
        case 16: return "SIGURG"
        case 17: return "SIGSTOP"
        case 18: return "SIGTSTP"
        case 19: return "SIGCONT"
        case 20: return "SIGCHLD"
        case 21: return "SIGTTIN"
        case 22: return "SIGTTOU"
        case 23: return "SIGIO"
        case 24: return "SIGXCPU"
        case 25: return "SIGXFSZ"
        case 26: return "SIGVTALRM"
        case 27: return "SIGPROF"
        case 28: return "SIGWINCH"
        case 29: return "SIGINFO"
        case 30: return "SIGUSR1"
        case 31: return "SIGUSR2"
        default: return "SIG\(status)"
        }
    }

    private static func openResult(
        event: NodeMcpSessionOpenEvent,
        ok: Bool,
        errorCode: String,
        message: String) -> NodeMcpSessionOpenResultParams
    {
        NodeMcpSessionOpenResultParams(
            sessionid: event.sessionid,
            nodeid: event.nodeid,
            serverid: event.serverid,
            ok: ok,
            pid: nil,
            error: [
                "code": AnyCodable(errorCode),
                "message": AnyCodable(message),
            ])
    }

    private func handlePackageInstallBegin(_ req: BridgeInvokeRequest) throws -> BridgeInvokeResponse {
        let params = try Self.decodeInvokeParams(MacMcpPackageInstallBeginParams.self, from: req)
        guard params.serverId == computerUseServerId else {
            return Self.errorResponse(
                req,
                code: .invalidRequest,
                message: "INVALID_REQUEST: unsupported MCP server")
        }

        if let activeInstall {
            try? FileManager.default.removeItem(at: activeInstall.directory)
        }

        let destination = Self.managedPackageDirectory(
            env: ProcessInfo.processInfo.environment,
            fileManager: .default,
            appSupportRoot: self.appSupportRoot)
        let parent = destination.deletingLastPathComponent()
        let transferDir = parent.appendingPathComponent(
            ".\(computerUsePackageDirName).\(params.transferId).transfer",
            isDirectory: true)
        if FileManager.default.fileExists(atPath: transferDir.path) {
            try FileManager.default.removeItem(at: transferDir)
        }
        try FileManager.default.createDirectory(at: transferDir, withIntermediateDirectories: true)

        self.activeInstall = ActiveMacMcpPackageInstall(
            transferId: params.transferId,
            nodeId: params.nodeId,
            serverId: params.serverId,
            sourcePath: params.sourcePath ?? "gateway-transfer",
            expectedFileCount: params.fileCount,
            expectedTotalBytes: params.totalBytes,
            directory: transferDir)
        return try Self.payloadResponse(
            req,
            MacMcpPackageInstallPayload(
                ok: true,
                transferId: params.transferId,
                serverId: params.serverId,
                fileCount: params.fileCount,
                totalBytes: params.totalBytes))
    }

    private func handlePackageInstallChunk(_ req: BridgeInvokeRequest) throws -> BridgeInvokeResponse {
        let params = try Self.decodeInvokeParams(MacMcpPackageInstallChunkParams.self, from: req)
        guard var activeInstall, activeInstall.transferId == params.transferId else {
            return Self.errorResponse(
                req,
                code: .invalidRequest,
                message: "INVALID_REQUEST: no active package transfer")
        }
        guard let relativePath = Self.safePackageRelativePath(params.relativePath) else {
            return Self.errorResponse(
                req,
                code: .invalidRequest,
                message: "INVALID_REQUEST: unsafe package path")
        }
        guard let data = Data(base64Encoded: params.dataBase64) else {
            return Self.errorResponse(
                req,
                code: .invalidRequest,
                message: "INVALID_REQUEST: package chunk is not base64")
        }

        let destination = Self.packageFileURL(base: activeInstall.directory, relativePath: relativePath)
        try FileManager.default.createDirectory(
            at: destination.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: destination.path) {
            _ = FileManager.default.createFile(atPath: destination.path, contents: nil)
        }
        let handle = try FileHandle(forWritingTo: destination)
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: data)
        if params.executable == true {
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: destination.path)
        }

        activeInstall.files.insert(relativePath)
        activeInstall.totalBytes += UInt64(data.count)
        self.activeInstall = activeInstall
        return try Self.payloadResponse(
            req,
            MacMcpPackageInstallPayload(
                ok: true,
                transferId: params.transferId,
                serverId: activeInstall.serverId,
                fileCount: activeInstall.files.count,
                totalBytes: activeInstall.totalBytes))
    }

    private func handlePackageInstallFinish(_ req: BridgeInvokeRequest) throws -> BridgeInvokeResponse {
        let params = try Self.decodeInvokeParams(MacMcpPackageInstallFinishParams.self, from: req)
        guard let activeInstall, activeInstall.transferId == params.transferId else {
            return Self.errorResponse(
                req,
                code: .invalidRequest,
                message: "INVALID_REQUEST: no active package transfer")
        }
        if let expectedFileCount = activeInstall.expectedFileCount,
           activeInstall.files.count != expectedFileCount
        {
            return Self.errorResponse(
                req,
                code: .invalidRequest,
                message: "INVALID_REQUEST: incomplete package transfer")
        }
        if let expectedTotalBytes = activeInstall.expectedTotalBytes,
           activeInstall.totalBytes != expectedTotalBytes
        {
            return Self.errorResponse(
                req,
                code: .invalidRequest,
                message: "INVALID_REQUEST: package transfer byte count mismatch")
        }
        guard
            Self.resolvePackageLaunchConfig(
                packageDir: activeInstall.directory,
                source: "gateway-transfer",
                fileManager: .default) != nil
        else {
            return Self.errorResponse(
                req,
                code: .invalidRequest,
                message: "INVALID_REQUEST: transferred package does not expose computer-use MCP")
        }
        guard let fingerprint = Self.packageFingerprint(
            packageDir: activeInstall.directory,
            fileManager: .default)
        else {
            return Self.errorResponse(
                req,
                code: .invalidRequest,
                message: "INVALID_REQUEST: transferred package is empty")
        }

        let destination = Self.managedPackageDirectory(
            env: ProcessInfo.processInfo.environment,
            fileManager: .default,
            appSupportRoot: self.appSupportRoot)
        let metadata = MacMcpManagedPackageMetadata(
            source: "gateway-transfer",
            sourcePath: activeInstall.sourcePath,
            sourceFingerprint: fingerprint)
        let metadataData = try JSONEncoder().encode(metadata)
        try metadataData.write(
            to: activeInstall.directory.appendingPathComponent(computerUseManagedMetadataFileName),
            options: [.atomic])
        if FileManager.default.fileExists(atPath: destination.path) {
            try FileManager.default.removeItem(at: destination)
        }
        try FileManager.default.createDirectory(
            at: destination.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        try FileManager.default.moveItem(at: activeInstall.directory, to: destination)
        self.activeInstall = nil

        return try Self.payloadResponse(
            req,
            MacMcpPackageInstallPayload(
                ok: true,
                transferId: params.transferId,
                serverId: activeInstall.serverId,
                fileCount: activeInstall.files.count,
                totalBytes: activeInstall.totalBytes))
    }

    private func handlePackageInstallCancel(_ req: BridgeInvokeRequest) throws -> BridgeInvokeResponse {
        let params = try Self.decodeInvokeParams(MacMcpPackageInstallCancelParams.self, from: req)
        guard let activeInstall, activeInstall.transferId == params.transferId else {
            return Self.errorResponse(
                req,
                code: .invalidRequest,
                message: "INVALID_REQUEST: no active package transfer")
        }
        try? FileManager.default.removeItem(at: activeInstall.directory)
        self.activeInstall = nil
        return try Self.payloadResponse(
            req,
            MacMcpPackageInstallPayload(
                ok: true,
                transferId: params.transferId,
                serverId: activeInstall.serverId,
                fileCount: activeInstall.files.count,
                totalBytes: activeInstall.totalBytes))
    }

    nonisolated static func resolveComputerUseLaunchConfig(
        env: [String: String] = ProcessInfo.processInfo.environment,
        fileManager: FileManager = .default,
        resourceURL: URL? = Bundle.main.resourceURL,
        codexPluginDir: URL = URL(
            fileURLWithPath: "/Applications/Codex.app/Contents/Resources/plugins/openai-bundled/plugins/computer-use"),
        appSupportRoot: URL? = nil) -> MacMcpLaunchConfig?
    {
        if let rawCommand = env[computerUseEnvCommandKey]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !rawCommand.isEmpty
        {
            let command = URL(fileURLWithPath: NSString(string: rawCommand).expandingTildeInPath)
            return MacMcpLaunchConfig(
                command: command,
                args: Self.parseEnvArgs(env[computerUseEnvArgsKey]) ?? ["mcp"],
                cwd: nil,
                source: "env-command")
        }

        if let rawPackageDir = env[computerUseEnvPackageDirKey]?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !rawPackageDir.isEmpty
        {
            let packageDir = URL(fileURLWithPath: NSString(string: rawPackageDir).expandingTildeInPath)
            if let launch = Self.resolvePackageLaunchConfig(
                packageDir: packageDir,
                source: "env-package",
                fileManager: fileManager)
            {
                return launch
            }
        }

        let managedDir = Self.managedPackageDirectory(
            env: env,
            fileManager: fileManager,
            appSupportRoot: appSupportRoot)
        let managedLaunch = Self.resolvePackageLaunchConfig(
            packageDir: managedDir,
            source: "openclaw-managed",
            fileManager: fileManager)
        let source = Self.approvedPackageSources(
            resourceURL: resourceURL,
            codexPluginDir: codexPluginDir,
            fileManager: fileManager).first

        if let managedLaunch {
            guard
                let source,
                Self.managedPackageNeedsRefresh(
                    managedDir: managedDir,
                    source: source,
                    fileManager: fileManager)
            else {
                return managedLaunch
            }
        }

        if let source,
           Self.installManagedPackage(from: source, to: managedDir, fileManager: fileManager),
           let launch = Self.resolvePackageLaunchConfig(
               packageDir: managedDir,
               source: "openclaw-managed:\(source.source)",
               fileManager: fileManager)
        {
            return launch
        }

        return managedLaunch
    }

    private nonisolated static func approvedPackageSources(
        resourceURL: URL?,
        codexPluginDir: URL,
        fileManager: FileManager) -> [MacMcpPackageSource]
    {
        var sources: [MacMcpPackageSource] = []
        if let resourceURL {
            sources.append(MacMcpPackageSource(
                directory: resourceURL.appendingPathComponent(computerUseBundledResourcePath, isDirectory: true),
                source: "openclaw-bundled"))
        }
        sources.append(MacMcpPackageSource(directory: codexPluginDir, source: "codex-bundled"))
        return sources.filter {
            Self.resolvePackageLaunchConfig(
                packageDir: $0.directory,
                source: $0.source,
                fileManager: fileManager) != nil
        }
    }

    private nonisolated static func resolvePackageLaunchConfig(
        packageDir: URL,
        source: String,
        fileManager: FileManager) -> MacMcpLaunchConfig?
    {
        let manifestURL = packageDir.appendingPathComponent(".mcp.json", isDirectory: false)
        guard
            let data = try? Data(contentsOf: manifestURL),
            let manifest = try? JSONDecoder().decode(CodexMcpManifest.self, from: data),
            let server = manifest.mcpServers[computerUseServerId]
        else {
            return nil
        }
        let cwd = Self.resolvePath(server.cwd ?? ".", relativeTo: packageDir)
        let command = Self.resolvePath(server.command, relativeTo: cwd)
        guard fileManager.isExecutableFile(atPath: command.path) else {
            return nil
        }
        return MacMcpLaunchConfig(
            command: command,
            args: server.args ?? [],
            cwd: cwd,
            source: source)
    }

    private nonisolated static func managedPackageDirectory(
        env: [String: String],
        fileManager: FileManager,
        appSupportRoot: URL?) -> URL
    {
        if let rawInstallDir = env[computerUseEnvInstallDirKey]?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !rawInstallDir.isEmpty
        {
            return URL(fileURLWithPath: NSString(string: rawInstallDir).expandingTildeInPath)
        }
        let base = if let appSupportRoot {
            appSupportRoot
        } else if let applicationSupportRoot = fileManager
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first
        {
            applicationSupportRoot.appendingPathComponent("OpenClaw", isDirectory: true)
        } else {
            fileManager.homeDirectoryForCurrentUser
                .appendingPathComponent("Library", isDirectory: true)
                .appendingPathComponent("Application Support", isDirectory: true)
                .appendingPathComponent("OpenClaw", isDirectory: true)
        }
        return base
            .appendingPathComponent(computerUseAppSupportDirName, isDirectory: true)
            .appendingPathComponent(computerUsePackageDirName, isDirectory: true)
    }

    private nonisolated static func managedPackageNeedsRefresh(
        managedDir: URL,
        source: MacMcpPackageSource,
        fileManager: FileManager) -> Bool
    {
        guard let sourceFingerprint = packageFingerprint(
            packageDir: source.directory,
            fileManager: fileManager)
        else {
            return false
        }
        let metadataURL = managedDir.appendingPathComponent(
            computerUseManagedMetadataFileName,
            isDirectory: false)
        guard
            let data = try? Data(contentsOf: metadataURL),
            let metadata = try? JSONDecoder().decode(MacMcpManagedPackageMetadata.self, from: data)
        else {
            return true
        }
        if metadata.source == "gateway-transfer" {
            return false
        }
        return metadata != MacMcpManagedPackageMetadata(
            source: source.source,
            sourcePath: source.directory.path,
            sourceFingerprint: sourceFingerprint)
    }

    private nonisolated static func installManagedPackage(
        from source: MacMcpPackageSource,
        to destination: URL,
        fileManager: FileManager) -> Bool
    {
        guard let sourceFingerprint = packageFingerprint(
            packageDir: source.directory,
            fileManager: fileManager)
        else {
            return false
        }
        let parent = destination.deletingLastPathComponent()
        let temp = parent.appendingPathComponent(
            ".\(destination.lastPathComponent).\(UUID().uuidString).tmp",
            isDirectory: true)

        do {
            try fileManager.createDirectory(at: parent, withIntermediateDirectories: true)
            if fileManager.fileExists(atPath: temp.path) {
                try fileManager.removeItem(at: temp)
            }
            try fileManager.copyItem(at: source.directory, to: temp)
            let metadata = MacMcpManagedPackageMetadata(
                source: source.source,
                sourcePath: source.directory.path,
                sourceFingerprint: sourceFingerprint)
            let metadataData = try JSONEncoder().encode(metadata)
            try metadataData.write(
                to: temp.appendingPathComponent(computerUseManagedMetadataFileName, isDirectory: false),
                options: [.atomic])

            if fileManager.fileExists(atPath: destination.path) {
                try fileManager.removeItem(at: destination)
            }
            try fileManager.moveItem(at: temp, to: destination)
            return true
        } catch {
            try? fileManager.removeItem(at: temp)
            return false
        }
    }

    private nonisolated static func packageFingerprint(
        packageDir: URL,
        fileManager: FileManager) -> MacMcpPackageFingerprint?
    {
        guard let enumerator = fileManager.enumerator(
            at: packageDir,
            includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey, .contentModificationDateKey],
            options: [],
            errorHandler: nil)
        else {
            return nil
        }
        var fileCount = 0
        var totalSize: UInt64 = 0
        var latestModifiedAt: TimeInterval = 0
        for case let url as URL in enumerator {
            guard let values = try? url.resourceValues(forKeys: [
                .isRegularFileKey,
                .fileSizeKey,
                .contentModificationDateKey,
            ]), values.isRegularFile == true
            else {
                continue
            }
            fileCount += 1
            totalSize += UInt64(values.fileSize ?? 0)
            latestModifiedAt = max(
                latestModifiedAt,
                values.contentModificationDate?.timeIntervalSince1970 ?? 0)
        }
        guard fileCount > 0 else { return nil }
        return MacMcpPackageFingerprint(
            fileCount: fileCount,
            totalSize: totalSize,
            latestModifiedAt: latestModifiedAt)
    }

    private nonisolated static func decodeInvokeParams<T: Decodable>(
        _ type: T.Type,
        from req: BridgeInvokeRequest) throws -> T
    {
        guard let paramsJSON = req.paramsJSON, let data = paramsJSON.data(using: .utf8) else {
            throw NSError(domain: "MacComputerUseMcpHost", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "INVALID_REQUEST: missing params",
            ])
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    private nonisolated static func payloadResponse(
        _ req: BridgeInvokeRequest,
        _ payload: some Encodable) throws -> BridgeInvokeResponse
    {
        let data = try JSONEncoder().encode(payload)
        return BridgeInvokeResponse(
            id: req.id,
            ok: true,
            payloadJSON: String(data: data, encoding: .utf8))
    }

    private nonisolated static func errorResponse(
        _ req: BridgeInvokeRequest,
        code: OpenClawNodeErrorCode,
        message: String) -> BridgeInvokeResponse
    {
        BridgeInvokeResponse(
            id: req.id,
            ok: false,
            error: OpenClawNodeError(code: code, message: message))
    }

    private nonisolated static func safePackageRelativePath(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.hasPrefix("/") else { return nil }
        let parts = trimmed.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        guard !parts.isEmpty else { return nil }
        guard !parts.contains(where: { $0 == "." || $0 == ".." }) else { return nil }
        guard !parts.contains(computerUseManagedMetadataFileName) else { return nil }
        return parts.joined(separator: "/")
    }

    private nonisolated static func packageFileURL(base: URL, relativePath: String) -> URL {
        relativePath
            .split(separator: "/", omittingEmptySubsequences: true)
            .reduce(base) { partial, component in
                partial.appendingPathComponent(String(component), isDirectory: false)
            }
    }

    private nonisolated static func parseEnvArgs(_ raw: String?) -> [String]? {
        guard let raw, let data = raw.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String]
    }

    private nonisolated static func resolvePath(_ raw: String, relativeTo base: URL) -> URL {
        let expanded = NSString(string: raw).expandingTildeInPath
        if expanded.hasPrefix("/") {
            return URL(fileURLWithPath: expanded)
        }
        return base.appendingPathComponent(expanded)
    }
}
