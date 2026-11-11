import Darwin
import Foundation

/// Owns the window captures that `get_window_state` asks Peekaboo to persist.
///
/// Peekaboo publishes an owned snapshot only together with a raw screenshot
/// file, so every window observation writes a private window capture to disk.
/// Each executor writes into its own directory below a per-process directory:
/// - the snapshot manager deletes registered captures on cleanup, expiry, and
///   eviction (`deleteArtifactsOnCleanup`);
/// - a failed observation can leave an unregistered capture because the writer
///   persists the file before publication, so the executor sweeps it;
/// - native node shutdown removes the process directory;
/// - a crash or forced quit skips all of the above, so directories of processes
///   that no longer run are removed before the first window observation.
enum WindowObservationArtifacts {
    static let rootDirectory = FileManager.default.temporaryDirectory
        .appendingPathComponent("openclaw-window-observations", isDirectory: true)

    static var processDirectory: URL {
        self.rootDirectory.appendingPathComponent(String(getpid()), isDirectory: true)
    }

    @MainActor private static var recoveredInterruptedRuns = false

    /// Creates `directory` for the next observation. The first call per process
    /// also removes captures left behind by interrupted runs.
    @MainActor
    static func prepare(_ directory: URL) throws {
        if !self.recoveredInterruptedRuns {
            self.recoveredInterruptedRuns = true
            self.removeInterruptedRuns(in: self.rootDirectory)
        }
        try self.createPrivateDirectory(directory)
    }

    /// Creates `directory` and any missing parents with owner-only permissions.
    static func createPrivateDirectory(_ directory: URL) throws {
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
    }

    /// Removes per-process directories in `root` whose process no longer runs.
    /// The current process and other running processes keep their captures.
    static func removeInterruptedRuns(
        in root: URL,
        isRunning: (pid_t) -> Bool = Self.isProcessRunning)
    {
        guard let entries = try? FileManager.default.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: nil)
        else { return }
        let currentPid = getpid()
        for entry in entries {
            if let pid = pid_t(entry.lastPathComponent), pid > 0,
               pid == currentPid || isRunning(pid)
            {
                continue
            }
            try? FileManager.default.removeItem(at: entry)
        }
    }

    static func isProcessRunning(_ pid: pid_t) -> Bool {
        kill(pid, 0) == 0 || errno == EPERM
    }

    /// Removes files written into `directory` since `startedAt`: the sweep for a
    /// failed observation. Observations of one executor are serialized, and
    /// registered captures of earlier snapshots keep their older dates.
    static func discardArtifacts(writtenSince startedAt: Date, in directory: URL) {
        guard let contents = try? FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.contentModificationDateKey])
        else { return }
        for url in contents where Self.modificationDate(of: url) >= startedAt {
            try? FileManager.default.removeItem(at: url)
        }
    }

    /// Removes `directory` and everything beneath it.
    static func removeAll(in directory: URL) {
        try? FileManager.default.removeItem(at: directory)
    }

    private static func modificationDate(of url: URL) -> Date {
        (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
    }
}
