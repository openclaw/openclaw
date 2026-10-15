import CryptoKit
import Foundation
import OSLog

extension BundledRuntime {
    struct RuntimeArchive {
        let url: URL
        let sha256: String
    }

    private static let archiveLogger = Logger(subsystem: "ai.openclaw", category: "bundled-runtime.archive")

    static func archive(bundle: Bundle) throws -> RuntimeArchive? {
        let url = bundle.bundleURL.appendingPathComponent("Contents/Resources/runtime.aar")
        let info = bundle.infoDictionary ?? [:]
        let version = info["OpenClawRuntimeArchiveFormatVersion"]
        let digest = info["OpenClawRuntimeArchiveSHA256"]
        guard version != nil || digest != nil || FileManager.default.fileExists(atPath: url.path) else { return nil }
        guard version as? Int == 1,
              let digest = digest as? String,
              digest.count == 64, digest.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) })
        else { throw SeedError.archiveMetadata }
        guard FileManager.default.isReadableFile(atPath: url.path) else { throw SeedError.archiveUnavailable }
        return RuntimeArchive(url: url, sha256: digest)
    }

    /// The signed manifest authenticates archive bytes before any extraction touches the unpublished seed.
    static func extractArchive(_ archive: RuntimeArchive, to destination: URL) async throws {
        let source: FileHandle
        do { source = try FileHandle(forReadingFrom: archive.url) } catch { throw SeedError.archiveUnavailable }
        defer { try? source.close() }
        var hash = SHA256()
        do {
            while let data = try source.read(upToCount: 1024 * 1024), !data.isEmpty {
                try Task.checkCancellation()
                hash.update(data: data)
            }
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw SeedError.archiveUnavailable
        }
        let actual = hash.finalize().map { String(format: "%02x", $0) }.joined()
        guard actual == archive.sha256 else { throw SeedError.archiveIntegrity }
        let start = ContinuousClock.now
        let result = await ShellExecutor.runDetailed(
            command: ["/usr/bin/aa", "extract", "-i", archive.url.path, "-d", destination.path],
            cwd: nil,
            env: [:],
            timeout: 300)
        try Task.checkCancellation()
        guard result.success else {
            throw SeedError.archiveExtraction(result.errorMessage ?? result.stderr)
        }
        self.archiveLogger
            .info("Runtime archive extracted in \(String(describing: start.duration(to: .now)), privacy: .public)")
    }
}
