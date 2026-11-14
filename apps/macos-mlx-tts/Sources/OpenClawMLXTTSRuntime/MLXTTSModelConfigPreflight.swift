import Foundation

enum MLXTTSModelConfigPreflight {
    static func prepare(
        repo: String,
        resolveConfig: @Sendable (String) async throws -> URL,
        recoverModel: @Sendable (String) async throws -> Void) async throws
    {
        let expanded = (repo as NSString).expandingTildeInPath
        let localURL = URL(fileURLWithPath: expanded)
        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: localURL.path, isDirectory: &isDirectory),
           isDirectory.boolValue,
           FileManager.default.fileExists(atPath: localURL.appendingPathComponent("config.json").path)
        {
            return
        }

        let configURL = try await resolveConfig(repo)
        let data = try Data(contentsOf: configURL)
        do {
            _ = try JSONSerialization.jsonObject(with: data)
        } catch {
            try Task.checkCancellation()
            try await recoverModel(repo)
        }
    }
}
