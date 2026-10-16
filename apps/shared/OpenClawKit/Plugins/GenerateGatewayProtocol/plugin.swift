import Foundation
import PackagePlugin

@main
struct GenerateGatewayProtocol: BuildToolPlugin {
    func createBuildCommands(context: PluginContext, target _: Target) throws -> [Command] {
        let root = context.package.directoryURL.appending(path: "../../..").standardizedFileURL
        let outputDirectory = context.pluginWorkDirectoryURL
        // Xcode shares this directory across iOS and watchOS. A prebuild avoids
        // duplicate output producers; the generator owns input/output caching.
        return try [.prebuildCommand(
            displayName: "Generate Gateway protocol models",
            executable: self.nodeExecutable(root: root, workDirectory: outputDirectory),
            arguments: [
                root.appending(path: "scripts/prepare-native-protocol.mjs").path,
                "--language", "swift",
                "--out", outputDirectory.path,
            ],
            outputFilesDirectory: outputDirectory)]
    }

    /// SwiftPM runs prebuild commands with an empty environment, where version-manager shims
    /// (mise, asdf, Volta) cannot find their configuration. This plugin process still has the
    /// caller's environment, so each candidate reports the binary it actually runs.
    private func nodeExecutable(root: URL, workDirectory: URL) throws -> URL {
        let path = ProcessInfo.processInfo.environment["PATH"] ?? ""
        var seen = Set<String>()
        let candidates = (path.split(separator: ":").map { String($0) + "/node" }
            + ["/opt/homebrew/bin/node", "/usr/local/bin/node"])
            .filter { seen.insert($0).inserted && FileManager.default.isExecutableFile(atPath: $0) }
        var unsupported: [String] = []
        var unusable: [String] = []
        var required: String?
        for candidate in candidates {
            let probe: NodeProbe
            do {
                probe = try Self.probe(candidate, root: root, workDirectory: workDirectory)
            } catch {
                unusable.append("\(candidate) (\(error.localizedDescription))")
                continue
            }
            guard probe.supported else {
                unsupported.append("\(candidate) (\(probe.version))")
                required = probe.required
                continue
            }
            // Keep a plain binary's own path; replace a launcher with the binary it starts.
            let resolved = URL(fileURLWithPath: candidate).resolvingSymlinksInPath().path
            return URL(fileURLWithPath: resolved == probe.execPath ? candidate : probe.execPath)
        }
        var message = "Node.js is required to build the Gateway protocol models."
        if let required {
            message += " OpenClaw requires \(required); found \(unsupported.joined(separator: ", "))."
        }
        if !unusable.isEmpty {
            message += " Could not run \(unusable.joined(separator: ", ")) in \(root.path)."
        }
        throw NSError(
            domain: "GenerateGatewayProtocol",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: message])
    }

    private struct NodeProbe: Decodable {
        let execPath: String
        let version: String
        let supported: Bool
        let required: String
    }

    /// The repository's `node-version.mjs` owns the supported Node range.
    private static let probeScript = """
    import(require("node:url").pathToFileURL(process.argv[1]).href).then((node) => console.log(JSON.stringify({
      execPath: process.execPath,
      version: process.version,
      supported: node.isSupportedOpenClawNodeVersion(process.version),
      required: node.SUPPORTED_NODE_VERSIONS,
    })));
    """

    private static func probe(_ candidate: String, root: URL, workDirectory: URL) throws -> NodeProbe {
        let stderrURL = workDirectory.appending(path: "node-probe-\(UUID().uuidString).stderr")
        let started = ProcessInfo.processInfo.systemUptime
        func failure(_ reason: String) -> NSError {
            let elapsed = String(format: "%.3f", ProcessInfo.processInfo.systemUptime - started)
            var message = "\(reason) after \(elapsed)s"
            if let stderr = try? FileHandle(forReadingFrom: stderrURL) {
                defer { try? stderr.close() }
                if let data = try? stderr.read(upToCount: 4096), !data.isEmpty {
                    message += "; stderr: " + String(decoding: data, as: UTF8.self)
                }
            }
            return NSError(
                domain: "GenerateGatewayProtocol",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: message])
        }
        // SwiftPM does not surface the plugin's stderr. A file also avoids pipe backpressure.
        guard FileManager.default.createFile(atPath: stderrURL.path, contents: nil) else {
            throw failure("could not create stderr capture")
        }
        defer { try? FileManager.default.removeItem(at: stderrURL) }
        let stderr = try FileHandle(forWritingTo: stderrURL)
        defer { try? stderr.close() }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: candidate)
        process.arguments = ["--eval", self.probeScript, root.appending(path: "node-version.mjs").path]
        // Version managers select per-project versions from the working directory.
        process.currentDirectoryURL = root
        // The prebuild never sees startup flags; inherited ones could break or pause this probe.
        var environment = ProcessInfo.processInfo.environment
        environment["NODE_OPTIONS"] = nil
        process.environment = environment
        let output = Pipe()
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = output
        process.standardError = stderr
        let exited = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in exited.signal() }
        do {
            try process.run()
        } catch {
            throw failure("launch failed: \(error.localizedDescription)")
        }
        // A stalled launcher must not hang build planning; skip it like any other unusable candidate.
        // The plugin sandbox may refuse the signal, leaving the launcher to exit on its own.
        guard exited.wait(timeout: .now() + .seconds(30)) == .success else {
            kill(process.processIdentifier, SIGKILL)
            throw failure("timed out waiting for exit (30s limit)")
        }
        guard process.terminationStatus == 0 else {
            let reason = process.terminationReason == .uncaughtSignal ? "terminated by signal" : "exited with status"
            throw failure("\(reason) \(process.terminationStatus)")
        }
        // Read without blocking: a descendant of the exited launcher may still hold stdout open.
        let handle = output.fileHandleForReading
        _ = fcntl(handle.fileDescriptor, F_SETFL, O_NONBLOCK)
        let data: Data
        do {
            data = try handle.readToEnd() ?? Data()
        } catch {
            throw failure("stdout read failed: \(error.localizedDescription)")
        }
        do {
            return try JSONDecoder().decode(NodeProbe.self, from: data)
        } catch {
            throw failure("JSON decode failed: \(error.localizedDescription)")
        }
    }
}
