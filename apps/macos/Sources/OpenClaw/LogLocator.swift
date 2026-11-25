import Foundation

enum LogLocator {
    private static var logDir: URL {
        if let override = ProcessInfo.processInfo.environment["OPENCLAW_LOG_DIR"],
           !override.isEmpty
        {
            return URL(fileURLWithPath: override)
        }
        return URL(fileURLWithPath: "/tmp/openclaw")
    }

    private static func ensureLogDirExists() {
        try? FileManager().createDirectory(at: self.logDir, withIntermediateDirectories: true)
    }

    private static func modificationDate(for url: URL) -> Date {
        (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
    }

    /// Prefer the current state's structured logs; retain launchd and pre-migration logs as fallback.
    static func bestLogFile() -> URL? {
        let stateDir = OpenClawPaths.stateDirURL
        let directories = ProcessInfo.processInfo.environment["OPENCLAW_LOG_DIR"]?.isEmpty == false
            ? [self.logDir]
            : [
                stateDir.appendingPathComponent("logs"),
                stateDir.appendingPathComponent("tmp/openclaw-\(getuid())"),
                self.logDir,
            ]
        return directories.lazy.compactMap { self.newestLogFile(in: $0) }.first
    }

    private static func newestLogFile(in directory: URL) -> URL? {
        let fm = FileManager()
        let files = (try? fm.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles])) ?? []

        return files
            .filter { file in
                file.lastPathComponent.hasPrefix("openclaw") && file.pathExtension == "log"
            }
            .max { lhs, rhs in
                self.modificationDate(for: lhs) < self.modificationDate(for: rhs)
            }
    }

    /// Path to use for launchd stdout/err.
    static var launchdLogPath: String {
        self.ensureLogDirExists()
        return self.logDir.appendingPathComponent("openclaw-stdout.log").path
    }

    /// Path to use for the Gateway launchd job stdout/err.
    static var launchdGatewayLogPath: String {
        self.ensureLogDirExists()
        let suffix = AppProfile.current.name.map { "-\($0)" } ?? ""
        return self.logDir.appendingPathComponent("openclaw-gateway\(suffix).log").path
    }
}
