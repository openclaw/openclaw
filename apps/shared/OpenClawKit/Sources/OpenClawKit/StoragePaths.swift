import Foundation

public enum OpenClawNodeStorage {
    private static let directoryName = "Vericlaw"
    private static let legacyDirectoryName = "OpenClaw"

    private static func resolveBrandDirectory(in base: URL) -> URL {
        let preferred = base.appendingPathComponent(self.directoryName, isDirectory: true)
        let legacy = base.appendingPathComponent(self.legacyDirectoryName, isDirectory: true)
        if FileManager.default.fileExists(atPath: preferred.path) || !FileManager.default.fileExists(atPath: legacy.path) {
            return preferred
        }
        return legacy
    }

    public static func appSupportDir() throws -> URL {
        let base = FileManager().urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        guard let base else {
            throw NSError(domain: "OpenClawNodeStorage", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Application Support directory unavailable",
            ])
        }
        return self.resolveBrandDirectory(in: base)
    }

    public static func canvasRoot(sessionKey: String) throws -> URL {
        let root = try appSupportDir().appendingPathComponent("canvas", isDirectory: true)
        let safe = sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        let session = safe.isEmpty ? "main" : safe
        return root.appendingPathComponent(session, isDirectory: true)
    }

    public static func cachesDir() throws -> URL {
        let base = FileManager().urls(for: .cachesDirectory, in: .userDomainMask).first
        guard let base else {
            throw NSError(domain: "OpenClawNodeStorage", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "Caches directory unavailable",
            ])
        }
        return self.resolveBrandDirectory(in: base)
    }

    public static func canvasSnapshotsRoot(sessionKey: String) throws -> URL {
        let root = try cachesDir().appendingPathComponent("canvas-snapshots", isDirectory: true)
        let safe = sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        let session = safe.isEmpty ? "main" : safe
        return root.appendingPathComponent(session, isDirectory: true)
    }
}
