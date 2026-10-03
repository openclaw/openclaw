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
            executable: self.nodeExecutable(),
            arguments: [
                root.appending(path: "scripts/prepare-native-protocol.mjs").path,
                "--language", "swift",
                "--out", outputDirectory.path,
            ],
            outputFilesDirectory: outputDirectory)]
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
