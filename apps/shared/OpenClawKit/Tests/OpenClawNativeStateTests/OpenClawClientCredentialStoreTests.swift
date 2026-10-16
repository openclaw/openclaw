import Darwin
import Foundation
import Testing
@testable import OpenClawNativeState

struct OpenClawClientCredentialStoreTests {
    typealias Store = OpenClawClientCredentialStore

    @Test func `first creation preserves the authoritative identity without shared state`() throws {
        try self.withRoot { root in
            let initial = self.identity()
            try Store.withExclusiveOperation(rootURL: root) { (owner: Store) throws in
                #expect(try owner.readIdentity(key: "primary") == nil)
                #expect(try owner.createIdentity(initial) == initial)
                #expect(try owner.createIdentity(self.identity(deviceID: "losing-id")) == initial)
                #expect(try owner.createIdentity(self.identity(key: "shareExtension")).key == "shareExtension")
            }
            try Store.withExclusiveOperation(rootURL: root, createIfMissing: false) { (owner: Store) throws in
                #expect(try owner.readIdentity(key: "primary") == initial)
            }
            let url = Store.databaseURL(rootURL: root)
            #expect(url.path == root.appendingPathComponent("client/credentials.sqlite").path)
            #expect(!FileManager.default.fileExists(atPath: root.appendingPathComponent("state").path))
            #expect(try self.sql(url, "PRAGMA user_version") == "1")
            #expect(try self.sql(
                url,
                "SELECT COUNT(*) FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'") == "5")
            #expect(try self.sql(
                url,
                "SELECT device_id || '|' || private_key_pem || '|' || updated_at_ms FROM device_identities WHERE identity_key='primary'") ==
                "device-id|private-key|13")
        }
    }

    @Test func `token updates compare the observed token and isolate gateway scopes`() throws {
        try self.withRoot { root in
            try Store.withExclusiveOperation(rootURL: root) { (owner: Store) throws in
                let initial = self.token("initial")
                #expect(try owner.replaceToken(initial, expectedToken: nil))
                #expect(try !owner.replaceToken(self.token("unexpected"), expectedToken: nil))
                #expect(try owner.replaceToken(self.token("refreshed", updatedAtMs: 1), expectedToken: "initial"))
                #expect(try !owner.removeToken(deviceID: "device-id", role: "operator", observedToken: "initial"))
                #expect(try owner.readToken(deviceID: "device-id", role: "operator") == self.token(
                    "refreshed",
                    updatedAtMs: 1))
                let scoped = self.token("gateway-token", gatewayScope: "wss://example.invalid")
                #expect(try owner.replaceToken(scoped, expectedToken: nil))
                #expect(try owner.readToken(
                    deviceID: "device-id",
                    role: "operator",
                    gatewayScope: "wss://example.invalid") == scoped)
                #expect(try owner.readToken(
                    deviceID: "device-id",
                    role: "operator",
                    gatewayScope: "wss://other.invalid") == nil)
                #expect(try owner.removeToken(deviceID: "device-id", role: "operator", observedToken: "refreshed"))
                #expect(try owner.readToken(deviceID: "device-id", role: "operator") == nil)
                #expect(try owner.readToken(
                    deviceID: "device-id",
                    role: "operator",
                    gatewayScope: "wss://example.invalid") == scoped)
            }
        }
    }

    @Test func `credential comparisons preserve composed and decomposed UTF8 bytes`() throws {
        try self.withRoot { root in
            let owner = try Store(rootURL: root)
            defer { owner.close() }
            let composed = "\u{00E9}"
            let decomposed = "e\u{0301}"
            #expect(try owner.replaceToken(self.token(composed), expectedToken: nil))
            #expect(try !owner.replaceToken(self.token("replacement"), expectedToken: decomposed))
            var removal = ClientCredentialOperation(kind: .tokenRemove)
            removal.key = .init(deviceID: "device-id", role: "operator")
            removal.hasExpectedToken = true
            removal.expectedToken = decomposed
            #expect(try owner.execute(removal).changed == false)
            removal.hasExpectedToken = false
            removal.observedToken = decomposed
            #expect(try owner.execute(removal).changed == false)

            _ = try owner.createSocketCredentials(.init(path: composed, token: composed, updatedAtMs: 1))
            #expect(try !owner.replaceSocketCredentials(
                .init(path: "replacement", token: "replacement", updatedAtMs: 2),
                expectedToken: decomposed))
            var socket = ClientCredentialOperation(kind: .socketEnsure)
            socket.fallback = .init(path: "fallback", token: "fallback", updatedAtMs: 3)
            socket.requested = .init(path: decomposed, token: decomposed)
            let replaced = try #require(owner.execute(socket).socket)
            #expect(try #require(replaced.path).utf8.elementsEqual(decomposed.utf8))
            #expect(try #require(replaced.token).utf8.elementsEqual(decomposed.utf8))
            #expect(replaced.updatedAtMs == 3)

            for role in [composed, decomposed] {
                #expect(try owner.replaceToken(
                    .init(
                        deviceID: "device-id", role: role, token: role, scopesJSON: "[]", updatedAtMs: 1),
                    expectedToken: nil))
            }
            var clear = ClientCredentialOperation(kind: .nativeTokensClear)
            clear.device_id = "device-id"
            clear.selector = .init(kind: .role, role: composed)
            #expect(try owner.execute(clear).count == 1)
            #expect(try owner.readToken(deviceID: "device-id", role: composed) == nil)
            #expect(try owner.readToken(deviceID: "device-id", role: decomposed) != nil)
        }
    }

    @Test func `socket creation preserves nullable material and the first writer`() throws {
        try self.withRoot { root in
            let original = Store.SocketCredentials(path: nil, token: "socket-token", updatedAtMs: 17)
            try Store.withExclusiveOperation(rootURL: root) { (owner: Store) throws in
                #expect(try owner.readSocketCredentials() == nil)
                #expect(try owner.createSocketCredentials(original) == original)
                #expect(try owner
                    .createSocketCredentials(.init(path: "/unused", token: nil, updatedAtMs: 20)) == original)
            }
            try Store.withExclusiveOperation(rootURL: root) { (owner: Store) throws in
                #expect(try owner.readSocketCredentials() == original)
            }
        }
    }

    @Test(arguments: ["", "historical", "/custom/approvals.sock"])
    func `socket ensure relocates only empty and historical paths`(storedPath: String) throws {
        try self.withRoot { root in
            let owner = try Store(rootURL: root)
            defer { owner.close() }
            let path = storedPath == "historical" ? root.appendingPathComponent("exec-approvals.sock").path : storedPath
            let original = Store.SocketCredentials(path: path, token: " exact-token ", updatedAtMs: 17)
            _ = try owner.createSocketCredentials(original)
            var operation = ClientCredentialOperation(kind: .socketEnsure)
            operation.fallback = .init(path: "/short/approvals.sock", token: "unused-token", updatedAtMs: 20)
            let socket = try #require(owner.execute(operation).socket)
            #expect(socket.path == (storedPath == "/custom/approvals.sock" ? storedPath : "/short/approvals.sock"))
            #expect(socket.token == original.token)
            #expect(socket.updatedAtMs == (storedPath == "/custom/approvals.sock" ? 17 : 20))
            #expect(try owner.execute(operation).socket == socket)
        }
    }

    @Test func `retained owner excludes another process until explicit close`() throws {
        try self.withRoot { root in
            let owner = try Store(rootURL: root)
            defer { owner.close() }
            #expect(try owner.createIdentity(self.identity()) == self.identity())
            let url = Store.databaseURL(rootURL: root)
            let whileOwned = try self.externalSQLite(url, "BEGIN EXCLUSIVE")
            #expect(whileOwned.code != 0)
            #expect(whileOwned.output.contains("locked"))
            owner.close()
            #expect(try self.externalSQLite(url, "BEGIN EXCLUSIVE").code == 0)
            #expect(throws: OpenClawNativeStateError.self) { try owner.readIdentity(key: "primary") }
        }
    }

    @Test func `restored socket token can be replaced only by its observed value`() throws {
        try self.withRoot { root in
            try Store.withExclusiveOperation(rootURL: root) { (owner: Store) throws in
                _ = try owner.createSocketCredentials(.init(path: "/socket", token: nil, updatedAtMs: 20))
                let replacement = Store.SocketCredentials(path: "/socket", token: "fresh-token", updatedAtMs: 1)
                #expect(try owner.replaceSocketCredentials(replacement, expectedToken: nil))
                #expect(try !owner.replaceSocketCredentials(
                    .init(path: "/socket", token: "stale-replacement", updatedAtMs: 100), expectedToken: nil))
                #expect(try owner.readSocketCredentials() == replacement)
            }
        }
    }

    @Test func `bounded custody releases on success and thrown operation`() throws {
        try self.withRoot { root in
            enum ExpectedFailure: Error { case failure }
            #expect(throws: ExpectedFailure.self) {
                try Store.withExclusiveOperation(rootURL: root) { (owner: Store) throws in
                    _ = try owner.createIdentity(self.identity())
                    throw ExpectedFailure.failure
                }
            }
            #expect(try self.externalSQLite(Store.databaseURL(rootURL: root), "BEGIN EXCLUSIVE").code == 0)
            try Store.withExclusiveOperation(rootURL: root) { (owner: Store) throws in
                #expect(try owner.readIdentity(key: "primary") == self.identity())
            }
        }
    }

    @Test func `read existing leaves an absent root untouched`() throws {
        try self.withRoot { root in
            let result = try Store.withExclusiveOperation(rootURL: root, createIfMissing: false) { _ in true }
            #expect(result == nil)
            #expect(!FileManager.default.fileExists(atPath: root.appendingPathComponent("client").path))
        }
    }

    @Test(arguments: [
        "PRAGMA user_version=2",
        "CREATE TABLE unexpected (value TEXT)",
        "DROP INDEX idx_device_auth_tokens_updated",
        "ALTER TABLE device_identities ADD COLUMN future TEXT",
        "PRAGMA journal_mode=WAL",
    ])
    func `unsupported local stores are refused without data replacement`(_ mutation: String) throws {
        try self.withRoot { root in
            _ = try Store.withExclusiveOperation(rootURL: root) { try $0.createIdentity(self.identity()) }
            let url = Store.databaseURL(rootURL: root)
            _ = try self.sql(url, mutation)
            let before = try Data(contentsOf: url)
            #expect(throws: OpenClawNativeStateError.self) { try Store(rootURL: root) }
            #expect(try Data(contentsOf: url) == before)
            #expect(try self
                .sql(url, "SELECT device_id FROM device_identities WHERE identity_key='primary'") == "device-id")
        }
    }

    @Test func `unsafe local paths cannot redirect credential creation`() throws {
        try self.withRoot { root in
            let destination = root.appendingPathComponent("elsewhere", isDirectory: true)
            try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
            try FileManager.default.createSymbolicLink(
                at: root.appendingPathComponent("client"), withDestinationURL: destination)
            #expect(throws: OpenClawNativeStateError.self) { try Store(rootURL: root) }
            #expect(try FileManager.default.contentsOfDirectory(atPath: destination.path).isEmpty)
        }
    }

    @Test func `private directory setup removes inherited access before journal creation`() throws {
        try self.withRoot { root in
            let directory = root.appendingPathComponent("client")
            try FileManager.default.createDirectory(
                at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let permissions = Process()
            permissions.executableURL = URL(fileURLWithPath: "/bin/chmod")
            permissions.arguments = [
                "+a", "everyone allow read,write,append,readattr,readextattr,file_inherit,directory_inherit",
                directory.path,
            ]
            try permissions.run()
            permissions.waitUntilExit()
            try #require(permissions.terminationStatus == 0)
            _ = try Store.withExclusiveOperation(rootURL: root) { try $0.createIdentity(self.identity()) }
            for url in [directory, Store.databaseURL(rootURL: root)] {
                if let acl = acl_get_file(url.path, ACL_TYPE_EXTENDED) {
                    defer { acl_free(UnsafeMutableRawPointer(acl)) }
                    var entry: acl_entry_t?
                    #expect(acl_get_entry(acl, 0, &entry) != 0)
                } else {
                    #expect(errno == ENOENT)
                }
            }
        }
    }

    private func identity(key: String = "primary", deviceID: String = "device-id") -> Store.Identity {
        .init(
            key: key,
            deviceID: deviceID,
            publicKeyPEM: "public-key",
            privateKeyPEM: "private-key",
            createdAtMs: 11,
            updatedAtMs: 13)
    }

    private func token(_ token: String, gatewayScope: String? = nil, updatedAtMs: Int64 = 19) -> Store.Token {
        .init(
            deviceID: "device-id",
            role: "operator",
            gatewayScope: gatewayScope,
            token: token,
            scopesJSON: "[\"operator.read\"]",
            updatedAtMs: updatedAtMs)
    }

    private func withRoot(_ body: (URL) throws -> Void) throws {
        let base = ProcessInfo.processInfo.environment["TMPDIR"] ?? NSTemporaryDirectory()
        let root = URL(fileURLWithPath: base, isDirectory: true)
            .appendingPathComponent("openclaw-client-credentials-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        // Darwin's /var temporary path is an alias; SQLite's no-follow open needs the resolved root.
        let resolved = try #require(realpath(root.path, nil))
        defer { free(resolved) }
        try body(URL(fileURLWithPath: String(cString: resolved), isDirectory: true))
    }

    private func sql(_ url: URL, _ sql: String) throws -> String {
        let result = try externalSQLite(url, sql)
        try #require(result.code == 0, Comment(rawValue: result.output))
        return result.output.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func externalSQLite(_ url: URL, _ sql: String) throws -> (code: Int32, output: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/sqlite3")
        process.arguments = ["-batch", "-init", "/dev/null", "-bail", url.path, sql]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = output
        try process.run()
        let bytes = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return (process.terminationStatus, String(decoding: bytes, as: UTF8.self))
    }
}
