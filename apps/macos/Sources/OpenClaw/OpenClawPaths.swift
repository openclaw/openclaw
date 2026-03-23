import Foundation

enum OpenClawEnv {
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

enum OpenClawPaths {
    private static let configPathEnv = ["OPENCLAW_CONFIG_PATH"]
    private static let stateDirEnv = ["OPENCLAW_STATE_DIR"]

    private static func legacyStateDirURL(home: URL) -> URL {
        home.appendingPathComponent(AppFlavor.current.defaultStateDirName, isDirectory: true)
    }

    private static func consumerPreferredStateDirURL(home: URL) -> URL {
        home
            .appendingPathComponent("Library/Application Support", isDirectory: true)
            .appendingPathComponent(AppFlavor.current.appName, isDirectory: true)
            .appendingPathComponent(".openclaw", isDirectory: true)
    }

    static var stateDirURL: URL {
        for key in self.stateDirEnv {
            if let override = OpenClawEnv.path(key) {
                return URL(fileURLWithPath: override, isDirectory: true)
            }
        }
        let home = FileManager().homeDirectoryForCurrentUser
        let legacy = self.legacyStateDirURL(home: home)
        guard AppFlavor.current.isConsumer else { return legacy }

        // Consumer launch agents already use Application Support profile paths.
        // Prefer that canonical location so the app and gateway share one config,
        // but keep a legacy fallback for older local dot-dir installs.
        let preferred = self.consumerPreferredStateDirURL(home: home)
        if FileManager().fileExists(atPath: preferred.path) {
            return preferred
        }
        if FileManager().fileExists(atPath: legacy.path) {
            return legacy
        }
        return preferred
    }

    private static func resolveConfigCandidate(in dir: URL) -> URL? {
        let candidates = [
            dir.appendingPathComponent("openclaw.json"),
        ]
        return candidates.first(where: { FileManager().fileExists(atPath: $0.path) })
    }

    static var configURL: URL {
        for key in self.configPathEnv {
            if let override = OpenClawEnv.path(key) {
                return URL(fileURLWithPath: override)
            }
        }
        let stateDir = self.stateDirURL
        if let existing = self.resolveConfigCandidate(in: stateDir) {
            return existing
        }
        return stateDir.appendingPathComponent("openclaw.json")
    }

    static var workspaceURL: URL {
        self.stateDirURL.appendingPathComponent("workspace", isDirectory: true)
    }
}
