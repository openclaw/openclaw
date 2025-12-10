import Foundation

enum LogLocator {
    private static let logDir = URL(fileURLWithPath: "/tmp/clawdis")
    private static let legacyLog = logDir.appendingPathComponent("clawdis.log")

    /// Returns the newest rolling log (clawdis-YYYY-MM-DD.log) if it exists, falling back to the legacy single-file log.
    static func bestLogFile() -> URL? {
        let fm = FileManager.default
        let rollingFiles = (try? fm.contentsOfDirectory(
            at: logDir,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles])) ?? []

        let newestRolling = rollingFiles
            .filter { $0.lastPathComponent.hasPrefix("clawdis-") && $0.pathExtension == "log" }
            .sorted { lhs, rhs in
                let lDate = (try? lhs.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                let rDate = (try? rhs.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                return lDate > rDate
            }
            .first

        if let rolling = newestRolling {
            return rolling
        }
        if fm.fileExists(atPath: legacyLog.path) {
            return legacyLog
        }
        return nil
    }

    /// Legacy path used by launchd stdout/err; exposed for plist generation.
    static var legacyLogPath: String {
        legacyLog.path
    }
}
