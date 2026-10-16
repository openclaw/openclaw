import CryptoKit
import Foundation

extension BundledRuntime {
    enum ValidationError: LocalizedError {
        case invalidManifest
        case invalidPayload

        var errorDescription: String? {
            switch self {
            case .invalidManifest: "The bundled runtime manifest is invalid or incompatible. Reinstall OpenClaw.app."
            case .invalidPayload: "The bundled runtime files are missing or damaged. Reinstall OpenClaw.app."
            }
        }
    }

    /// Manifest discovery is also the standalone identity check for CLI and service probes.
    static func validatedStandaloneManifest(executable: URL) throws -> Manifest? {
        let executable = executable.resolvingSymlinksInPath()
        let runtime = Self(root: executable.deletingLastPathComponent())
        guard FileManager.default.fileExists(atPath: runtime.root.appendingPathComponent("manifest.json").path)
        else {
            // A packaged ownership marker still identifies this runtime when its manifest is lost.
            guard !FileManager.default.fileExists(atPath: runtime.packageRoot
                .appendingPathComponent("openclaw-install-owner.json").path)
            else { throw ValidationError.invalidManifest }
            return nil
        }
        let manifest = try runtime.validatedManifest()
        guard executable == runtime.executable.resolvingSymlinksInPath() else {
            throw ValidationError.invalidManifest
        }
        return manifest
    }

    func validatedManifest(verifyExecutable: Bool = false) throws -> Manifest {
        let manifest = try self.manifest()
        guard manifest.schemaVersion == 1,
              ["jit", "bytecode"].contains(manifest.mode),
              Semver.parse(manifest.openclaw.version) != nil,
              manifest.openclaw.commit.range(of: "^[0-9a-f]{40}$", options: .regularExpression) != nil,
              manifest.executable.path == "openclaw", manifest.runtime.path == "runtime",
              manifest.executable.sizeBytes > 0, manifest.runtime.sizeBytes >= 0,
              manifest.executable.sha256?.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
        else { throw ValidationError.invalidManifest }
        let prefix = self.root.resolvingSymlinksInPath().path + "/"
        guard self.executable.resolvingSymlinksInPath().path.hasPrefix(prefix),
              self.packageRoot.resolvingSymlinksInPath().path.hasPrefix(prefix)
        else { throw ValidationError.invalidManifest }
        let executable = try self.executable.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        let sidecar = try self.packageRoot.resourceValues(forKeys: [.isDirectoryKey])
        guard executable.isRegularFile == true,
              executable.fileSize == manifest.executable.sizeBytes,
              FileManager.default.isExecutableFile(atPath: self.executable.path),
              sidecar.isDirectory == true,
              try self.sidecarSize() == manifest.runtime.sizeBytes,
              FileManager.default.isReadableFile(atPath: self.sqliteLibrary.path)
        else { throw ValidationError.invalidPayload }
        if verifyExecutable { try self.validateExecutable(manifest: manifest) }
        return manifest
    }

    /// Hash once at the seed boundary, without executing a new path and triggering Gatekeeper assessment.
    private func validateExecutable(manifest: Manifest) throws {
        let file = try FileHandle(forReadingFrom: self.executable)
        defer { try? file.close() }
        var hash = SHA256()
        while let chunk = try file.read(upToCount: 1024 * 1024), !chunk.isEmpty {
            hash.update(data: chunk)
        }
        let digest = hash.finalize().map { String(format: "%02x", $0) }.joined()
        guard digest == manifest.executable.sha256 else { throw ValidationError.invalidPayload }
    }

    private func sidecarSize() throws -> Int {
        let keys: Set<URLResourceKey> = [.isRegularFileKey, .fileSizeKey]
        var enumerationError: Error?
        guard let entries = FileManager.default.enumerator(
            at: self.packageRoot,
            includingPropertiesForKeys: Array(keys),
            errorHandler: { _, error in enumerationError = error
                return false
            })
        else { throw ValidationError.invalidPayload }
        var bytes = 0
        for case let file as URL in entries {
            let values = try file.resourceValues(forKeys: keys)
            if values.isRegularFile == true { bytes += values.fileSize ?? 0 }
        }
        if let enumerationError { throw enumerationError }
        return bytes
    }
}
