import Foundation

enum MullusiEnv {
    static func path(_ key: String) -> String? {
        // Normalize env overrides once so UI + file IO stay consistent.
        guard let raw = getenv(key) else { return nil }
        let value = String(cString: raw).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty
        else {
            return nil
        }
        return value
    }
}

enum MullusiPaths {
    private static let configPathEnv = ["MULLUSI_CONFIG_PATH"]
    private static let stateDirEnv = ["MULLUSI_STATE_DIR"]

    static var stateDirURL: URL {
        for key in self.stateDirEnv {
            if let override = MullusiEnv.path(key) {
                return URL(fileURLWithPath: override, isDirectory: true)
            }
        }
        let home = FileManager().homeDirectoryForCurrentUser
        return home.appendingPathComponent(".mullusi", isDirectory: true)
    }

    private static func resolveConfigCandidate(in dir: URL) -> URL? {
        let candidates = [
            dir.appendingPathComponent("mullusi.json"),
        ]
        return candidates.first(where: { FileManager().fileExists(atPath: $0.path) })
    }

    static var configURL: URL {
        for key in self.configPathEnv {
            if let override = MullusiEnv.path(key) {
                return URL(fileURLWithPath: override)
            }
        }
        let stateDir = self.stateDirURL
        if let existing = self.resolveConfigCandidate(in: stateDir) {
            return existing
        }
        return stateDir.appendingPathComponent("mullusi.json")
    }

    static var workspaceURL: URL {
        self.stateDirURL.appendingPathComponent("workspace", isDirectory: true)
    }
}
