import CommonCrypto
import CryptoKit
import Foundation
import Security
import SQLite3

/// Device-local Chrome adapter. Never exposes cookie material through a Gateway,
/// script message, subprocess output, or log. Chrome owns the source database.
enum MacTabChromeCookies {
    struct Profile: Equatable, Sendable {
        let id: String
        let database: URL
    }

    struct Cookie: Sendable {
        let domain: String
        let name: String
        let value: String
        let path: String
        let expires: Date?
        let secure: Bool
        let httpOnly: Bool
        let sameSite: Int

        func httpCookie(protectedHost: String?, now: Date) -> HTTPCookie? {
            let host = self.domain.lowercased()
            let bareHost = host.hasPrefix(".") ? String(host.dropFirst()) : host
            guard !bareHost.isEmpty, self.path.hasPrefix("/"),
                  self.expires.map({ $0 > now }) ?? true,
                  [-1, 0, 1, 2].contains(self.sameSite),
                  self.sameSite != 0 || self.secure else { return nil }
            if let protectedHost = protectedHost?.lowercased(),
               protectedHost == bareHost || (host.hasPrefix(".") && protectedHost.hasSuffix("." + bareHost))
            {
                // Ordinary local dashboards may share this store. An import must
                // never replace the Gateway account that authorized the action.
                return nil
            }
            var properties: [HTTPCookiePropertyKey: Any] = [
                .domain: self.domain, .path: self.path, .name: self.name, .value: self.value,
            ]
            if let expires = self.expires {
                properties[.expires] = expires
            } else {
                properties[.discard] = "TRUE"
            }
            if self.secure { properties[.secure] = "TRUE" }
            if self.httpOnly { properties[HTTPCookiePropertyKey("HttpOnly")] = "TRUE" }
            // Foundation has no public sameSiteNone constant. WebKit's Cocoa
            // cookie adapter accepts the explicit "none" policy string.
            if self.sameSite == 0 {
                properties[.sameSitePolicy] = "none"
            } else if self.sameSite == 2 {
                properties[.sameSitePolicy] = HTTPCookieStringPolicy.sameSiteStrict.rawValue
            } else {
                // Chrome's unspecified policy is Lax by default, not None.
                properties[.sameSitePolicy] = HTTPCookieStringPolicy.sameSiteLax.rawValue
            }
            return HTTPCookie(properties: properties)
        }
    }

    struct ImportResult: Equatable {
        let total: Int
        let imported: Int
        let skipped: Int
        let failed: Int
        let persistent: Bool
    }

    struct Batch: Sendable {
        var cookies: [Cookie] = []
        var total = 0
        var skipped = 0
        var failed = 0
    }

    enum ImportError: LocalizedError {
        case unavailable, database, keychain, decrypt

        var errorDescription: String? {
            switch self {
            case .unavailable:
                String(localized: """
                No supported Chrome profile was found on this Mac. \
                Safari, Firefox, and other browsers are not supported by Mac tab import.
                """)
            case .database:
                String(localized: """
                Chrome cookies could not be read. Quit Chrome and retry. \
                The profile may use an unsupported cookie database format.
                """)
            case .keychain:
                String(localized: "Chrome Safe Storage could not be read. Allow the macOS Keychain request, then retry.")
            case .decrypt:
                String(localized: "Chrome cookies could not be decrypted. No passwords or passkeys were read.")
            }
        }
    }

