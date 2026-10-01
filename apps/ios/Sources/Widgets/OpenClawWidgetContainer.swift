import Darwin
import Foundation

enum OpenClawWidgetContainer {
    static func databaseURL(bundle: Bundle = .main) throws -> URL {
        guard let identifier = bundle.object(forInfoDictionaryKey: "OpenClawWidgetAppGroupIdentifier") as? String,
              identifier.hasPrefix("group."), identifier.hasSuffix(".widgets"),
              let group = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: identifier)
        else { throw OpenClawWidgetCache.Failure.unavailable }
        return group.appendingPathComponent("WidgetCache", isDirectory: true)
            .appendingPathComponent(OpenClawWidgetCache.filename)
    }

    static func validateDatabasePath(_ url: URL) throws {
        try self.validateNoWALSidecars(url)
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true else {
            throw OpenClawWidgetCache.Failure.unavailable
        }
        let parent = try url.deletingLastPathComponent()
            .resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard parent.isDirectory == true, parent.isSymbolicLink != true else {
            throw OpenClawWidgetCache.Failure.unavailable
        }
    }

    static func validateNoWALSidecars(_ url: URL) throws {
        guard url.isFileURL, url.lastPathComponent == OpenClawWidgetCache.filename else {
            throw OpenClawWidgetCache.Failure.unavailable
        }
        let path: String
        if let parent = realpath(url.deletingLastPathComponent().path, nil) {
            defer { free(parent) }
            path = URL(fileURLWithPath: String(cString: parent)).appendingPathComponent(url.lastPathComponent).path
        } else {
            guard errno == ENOENT else { throw OpenClawWidgetCache.Failure.unavailable }
            path = url.path
        }
        // Even a rollback header can enter an existing WAL. lstat also rejects
        // dangling links; this owner never converts or replaces an open cache.
        for suffix in ["-wal", "-shm"] {
            var metadata = stat()
            guard lstat(path + suffix, &metadata) != 0, errno == ENOENT else {
                throw OpenClawWidgetCache.Failure.unavailable
            }
        }
    }

    static func prepareDirectory(for databaseURL: URL) throws {
        guard databaseURL.isFileURL, databaseURL.lastPathComponent == OpenClawWidgetCache.filename else {
            throw OpenClawWidgetCache.Failure.unavailable
        }
        var directory = databaseURL.deletingLastPathComponent()
        var attributes: [FileAttributeKey: Any] = [.posixPermissions: 0o700]
        #if os(iOS)
        attributes[.protectionKey] = FileProtectionType.complete
        #endif
        if FileManager.default.fileExists(atPath: directory.path) {
            let values = try directory.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            guard values.isDirectory == true, values.isSymbolicLink != true else {
                throw OpenClawWidgetCache.Failure.unavailable
            }
        } else {
            try FileManager.default.createDirectory(
                at: directory, withIntermediateDirectories: true, attributes: attributes)
        }
        try FileManager.default.setAttributes(attributes, ofItemAtPath: directory.path)
        var resources = URLResourceValues()
        resources.isExcludedFromBackup = true
        try directory.setResourceValues(resources)
    }
}
