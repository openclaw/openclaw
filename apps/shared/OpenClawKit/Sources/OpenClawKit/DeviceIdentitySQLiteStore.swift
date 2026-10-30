import CryptoKit
import Darwin
import Foundation
import OpenClawNativeState

enum DeviceIdentitySQLiteStore {
    private static let maximumLegacyIdentityBytes = 64 * 1024

    static func loadOrCreate(
        destinationStateDirURL: URL,
        profile: GatewayDeviceIdentityProfile,
        legacySources: [DeviceIdentityPaths.LegacyIdentitySource] = []) throws -> DeviceIdentity
    {
        try DeviceCredentialAccess.withOwner(root: destinationStateDirURL) { owner in
            try self.prepareLegacy(owner: owner, root: destinationStateDirURL, profile: profile, sources: legacySources)
            if let row = try owner.readIdentity(key: profile.rawValue) {
                do { return try self.material(row).identity } catch {
                    throw DeviceIdentityStore.storageError(
                        "Local device identity row \"\(profile.rawValue)\" in \(destinationStateDirURL.path): " +
                            "\(error.localizedDescription). Run openclaw doctor --fix")
                }
            }
            let material = DeviceIdentityStore.generateMaterial()
            return try self.material(owner.createIdentity(self.row(material, key: profile.rawValue))).identity
        }
    }

    /// Reads retained inputs; the local receipt is the only consumed-source record.
    static func prepareLegacy(
        owner: OpenClawClientCredentialStore,
        root: URL,
        profile: GatewayDeviceIdentityProfile,
        sources: [DeviceIdentityPaths.LegacyIdentitySource]) throws
    {
        let key = "identity:\(profile.rawValue)"
        let receipt = try owner.readReceipt()?.receipt
        if receipt?.legacyImports[key] != nil, receipt?.legacyImports["auth:\(profile.rawValue)"] != nil { return }
        var selected: (material: DeviceIdentityMaterial, source: URL)?
        var digest = SHA256()
        var auth: DeviceAuthStoreFile?
        for source in sources {
            // Historical interrupted claims are readable inputs, never renamed or removed here.
            if FileManager.default.fileExists(atPath: source.identityURL.path + ".doctor-importing") {
                throw DeviceIdentityStore
                    .storageError("Device identity Doctor import is pending; run openclaw doctor --fix")
            }
            for suffix in ["", ".native-importing"] {
                let url = URL(fileURLWithPath: source.identityURL.path + suffix)
                guard let data = try readLegacyFile(
                    url,
                    beneath: source.stateDirURL,
                    maximumBytes: self.maximumLegacyIdentityBytes) else { continue }
                let candidate = try DeviceIdentityStore.material(fromLegacyData: data)
                if let selected, selected.material != candidate {
                    throw DeviceIdentityStore.storageError(
                        "Legacy device identity sources conflict across \(selected.source.path) and \(url.path): " +
                            "\(selected.material.identity.deviceId) != \(candidate.identity.deviceId); " +
                            "all sources preserved")
                }
                selected = (candidate, url)
                digest.update(data: data)
            }
            if let selected,
               let candidateAuth = try DeviceAuthStore.readLegacyFile(
                   source.authURL,
                   deviceID: selected.material.identity.deviceId)
            {
                if let auth, auth != candidateAuth {
                    throw DeviceIdentityStore.storageError("Legacy device auth sources conflict; all sources preserved")
                }
                auth = candidateAuth
            }
        }
        if receipt?.legacyImports[key] != nil {
            try DeviceAuthStore.prepareLegacy(owner: owner, profile: profile, stateDirectoryURL: root, fallback: auth)
            return
        }
        if let selected, let existing = try owner.readIdentity(key: profile.rawValue),
           try self.material(existing) != selected.material
        {
            throw DeviceIdentityStore
                .storageError("Legacy identity conflicts with local credentials; sources preserved")
        }
        _ = try owner.importLegacy(
            key: key,
            sha256: selected.map { _ in digest.finalize().map { String(format: "%02x", $0) }.joined() },
            identities: selected.map { [self.row($0.material, key: profile.rawValue)] } ?? [])
        try DeviceAuthStore.prepareLegacy(owner: owner, profile: profile, stateDirectoryURL: root, fallback: auth)
    }

    private static func row(_ material: DeviceIdentityMaterial, key: String) -> OpenClawClientCredentialStore.Identity {
        .init(
            key: key,
            deviceID: material.identity.deviceId,
            publicKeyPEM: material.publicKeyPEM,
            privateKeyPEM: material.privateKeyPEM,
            createdAtMs: material.identity.createdAtMs,
            updatedAtMs: material.identity.createdAtMs)
    }

    private static func material(_ row: OpenClawClientCredentialStore.Identity) throws -> DeviceIdentityMaterial {
        try DeviceIdentityStore.material(
            deviceId: row.deviceID,
            publicKeyPEM: row.publicKeyPEM,
            privateKeyPEM: row.privateKeyPEM,
            createdAtMs: row.createdAtMs)
    }

    static func readLegacyFile(_ url: URL, beneath root: URL, maximumBytes: Int) throws -> Data? {
        var before = stat()
        if lstat(url.path, &before) != 0 {
            if errno == ENOENT { return nil }
            throw DeviceIdentityStore.storageError("Could not inspect legacy credential source")
        }
        let rootPath = try OpenClawClientCredentialStore.canonicalPath(root)
        let canonical = try OpenClawClientCredentialStore.canonicalPath(url)
        guard before.st_mode & S_IFMT == S_IFREG, before.st_nlink == 1,
              before.st_size <= maximumBytes,
              canonical.hasPrefix(rootPath + "/"),
              canonical == URL(fileURLWithPath: rootPath).appendingPathComponent(
                  String(url.standardizedFileURL.path.dropFirst(root.standardizedFileURL.path.count + 1))).path
        else {
            throw DeviceIdentityStore
                .storageError("Legacy credential source must be a bounded regular file without symlinks")
        }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let data = try handle.read(upToCount: maximumBytes + 1) ?? Data()
        var after = stat()
        guard fstat(handle.fileDescriptor, &after) == 0,
              before.st_dev == after.st_dev, before.st_ino == after.st_ino,
              before.st_size == after.st_size, data.count == Int(before.st_size),
              before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec,
              before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec
        else {
            throw DeviceIdentityStore.storageError("Legacy credential source changed during import; retry")
        }
        return data
    }
}