    static var chromeRoot: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Google/Chrome", isDirectory: true)
    }

    static func profiles(root: URL = Self.chromeRoot) -> [Profile] {
        let manager = FileManager.default
        guard let entries = try? manager.contentsOfDirectory(
            at: root, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey]) else { return [] }
        return entries.compactMap { entry in
            let id = entry.lastPathComponent
            guard id == "Default" || id.range(of: #"^Profile [0-9]+$"#, options: .regularExpression) != nil,
                  let values = try? entry.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey]),
                  values.isDirectory == true, values.isSymbolicLink != true else { return nil }
            for suffix in ["Network/Cookies", "Cookies"] {
                let database = entry.appendingPathComponent(suffix)
                guard manager.isReadableFile(atPath: database.path),
                      database.resolvingSymlinksInPath().path.hasPrefix(root.resolvingSymlinksInPath().path + "/")
                else { continue }
                return Profile(id: id, database: database)
            }
            return nil
        }.sorted { $0.id.localizedStandardCompare($1.id) == .orderedAscending }
    }

    /// Read-only SQLite transactions include Chrome's WAL without copying a live
    /// database piecemeal or creating a plaintext export on disk.
    static func read(_ profile: Profile, root: URL = Self.chromeRoot) throws -> Batch {
        guard self.profiles(root: root).contains(profile) else { throw ImportError.unavailable }
        var database: OpaquePointer?
        guard sqlite3_open_v2(profile.database.path, &database, SQLITE_OPEN_READONLY, nil) == SQLITE_OK,
              let database else
        {
            if let database { sqlite3_close(database) }
            throw ImportError.database
        }
        defer { sqlite3_close(database) }
        sqlite3_busy_timeout(database, 5000)
        guard sqlite3_exec(database, "BEGIN", nil, nil, nil) == SQLITE_OK else { throw ImportError.database }
        defer { sqlite3_exec(database, "ROLLBACK", nil, nil, nil) }
        let versionStatement = try self.prepare(database, "SELECT value FROM meta WHERE key = 'version'")
        defer { sqlite3_finalize(versionStatement) }
        guard sqlite3_step(versionStatement) == SQLITE_ROW,
              let version = Int(self.string(versionStatement, 0)) else { throw ImportError.database }
        let statement = try self.prepare(database, """
        SELECT host_key, name, value, encrypted_value, path, expires_utc,
               is_secure, is_httponly, has_expires, samesite, top_frame_site_key
        FROM cookies
        """)
        defer { sqlite3_finalize(statement) }
        var key = Data()
        defer { key.resetBytes(in: 0..<key.count) }
        var batch = Batch()
        while true {
            try Task.checkCancellation()
            let step = sqlite3_step(statement)
            if step == SQLITE_DONE { break }
            guard step == SQLITE_ROW else { throw ImportError.database }
            batch.total += 1
            guard self.string(statement, 10).isEmpty else {
                // WKHTTPCookieStore has no public partition-key import contract.
                batch.skipped += 1
                continue
            }
            let domain = self.string(statement, 0)
            let encryptedSize = Int(sqlite3_column_bytes(statement, 3))
            let value: String
            if encryptedSize == 0 {
                value = self.string(statement, 2)
            } else {
                guard let bytes = sqlite3_column_blob(statement, 3), encryptedSize <= 65536 else {
                    batch.failed += 1
                    continue
                }
                let encrypted = Data(bytes: bytes, count: encryptedSize)
                guard encrypted.starts(with: Data("v10".utf8)) else {
                    batch.skipped += 1
                    continue
                }
                if key.isEmpty { key = try self.key() }
                do {
                    value = try self.decrypt(encrypted, key: key, domain: domain, version: version)
                } catch {
                    batch.failed += 1
                    continue
                }
            }
            let expires: Date? = sqlite3_column_int(statement, 8) == 0 ? nil : Date(
                timeIntervalSince1970: Double(sqlite3_column_int64(statement, 5)) / 1_000_000 - 11_644_473_600)
            batch.cookies.append(Cookie(
                domain: domain, name: self.string(statement, 1), value: value, path: self.string(statement, 4),
                expires: expires, secure: sqlite3_column_int(statement, 6) != 0,
                httpOnly: sqlite3_column_int(statement, 7) != 0, sameSite: Int(sqlite3_column_int(statement, 9))))
        }
        return batch
    }

    private static func prepare(_ database: OpaquePointer, _ sql: String) throws -> OpaquePointer {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw ImportError.database
        }
        return statement
    }

    private static func string(_ statement: OpaquePointer, _ column: Int32) -> String {
        guard let bytes = sqlite3_column_text(statement, column) else { return "" }
        return String(cString: bytes)
    }

    private static func key() throws -> Data {
        var result: CFTypeRef?
        let status = SecItemCopyMatching([
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: "Chrome Safe Storage",
            kSecAttrAccount: "Chrome",
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne,
        ] as CFDictionary, &result)
        guard status == errSecSuccess, var secret = result as? Data, !secret.isEmpty else {
            throw ImportError.keychain
        }
        defer { secret.resetBytes(in: 0..<secret.count) }
        var key = Data(count: 16)
        let salt = Data("saltysalt".utf8)
        let derivation = secret.withUnsafeBytes { secret in
            salt.withUnsafeBytes { salt in
                key.withUnsafeMutableBytes { output in
                    CCKeyDerivationPBKDF(
                        CCPBKDFAlgorithm(kCCPBKDF2), secret.bindMemory(to: Int8.self).baseAddress, secret.count,
                        salt.bindMemory(to: UInt8.self).baseAddress, salt.count,
                        CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA1), 1003,
                        output.bindMemory(to: UInt8.self).baseAddress, output.count)
                }
            }
        }
        guard derivation == kCCSuccess else { throw ImportError.decrypt }
        return key
    }

    static func decrypt(_ encrypted: Data, key: Data, domain: String, version: Int) throws -> String {
        guard encrypted.starts(with: Data("v10".utf8)), key.count == 16 else { throw ImportError.decrypt }
        let ciphertext = Data(encrypted.dropFirst(3))
        let iv = Data(repeating: 0x20, count: 16)
        var plaintext = Data(count: ciphertext.count + 16)
        defer { plaintext.resetBytes(in: 0..<plaintext.count) }
        var written = 0
        let status = key.withUnsafeBytes { key in
            iv.withUnsafeBytes { iv in
                ciphertext.withUnsafeBytes { input in
                    plaintext.withUnsafeMutableBytes { output in
                        CCCrypt(
                            CCOperation(kCCDecrypt), CCAlgorithm(kCCAlgorithmAES), CCOptions(kCCOptionPKCS7Padding),
                            key.baseAddress, key.count, iv.baseAddress, input.baseAddress, input.count,
                            output.baseAddress, output.count, &written)
                    }
                }
            }
        }
        guard status == kCCSuccess else { throw ImportError.decrypt }
        let offset: Int
        if version >= 24 {
            let digest = Data(SHA256.hash(data: Data(domain.utf8)))
            guard written >= digest.count, plaintext.prefix(digest.count) == digest else { throw ImportError.decrypt }
            offset = digest.count
        } else {
            offset = 0
        }
        guard let value = String(data: plaintext.subdata(in: offset..<written), encoding: .utf8) else {
            throw ImportError.decrypt
        }
        return value
    }
}
