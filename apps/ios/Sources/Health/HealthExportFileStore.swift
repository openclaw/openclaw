import Foundation
import os

// MARK: - HealthExportFileStore

/// Stores the HealthKit query anchor and any deferred (failed) payloads in files protected with
/// `completeUntilFirstUserAuthentication` (encrypted at rest, readable after the first unlock since
/// boot). This is deliberately NOT `complete`: background wakes (BGProcessingTask / HKObserver) run
/// while the device may be locked, and `complete` would make an existing anchor/pending file read as
/// absent on a locked wake — causing the same HealthKit window to be re-read and re-uploaded.
///
/// The anchor is an opaque `HKQueryAnchor` archived to `Data`; it can exceed the Keychain's ~4KB
/// generic-password limit, which is exactly why it does NOT live in the Keychain.
enum HealthExportFileStore {
    private static let logger = Logger(subsystem: "ai.openclaw.ios", category: "HealthExport")
    private static let directoryName = "HealthExport"
    private static let anchorFileName = "anchor.bin"
    private static let pendingFileName = "pending.json"
    private static let pendingAnchorFileName = "pending-anchor.bin"

    // MARK: Directory

    private static func directoryURL() -> URL? {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        guard let base else { return nil }
        let dir = base.appendingPathComponent(self.directoryName, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [
                .protectionKey: FileProtectionType.completeUntilFirstUserAuthentication,
            ])
            // Re-assert protection in case the directory already existed without it.
            try? FileManager.default.setAttributes(
                [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                ofItemAtPath: dir.path)
            // Migrate state files a previous build may have written with `.complete` (which would
            // read as absent on a locked background wake). Best-effort + idempotent; succeeds while
            // the device is unlocked (e.g. when the user configures the feature in the foreground).
            for name in [self.anchorFileName, self.pendingFileName, self.pendingAnchorFileName] {
                let fileURL = dir.appendingPathComponent(name)
                if FileManager.default.fileExists(atPath: fileURL.path) {
                    try? FileManager.default.setAttributes(
                        [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                        ofItemAtPath: fileURL.path)
                }
            }
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
            try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
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

    /// Persists the raw JSON body that failed to POST so a later run can retry it, together with the
    /// HealthKit anchor that body corresponds to. On a successful retry the caller advances the anchor
    /// to exactly this value (see `HealthExportService`), so the retried window is never re-read and
    /// re-uploaded. A `nil` anchor clears any stale sidecar (keeps the old anchor-stays-put behavior).
    @discardableResult
    static func savePendingPayload(_ data: Data, anchor: Data?) -> Bool {
        guard let dir = self.directoryURL() else { return false }
        // Write the anchor sidecar FIRST so we never persist a pending body whose anchor is missing
        // (that would silently fall back to "do not advance" and risk a duplicate upload). If the
        // anchor write fails, don't persist the body — losing the deferral is safe: the failed POST
        // never advanced the live anchor, so the window is simply re-read on the next run.
        let anchorURL = dir.appendingPathComponent(self.pendingAnchorFileName)
        if let anchor {
            guard self.writeProtected(anchor, to: anchorURL) else { return false }
        } else {
            try? FileManager.default.removeItem(at: anchorURL)
        }
        return self.writeProtected(data, to: dir.appendingPathComponent(self.pendingFileName))
    }

    static func loadPendingPayload() -> Data? {
        guard let dir = self.directoryURL() else { return nil }
        return self.read(from: dir.appendingPathComponent(self.pendingFileName))
    }

    /// The anchor the pending payload corresponds to, if it was persisted alongside it. `nil` for
    /// payloads saved before this sidecar existed — callers must treat that as "do not advance".
    static func loadPendingAnchor() -> Data? {
        guard let dir = self.directoryURL() else { return nil }
        return self.read(from: dir.appendingPathComponent(self.pendingAnchorFileName))
    }

    @discardableResult
    static func clearPendingPayload() -> Bool {
        guard let dir = self.directoryURL() else { return false }
        // Remove the BODY first. Only once it's gone do we drop the anchor sidecar — if the body
        // removal fails we keep the sidecar so a later retry still has its matching anchor.
        let bodyURL = dir.appendingPathComponent(self.pendingFileName)
        if FileManager.default.fileExists(atPath: bodyURL.path) {
            do {
                try FileManager.default.removeItem(at: bodyURL)
            } catch {
                return false
            }
        }
        try? FileManager.default.removeItem(at: dir.appendingPathComponent(self.pendingAnchorFileName))
        return true
    }

    static func hasPendingPayload() -> Bool {
        guard let dir = self.directoryURL() else { return false }
        return FileManager.default.fileExists(atPath: dir.appendingPathComponent(self.pendingFileName).path)
    }
}
