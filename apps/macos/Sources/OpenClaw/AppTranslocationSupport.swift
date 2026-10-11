import Darwin
import Foundation
import OSLog

/// Detects App Translocation and clears residual Gatekeeper quarantine so a
/// trusted Applications install can relaunch with a stable TCC identity.
enum AppTranslocationSupport {
    private static let logger = Logger(subsystem: "ai.openclaw", category: "app-translocation")
    private static let quarantineAttribute = "com.apple.quarantine"

    nonisolated static func isAppTranslocatedPath(_ path: String) -> Bool {
        path.contains("/AppTranslocation/")
    }

    nonisolated static func isRunningUnderAppTranslocation(
        executablePath: String? = ProcessInfo.processInfo.arguments.first,
        bundlePath: String? = Bundle.main.bundleURL.path) -> Bool
    {
        [executablePath, bundlePath]
            .compactMap(\.self)
            .contains(where: self.isAppTranslocatedPath)
    }

    nonisolated static var stuckRelocationTitle: String {
        "OpenClaw is running under App Translocation"
    }

    nonisolated static var stuckRelocationMessage: String {
        """
        macOS launched OpenClaw from a temporary App Translocation path, usually \
        because com.apple.quarantine is still on /Applications/OpenClaw.app. \
        Peekaboo Bridge and Screen Recording / Accessibility grants then fail to stick.

        Quit OpenClaw, clear quarantine, and reopen the Applications copy:

        xattr -dr com.apple.quarantine /Applications/OpenClaw.app

        Then re-grant Screen Recording and Accessibility to OpenClaw in System Settings.
        """
    }

    nonisolated static var quarantineWarningTitle: String {
        "OpenClaw still has a quarantine flag"
    }

    /// Stable-path copy. Accessibility TCC can reset without App Translocation.
    nonisolated static func quarantineWarningMessage(bundlePath: String) -> String {
        """
        OpenClaw is running from a stable path, but this bundle still has \
        com.apple.quarantine. macOS can reset Accessibility on every launch even \
        when the process is not under App Translocation. Screen Recording can stay granted.

        Quit OpenClaw and clear the bundle flag:

        xattr -dr com.apple.quarantine \(bundlePath)

        Nested files under Contents/Resources can keep the attribute. That does not \
        cause this reset. Reopen OpenClaw and re-grant Accessibility in System Settings.
        """
    }

    /// Top-level bundle flag only. Nested resource quarantine does not reset Accessibility.
    nonisolated static func installedBundleHasQuarantine(bundlePath: String?) -> Bool {
        guard let bundlePath, !bundlePath.isEmpty else { return false }
        return self.hasQuarantineAttribute(atPath: bundlePath)
    }

    nonisolated static func launchHealthWarning(
        executablePath: String?,
        bundlePath: String) -> (title: String, message: String)?
    {
        if self.isRunningUnderAppTranslocation(
            executablePath: executablePath,
            bundlePath: bundlePath)
        {
            return (self.stuckRelocationTitle, self.stuckRelocationMessage)
        }
        if self.installedBundleHasQuarantine(bundlePath: bundlePath) {
            return (
                self.quarantineWarningTitle,
                self.quarantineWarningMessage(bundlePath: bundlePath))
        }
        return nil
    }

    /// Best-effort recursive clear of Gatekeeper quarantine on a trusted install.
    @discardableResult
    nonisolated static func clearQuarantineAttributes(
        at rootURL: URL,
        fileManager: FileManager = .default) -> Bool
    {
        let root = rootURL.standardizedFileURL
        guard fileManager.fileExists(atPath: root.path) else { return false }

        var clearedAny = false
        var pending = [root]
        if let enumerator = fileManager.enumerator(
            at: root,
            includingPropertiesForKeys: [.isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey],
            options: [.skipsHiddenFiles])
        {
            while let next = enumerator.nextObject() as? URL {
                pending.append(next)
            }
        }

        for url in pending where self.clearQuarantineAttribute(atPath: url.path, fileManager: fileManager) {
            clearedAny = true
        }

        if clearedAny {
            self.logger.notice(
                "Cleared residual quarantine attributes under \(root.path, privacy: .public)")
        }
        return clearedAny
    }

    nonisolated static func hasQuarantineAttribute(atPath path: String) -> Bool {
        let size = getxattr(path, quarantineAttribute, nil, 0, 0, 0)
        return size >= 0 || errno == ERANGE
    }

    @discardableResult
    private nonisolated static func clearQuarantineAttribute(
        atPath path: String,
        fileManager: FileManager) -> Bool
    {
        guard self.hasQuarantineAttribute(atPath: path) else { return false }
        if removexattr(path, self.quarantineAttribute, 0) == 0 {
            return true
        }
        // Nested resource files can be non-writable after install; make them
        // owner-writable just long enough to drop the quarantine xattr.
        let attrs = try? fileManager.attributesOfItem(atPath: path)
        let previousMode = attrs?[.posixPermissions] as? NSNumber
        if let previousMode {
            let writable = previousMode.uint16Value | 0o200
            try? fileManager.setAttributes(
                [.posixPermissions: NSNumber(value: writable)],
                ofItemAtPath: path)
        }
        let cleared = removexattr(path, quarantineAttribute, 0) == 0
        if let previousMode {
            try? fileManager.setAttributes(
                [.posixPermissions: previousMode],
                ofItemAtPath: path)
        }
        return cleared
    }
}
