import Darwin
import Foundation
import OSLog

extension BundledRuntime {
    private static let shimSignature = "# OpenClaw.app managed CLI (bundled runtime)"
    private static let macCLITargetAttribute = "ai.openclaw.mac-cli-target"
    private static let cliLogger = Logger(subsystem: "ai.openclaw", category: "bundled-runtime.cli")

    func installCLI(
        bundle: Bundle,
        profile: AppProfile,
        homeDirectory: URL,
        allowsPersistentIntegration: Bool,
        environment: [String: String] = ProcessInfo.processInfo.environment)
    {
        let fileManager = FileManager.default
        let state = profile.stateDirectoryURL(homeDirectory: homeDirectory)
        let bin = state.appendingPathComponent("bin")
        let command = bin.appendingPathComponent("openclaw")
        do {
            guard command.resolvingSymlinksInPath().path.hasPrefix(
                homeDirectory.resolvingSymlinksInPath().path + "/")
            else { throw CocoaError(.fileWriteNoPermission) }
            let attributes = try? fileManager.attributesOfItem(atPath: command.path)
            let existing = try? Self.cliFile(command)
            if attributes == nil || (attributes?[.type] as? FileAttributeType == .typeRegular
                && existing.map { Self.isManagedShim($0.text, stateDirectory: state) } == true)
            {
                try fileManager.createDirectory(at: bin, withIntermediateDirectories: true)
                let terminal = homeDirectory.appendingPathComponent(".openclaw/bin/openclaw")
                let mayClaim: Bool = if command.path != terminal.path || existing != nil {
                    true
                } else {
                    try Self.terminalDefaultBin(
                        command: command, homeDirectory: homeDirectory, environment: environment) != nil
                }
                if mayClaim {
                    let shim = Self.cliShim(profile: profile, homeDirectory: homeDirectory)
                    if existing?.text != shim || existing.map({ $0.metadata.st_mode & 0o777 != 0o755 }) == true {
                        try Self.writeCLIFile(shim, to: command, root: homeDirectory, previous: existing, mode: 0o755)
                    }
                    if allowsPersistentIntegration,
                       let terminalBin = try Self.terminalDefaultBin(
                           command: command, homeDirectory: homeDirectory, environment: environment)
                    {
                        Self.installShellPath(bin: terminalBin, homeDirectory: homeDirectory, environment: environment)
                    } else {
                        Self.cliLogger.notice("Shell PATH unchanged; run \(command.path, privacy: .public)")
                    }
                }
            } else {
                Self.cliLogger.warning("Keeping operator-managed terminal CLI at \(command.path, privacy: .public)")
            }
        } catch {
            Self.cliLogger.warning("Terminal CLI setup failed: \(error.localizedDescription, privacy: .public)")
        }

        do {
            try Self.updateMacCLILink(
                bundle: bundle,
                profile: profile,
                homeDirectory: homeDirectory,
                createIfMissing: true,
                allowsPersistentIntegration: allowsPersistentIntegration)
        } catch {
            Self.cliLogger.warning("macOS CLI link setup failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    static func refreshOwnedMacCLILink(
        bundle: Bundle = .main,
        profile: AppProfile = .current,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser,
        allowsPersistentIntegration: Bool)
    {
        guard bundle.bundleURL.pathExtension == "app" else { return }
        do {
            try self.updateMacCLILink(
                bundle: bundle,
                profile: profile,
                homeDirectory: homeDirectory,
                createIfMissing: false,
                allowsPersistentIntegration: allowsPersistentIntegration)
        } catch {
            self.cliLogger.warning("macOS CLI link refresh failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private static func updateMacCLILink(
        bundle: Bundle,
        profile: AppProfile,
        homeDirectory: URL,
        createIfMissing: Bool,
        allowsPersistentIntegration: Bool) throws
    {
        // The Bun shim uses portable seeded state; this link depends on a persistent app location.
        guard allowsPersistentIntegration else { return }
        let fileManager = FileManager.default
        let source = bundle.bundleURL.appendingPathComponent("Contents/MacOS/openclaw-mac")
        guard fileManager.isExecutableFile(atPath: source.path) else {
            throw CocoaError(.fileNoSuchFile, userInfo: [NSFilePathErrorKey: source.path])
        }
        let command = profile.stateDirectoryURL(homeDirectory: homeDirectory).appendingPathComponent("bin/openclaw-mac")
        let existing = try? fileManager.destinationOfSymbolicLink(atPath: command.path)
        if let existing {
            // Matching an unmarked link is not ownership; leave it unadopted.
            if existing == source.path { return }
            guard self.ownsMacCLILink(command, target: existing) else {
                self.cliLogger.warning("Keeping operator-managed macOS CLI link at \(command.path, privacy: .public)")
                return
            }
        } else {
            guard createIfMissing, !fileManager.fileExists(atPath: command.path) else { return }
        }
        let temporary = command.deletingLastPathComponent().appendingPathComponent(".openclaw-mac-\(UUID().uuidString)")
        defer { try? fileManager.removeItem(at: temporary) }
        try fileManager.createSymbolicLink(at: temporary, withDestinationURL: source)
        let target = Data(source.path.utf8)
        let marked = target.withUnsafeBytes {
            setxattr(temporary.path, self.macCLITargetAttribute, $0.baseAddress, target.count, 0, XATTR_NOFOLLOW)
        }
        guard marked == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        if let existing {
            guard (try? fileManager.destinationOfSymbolicLink(atPath: command.path)) == existing,
                  self.ownsMacCLILink(command, target: existing)
            else { return }
            guard rename(temporary.path, command.path) == 0 else {
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
        } else if renamex_np(temporary.path, command.path, UInt32(RENAME_EXCL)) != 0, errno != EEXIST {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
    }

    private static func ownsMacCLILink(_ link: URL, target: String) -> Bool {
        let expected = Array(target.utf8)
        var stored = [UInt8](repeating: 0, count: expected.count)
        let size = stored.withUnsafeMutableBytes {
            getxattr(link.path, self.macCLITargetAttribute, $0.baseAddress, $0.count, 0, XATTR_NOFOLLOW)
        }
        return size == expected.count && stored == expected
    }

    private static func cliShim(profile: AppProfile, homeDirectory: URL) -> String {
        let current = Self(root: profile.stateDirectoryURL(homeDirectory: homeDirectory)
            .appendingPathComponent("runtime/current"))
        let profileLine = "export OPENCLAW_PROFILE=\"${OPENCLAW_PROFILE:-\(profile.name ?? "default")}\"\n"
        let cli = current.packageRoot.appendingPathComponent("openclaw.mjs")
        return """
        #!/bin/sh
        \(Self.shimSignature)
        \(profileLine)export OPENCLAW_SQLITE_LIBRARY=\(Self.shellQuote(current.sqliteLibrary.path))
        exec \(Self.shellQuote(current.bun.path)) \(Self.shellQuote(cli.path)) "$@"

        """
    }

    /// Preserve explicit command selection and configured profiles, including offline installations.
    private static func terminalDefaultBin(
        command: URL, homeDirectory: URL, environment: [String: String]) throws -> URL?
    {
        let fileManager = FileManager.default
        let bin = homeDirectory.appendingPathComponent(".openclaw/bin")
        let terminal = bin.appendingPathComponent("openclaw")
        let paths = (environment["PATH"] ?? "").components(separatedBy: ":").filter { !$0.isEmpty }
        if let selected = CommandResolver.findExecutable(named: "openclaw", searchPaths: paths),
           URL(fileURLWithPath: selected).resolvingSymlinksInPath() != command.resolvingSymlinksInPath()
        {
            Self.cliLogger.notice("Keeping selected terminal command; this Gateway: \(command.path, privacy: .public)")
            return nil
        }
        let state = command.deletingLastPathComponent().deletingLastPathComponent()
        if let attributes = try? fileManager.attributesOfItem(atPath: terminal.path) {
            if command.path == terminal.path,
               attributes[.type] as? FileAttributeType == .typeRegular,
               let existing = try Self.cliFile(command), Self.isManagedShim(existing.text, stateDirectory: state)
            { return bin }
            if attributes[.type] as? FileAttributeType == .typeSymbolicLink,
               (try? fileManager.destinationOfSymbolicLink(atPath: terminal.path)) == command.path
            { return bin }
            Self.cliLogger.notice("Terminal default unchanged; this Gateway: \(command.path, privacy: .public)")
            return nil
        }
        for name in try fileManager.contentsOfDirectory(atPath: homeDirectory.path)
            where name == ".openclaw" || name.hasPrefix(".openclaw-")
        {
            let other = homeDirectory.appendingPathComponent(name)
            if other.path != state.path,
               (try? fileManager.attributesOfItem(atPath: other.appendingPathComponent("openclaw.json").path)) != nil
            {
                Self.cliLogger
                    .notice("Configured profile owns terminal default; this Gateway: \(command.path, privacy: .public)")
                return nil
            }
        }
        if command.path == terminal.path { return bin }
        guard bin.resolvingSymlinksInPath().path.hasPrefix(homeDirectory.resolvingSymlinksInPath().path + "/") else {
            throw CocoaError(.fileWriteNoPermission)
        }
        try fileManager.createDirectory(at: bin, withIntermediateDirectories: true)
        try fileManager.createSymbolicLink(at: terminal, withDestinationURL: command)
        return bin
    }

    static func isManagedShim(_ text: String, stateDirectory: URL) -> Bool {
        if text.hasPrefix("#!/bin/sh\n\(self.shimSignature)\n") { return true }
        return self.legacyManagedNodeCommand(text, stateDirectory: stateDirectory) != nil
    }

    static func legacyManagedNodeCommand(_ text: String, stateDirectory: URL) -> [String]? {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        guard lines.count == 4, lines[0] == "#!/usr/bin/env bash", lines[1] == "set -euo pipefail",
              lines[3].isEmpty
        else { return nil }
        let prefix = "exec \"\(stateDirectory.path)/tools/node/bin/node\" \""
        let suffix = "/lib/node_modules/openclaw/dist/entry.js\" \"$@\""
        guard lines[2].hasPrefix(prefix), lines[2].hasSuffix(suffix) else { return nil }
        let packagePrefix = String(lines[2].dropFirst(prefix.count).dropLast(suffix.count))
        // install-cli.sh owns node and versioned node-* trees; a custom script stays operator-owned.
        let tools = stateDirectory.appendingPathComponent("tools").path + "/"
        guard packagePrefix.hasPrefix(tools) else { return nil }
        let node = packagePrefix.dropFirst(tools.count)
        guard node == "node" || node.hasPrefix("node-"), !node.contains("/"), !node.contains("\"") else {
            return nil
        }
        return [
            stateDirectory.appendingPathComponent("tools/node/bin/node").path,
            packagePrefix + "/lib/node_modules/openclaw/dist/entry.js",
        ]
    }

    private static func shellQuote(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    private struct CLIFile {
        let text: String
        let metadata: stat

        func matches(_ other: CLIFile) -> Bool {
            self.text == other.text && self.metadata.st_dev == other.metadata.st_dev &&
                self.metadata.st_ino == other.metadata.st_ino && self.metadata.st_mode == other.metadata.st_mode &&
                self.metadata.st_uid == other.metadata.st_uid &&
                self.metadata.st_mtimespec.tv_sec == other.metadata.st_mtimespec.tv_sec &&
                self.metadata.st_mtimespec.tv_nsec == other.metadata.st_mtimespec.tv_nsec &&
                self.metadata.st_ctimespec.tv_sec == other.metadata.st_ctimespec.tv_sec &&
                self.metadata.st_ctimespec.tv_nsec == other.metadata.st_ctimespec.tv_nsec
        }
    }

    /// Retain the regular file while reading; never inspect through a replacement symlink.
    private static func cliFile(_ file: URL) throws -> CLIFile? {
        let descriptor = open(file.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        if descriptor < 0, errno == ENOENT { return nil }
        guard descriptor >= 0 else { throw POSIXError(.EACCES) }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0, metadata.st_mode & S_IFMT == S_IFREG,
              metadata.st_uid == getuid(), metadata.st_nlink == 1, metadata.st_size <= 1024 * 1024,
              let data = try handle.readToEnd(), let text = String(data: data, encoding: .utf8)
        else { throw CocoaError(.fileReadNoPermission) }
        return CLIFile(text: text, metadata: metadata)
    }

    /// Stage permissions before publication; compare identity and bytes immediately before the rename.
    private static func writeCLIFile(_ text: String, to file: URL, root: URL, previous: CLIFile?, mode: mode_t) throws {
        let physical = file.resolvingSymlinksInPath()
        guard physical.path.hasPrefix(root.resolvingSymlinksInPath().path + "/") else {
            throw CocoaError(.fileWriteNoPermission)
        }
        let temporary = file.deletingLastPathComponent().appendingPathComponent(".openclaw-cli-\(UUID().uuidString)")
        let descriptor = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode)
        guard descriptor >= 0 else { throw POSIXError(.EACCES) }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close()
            try? FileManager.default.removeItem(at: temporary)
        }
        try handle.write(contentsOf: Data(text.utf8))
        guard fchmod(descriptor, mode) == 0 else { throw POSIXError(.EACCES) }
        let current = try self.cliFile(file)
        guard file.resolvingSymlinksInPath() == physical else { throw CocoaError(.fileWriteNoPermission) }
        if let previous {
            guard let current, previous.matches(current) else { throw CocoaError(.fileWriteFileExists) }
            guard rename(temporary.path, file.path) == 0 else { throw POSIXError(.EIO) }
        } else {
            guard current == nil, renamex_np(temporary.path, file.path, UInt32(RENAME_EXCL)) == 0 else {
                throw CocoaError(.fileWriteFileExists)
            }
        }
    }

    private static func installShellPath(bin: URL, homeDirectory: URL, environment: [String: String]) {
        let fileManager = FileManager.default
        let exists: (String) -> Bool = { fileManager.fileExists(atPath: homeDirectory.appendingPathComponent($0).path) }
        let bashLogin = exists(".bash_profile") ? ".bash_profile" : exists(".bash_login") ? ".bash_login" : ".profile"
        let zsh = environment["ZDOTDIR"].map { URL(fileURLWithPath: $0.isEmpty ? "/" : $0) } ?? homeDirectory
        let fish = environment["XDG_CONFIG_HOME"].flatMap { $0.hasPrefix("/") ? URL(fileURLWithPath: $0) : nil }
            ?? homeDirectory.appendingPathComponent(".config")
        let shell = URL(fileURLWithPath: environment["SHELL"] ?? "/bin/zsh").lastPathComponent
        guard ["bash", "zsh", "fish", "sh"].contains(shell) else {
            Self.cliLogger.warning("Unrecognized shell; add \(bin.path, privacy: .public) to your shell PATH manually")
            return
        }
        var candidates: [(URL, URL, String)] = [
            (homeDirectory.appendingPathComponent(".bashrc"), homeDirectory, "bash"),
            (homeDirectory.appendingPathComponent(bashLogin), homeDirectory, "bash"),
            (zsh.appendingPathComponent(".zshrc"), zsh, "zsh"),
            (zsh.appendingPathComponent(".zprofile"), zsh, "zsh"),
            (
                fish.appendingPathComponent("fish/config.fish"),
                environment["XDG_CONFIG_HOME"]?.hasPrefix("/") == true ? fish : homeDirectory,
                "fish"),
        ]
        if shell == "sh", bashLogin != ".profile" {
            candidates.append((homeDirectory.appendingPathComponent(".profile"), homeDirectory, "sh"))
        }
        let escaped = bin.path
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "$", with: "\\$")
            .replacingOccurrences(of: "`", with: "\\`")
        for (file, root, targetShell) in candidates
            where shell == targetShell || (shell == "sh" && file.lastPathComponent == ".profile") || fileManager
            .fileExists(atPath: file.path)
        {
            do {
                let resolved = file.resolvingSymlinksInPath()
                guard resolved.path.hasPrefix(root.resolvingSymlinksInPath().path + "/") else {
                    throw CocoaError(.fileWriteNoPermission)
                }
                let previous = try Self.cliFile(file)
                let current = previous?.text ?? ""
                let line = targetShell == "fish"
                    ? "if not type -q openclaw; fish_add_path --path --append -- \"\(escaped)\"; end"
                    : "if ! command -v openclaw >/dev/null 2>&1; then export PATH=\"$PATH:\(escaped)\"; fi"
                if current.components(separatedBy: "\n").contains(line) { continue }
                try fileManager.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
                let separator = current.isEmpty || current.hasSuffix("\n") ? "" : "\n"
                try Self.writeCLIFile(
                    current + separator + line + "\n",
                    to: file,
                    root: root,
                    previous: previous,
                    mode: previous.map { $0.metadata.st_mode & 0o777 } ?? 0o644)
            } catch {
                Self.cliLogger.warning("""
                Shell PATH setup skipped \(file.path, privacy: .public): \
                \(error.localizedDescription, privacy: .public). \
                Add \(bin.path, privacy: .public) to PATH manually.
                """)
            }
        }
    }
}
