import Darwin
import Foundation
import SQLite3
import Testing
@testable import OpenClawNativeState

struct OpenClawNativeStateAdmissionTests {
    @Test func `matches the Node process owner path`() throws {
        let url = try OpenClawNativeStateAdmission.processOwnerURL(
            databaseURL: URL(fileURLWithPath: "/openclaw-device-identity-contract/state/openclaw.sqlite"),
            uid: 501)
        #expect(url.path == "/openclaw-device-identity-contract/tmp/openclaw-501/state.e5c82e32e2531bdd.lock")
    }

    @Test func `aliases and missing descendants use one physical owner key`() throws {
        try self.withDirectory { directory in
            let real = directory.appendingPathComponent("real", isDirectory: true)
            let alias = directory.appendingPathComponent("alias", isDirectory: true)
            try FileManager.default.createDirectory(at: real, withIntermediateDirectories: true)
            try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: real)
            let direct = try OpenClawNativeStateAdmission.processOwnerURL(
                databaseURL: real.appendingPathComponent("missing/openclaw.sqlite"),
                uid: getuid())
            let indirect = try OpenClawNativeStateAdmission.processOwnerURL(
                databaseURL: alias.appendingPathComponent("missing/openclaw.sqlite"),
                uid: getuid())
            #expect(direct == indirect)
        }
    }

    #if os(macOS)
    @Test(arguments: ["sqlite-maintenance", "skill-workshop-apply", "unknown-owner"])
    func `maintenance rejects new and retained native access while Gateway ownership permits it`(
        deniedRole: String) throws
    {
        try self.withDirectory { directory in
            let stateRoot = directory.appendingPathComponent("not-created", isDirectory: true)
            let parent = stateRoot.appendingPathComponent("state", isDirectory: true)
            let source = parent.appendingPathComponent("openclaw.sqlite")
            let ownerURL = try OpenClawNativeStateAdmission.processOwnerURL(
                databaseURL: source,
                uid: getuid())
            defer { try? FileManager.default.removeItem(at: ownerURL) }
            try self.writeOwner(ownerURL, role: deniedRole)
            #expect(throws: OpenClawNativeStateError.self) {
                try OpenClawNativeStateSQLite(databaseURL: source)
            }
            #expect(!FileManager.default.fileExists(atPath: parent.path))

            try self.writeOwner(ownerURL, role: "gateway")
            let database = try OpenClawNativeStateSQLite(databaseURL: source)
            try database.execute("CREATE TABLE marker(value INTEGER); INSERT INTO marker VALUES (42)")
            let statement = try database.prepare("SELECT value FROM marker")
            for allowedRole in [nil, "gateway", "agent-embedded"] {
                try self.writeOwner(ownerURL, role: allowedRole)
                #expect(try database.scalarInt64("SELECT value FROM marker") == 42)
            }

            try self.writeOwner(ownerURL, role: deniedRole)
            #expect(throws: OpenClawNativeStateError.self) { try statement.step() }
            #expect(throws: OpenClawNativeStateError.self) {
                try database.execute("INSERT INTO marker VALUES (43)")
            }
            try FileManager.default.removeItem(at: ownerURL)
            #expect(try database.scalarInt64("SELECT COUNT(*) FROM marker") == 1)
        }
    }
    #endif

    @Test(arguments: [false, true])
    func `moved idle handles and retained statements refuse stale reads`(replace: Bool) throws {
        try self.withDirectory { directory in
            let source = directory.appendingPathComponent("openclaw.sqlite")
            let database = try OpenClawNativeStateSQLite(databaseURL: source)
            try database.execute("CREATE TABLE marker(value INTEGER); INSERT INTO marker VALUES (42)")
            let statement = try database.prepare("SELECT value FROM marker")
            #expect(try database.scalarInt64("SELECT value FROM marker") == 42)
            try FileManager.default.moveItem(at: source, to: directory.appendingPathComponent("previous.sqlite"))
            if replace {
                let replacement = try OpenClawNativeStateSQLite(databaseURL: source)
                try replacement.execute("CREATE TABLE marker(value INTEGER); INSERT INTO marker VALUES (99)")
                #expect(try replacement.scalarInt64("SELECT value FROM marker") == 99)
            }
            #expect(throws: OpenClawNativeStateError.self) { try statement.step() }
            #expect(throws: OpenClawNativeStateError.self) {
                try database.scalarInt64("SELECT value FROM marker")
            }
            #expect(throws: OpenClawNativeStateError.self) {
                try database.execute("INSERT INTO marker VALUES (43)")
            }
        }
    }

    @Test func `native transaction excludes maintenance through the actual database`() throws {
        try self.withDirectory { directory in
            let source = directory.appendingPathComponent("openclaw.sqlite")
            let database = try OpenClawNativeStateSQLite(databaseURL: source)
            try database.execute("CREATE TABLE marker(value INTEGER)")
            var other: OpaquePointer?
            #expect(sqlite3_open_v2(source.path, &other, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK)
            let opened = try #require(other)
            defer { sqlite3_exec(opened, "ROLLBACK", nil, nil, nil)
                sqlite3_close(opened)
            }
            try database.withImmediateTransaction {
                #expect(sqlite3_exec(opened, "BEGIN EXCLUSIVE", nil, nil, nil) == SQLITE_BUSY)
                try database.execute("INSERT INTO marker VALUES (42)")
            }
            #expect(sqlite3_exec(opened, "BEGIN EXCLUSIVE", nil, nil, nil) == SQLITE_OK)
        }
    }

    private func writeOwner(_ url: URL, role: String?) throws {
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        var payload: [String: Any] = [
            "pid": getpid(),
            "createdAt": "2026-09-24T00:00:00.000Z",
            "configPath": "/fixture/openclaw.json",
        ]
        if let role { payload["role"] = role }
        try JSONSerialization.data(withJSONObject: payload).write(to: url, options: .atomic)
    }

    private func withDirectory(_ operation: (URL) throws -> Void) throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try operation(directory)
    }
}
