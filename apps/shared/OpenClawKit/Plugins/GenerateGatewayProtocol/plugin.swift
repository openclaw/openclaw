import Foundation
import PackagePlugin

private struct ProtocolInputs: Decodable {
    let directories: [String]
    let files: [String]
}

@main
struct GenerateGatewayProtocol: BuildToolPlugin {
    func createBuildCommands(context: PluginContext, target: Target) throws -> [Command] {
        let root = context.package.directoryURL.appending(path: "../../..").standardizedFileURL
        let manifest = root.appending(path: "scripts/native-protocol-inputs.json")
        let inputs = try JSONDecoder().decode(ProtocolInputs.self, from: Data(contentsOf: manifest))
        var inputFiles = inputs.files.map { root.appending(path: $0) }
        for directory in inputs.directories {
            try self.collectInputs(in: root.appending(path: directory), into: &inputFiles)
        }

        let outputDirectory = context.pluginWorkDirectoryURL
        return try [.buildCommand(
            displayName: "Generate Gateway protocol models",
            executable: self.nodeExecutable(),
            arguments: [
                root.appending(path: "scripts/prepare-native-protocol.mjs").path,
                "--language", "swift",
                "--out", outputDirectory.path,
            ],
            inputFiles: Array(Set(inputFiles)).sorted { $0.path < $1.path },
            outputFiles: [outputDirectory.appending(path: "GatewayModels.swift")])]
    }

    private func collectInputs(in directory: URL, into inputs: inout [URL]) throws {
        for file in try FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles])
        {
            if file.lastPathComponent == "node_modules" {
                continue
            }
            if try file.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true {
                try self.collectInputs(in: file, into: &inputs)
            } else if ["ts", "mts", "mjs", "json"].contains(file.pathExtension),
                      !file.lastPathComponent.contains(".test."),
                      !file.lastPathComponent.contains(".spec.")
            {
                inputs.append(file)
            }
        }
    }

    private func nodeExecutable() throws -> URL {
        let path = ProcessInfo.processInfo.environment["PATH"] ?? ""
        let candidates = path.split(separator: ":").map { String($0) + "/node" }
            + ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
        guard let executable = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            throw NSError(
                domain: "GenerateGatewayProtocol",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Node.js is required to build the Gateway protocol models."])
        }
        return URL(fileURLWithPath: executable)
    }
}
