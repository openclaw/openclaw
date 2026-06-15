import Foundation
import os

// MARK: - HealthExportFileStore

/// Stores the HealthKit query anchor and any deferred (failed) payloads in files protected with
/// `NSFileProtectionComplete` (encrypted at rest, unreadable while the device is locked).
///
/// The anchor is an opaque `HKQueryAnchor` archived to `Data`; it can exceed the Keychain's ~4KB
/// generic-password limit, which is exactly why it does NOT live in the Keychain.
enum HealthExportFileStore {
    private static let logger = Logger(subsystem: "ai.openclaw.ios", category: "HealthExport")
    private static let directoryName = "HealthExport"
    private static let anchorFileName = "anchor.bin"
    private static let pendingFileName = "pending.json"

    // MARK: Directory

    private static func directoryURL() -> URL? {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        guard let base else { return nil }
        let dir = base.appendingPathComponent(self.directoryName, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [
                .protectionKey: FileProtectionType.complete,
            ])
            // Re-assert protection in case the directory already existed without it.
            try? FileManager.default.setAttributes(
                [.protectionKey: FileProtectionType.complete],
                ofItemAtPath: dir.path)
            // Best-effort: exclude from iCloud/iTunes backup so health data anchors stay local.
            var resourceValues = URLResourceValues()
            resourceValues.isExcludedFromBackup = true
            var mutableDir = dir
            try? mutableDir.setResourceValues(resourceValues)
            return dir
        } catch {
            self.logger.error("HealthExport: failed creating dir: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    private static func writeProtected(_ data: Data, to url: URL) -> Bool {
        do {
            try data.write(to: url, options: [.atomic, .completeFileProtection])
            return true
        } catch {
            self.logger.error("HealthExport: write failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    private static func read(from url: URL) -> Data? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        do {
            return try Data(contentsOf: url)
        } catch {
            // Most commonly: device is locked and the file is protected (expected, not an error).
            self.logger.info("HealthExport: read unavailable: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    // MARK: Anchor

    static func loadAnchorData() -> Data? {
        guard let dir = self.directoryURL() else { return nil }
        return self.read(from: dir.appendingPathComponent(self.anchorFileName))
    }

    @discardableResult
    static func saveAnchorData(_ data: Data) -> Bool {
        guard let dir = self.directoryURL() else { return false }
        return self.writeProtected(data, to: dir.appendingPathComponent(self.anchorFileName))
    }

    @discardableResult
    static func clearAnchor() -> Bool {
        guard let dir = self.directoryURL() else { return false }
        let url = dir.appendingPathComponent(self.anchorFileName)
        guard FileManager.default.fileExists(atPath: url.path) else { return true }
        do {
            try FileManager.default.removeItem(at: url)
            return true
        } catch {
            return false
        }
    }

    // MARK: Pending payload (deferred after a retryable failure)

    /// Persists the raw JSON body that failed to POST so a later run can retry it.
    @discardableResult
    static func savePendingPayload(_ data: Data) -> Bool {
        guard let dir = self.directoryURL() else { return false }
        return self.writeProtected(data, to: dir.appendingPathComponent(self.pendingFileName))
    }

    static func loadPendingPayload() -> Data? {
        guard let dir = self.directoryURL() else { return nil }
        return self.read(from: dir.appendingPathComponent(self.pendingFileName))
    }

    @discardableResult
    static func clearPendingPayload() -> Bool {
        guard let dir = self.directoryURL() else { return false }
        let url = dir.appendingPathComponent(self.pendingFileName)
        guard FileManager.default.fileExists(atPath: url.path) else { return true }
        do {
            try FileManager.default.removeItem(at: url)
            return true
        } catch {
            return false
        }
    }

    static func hasPendingPayload() -> Bool {
        guard let dir = self.directoryURL() else { return false }
        return FileManager.default.fileExists(atPath: dir.appendingPathComponent(self.pendingFileName).path)
    }
}
