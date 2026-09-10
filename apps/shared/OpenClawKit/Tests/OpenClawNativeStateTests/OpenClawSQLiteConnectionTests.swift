import Darwin
import Foundation
import SQLite3
import Testing
@testable import OpenClawNativeState

struct OpenClawSQLiteConnectionTests {
    @Test func `read only creates no source or canonical coordinator and cannot write`() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("widget-cache.sqlite")
        let coordinator = try OpenClawNativeStateHandleLease.coordinatorURL(
            databaseURL: url,
            runtimeDirectory: OpenClawNativeStateHandleLease.runtimeDirectory(for: url),
            uid: getuid())
        #expect(!FileManager.default.fileExists(atPath: coordinator.path))
        #expect(throws: OpenClawNativeStateError.self) {
            try OpenClawSQLiteConnection(databaseURL: url, access: .readOnly)
        }
        #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path).isEmpty)
        do {
            let writer = try OpenClawSQLiteConnection(databaseURL: url, access: .readWrite(createIfMissing: true))
            try writer.execute("CREATE TABLE sample (value INTEGER); INSERT INTO sample VALUES (7)")
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o440], ofItemAtPath: url.path)
        let bytes = try Data(contentsOf: url)
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        do {
            let reader = try OpenClawSQLiteConnection(databaseURL: url, access: .readOnly)
            #expect(try reader.readMainFileHeader() == bytes.prefix(100))
            #expect(try reader.scalarInt64("SELECT value FROM sample") == 7)
            #expect(throws: OpenClawNativeStateError.self) { try reader.execute("DELETE FROM sample") }
        }
        #expect(try Data(contentsOf: url) == bytes)
        #expect(try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? Int ==
            attributes[.posixPermissions] as? Int)
        #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path) == ["widget-cache.sqlite"])
        #expect(!FileManager.default.fileExists(atPath: coordinator.path))
        let alias = directory.appendingPathComponent("redirect.sqlite")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: url)
        #expect(throws: OpenClawNativeStateError.self) {
            try OpenClawSQLiteConnection(databaseURL: alias, access: .readOnly)
        }
        #expect(try Data(contentsOf: url) == bytes)
    }

    #if os(macOS)
    @Test(arguments: [true, false])
    func `managed header reads and close preserve another connections process lock`(readOnly: Bool) throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("widget-cache.sqlite")
        let holder = try OpenClawSQLiteConnection(databaseURL: url, access: .readWrite(createIfMissing: true))
        try holder.execute("CREATE TABLE sample (value INTEGER); INSERT INTO sample VALUES (7)")
        #expect(throws: Rejected.expected) {
            try holder.withImmediateTransaction {
                try holder.execute("UPDATE sample SET value = 8")
                #expect(try self.independentWriteAdmission(url) == SQLITE_BUSY)
                do {
                    let reader = try OpenClawSQLiteConnection(
                        databaseURL: url,
                        access: readOnly ? .readOnly : .protectedReadWrite(createIfMissing: false))
                    let header = try reader.readMainFileHeader()
                    #expect(header.count == 100)
                    #expect(header.prefix(16).elementsEqual("SQLite format 3\u{0}".utf8))
                }
                // The new connection has closed, but the holder's lock must
                // still prevent a different process from starting a write.
                #expect(try self.independentWriteAdmission(url) == SQLITE_BUSY)
                throw Rejected.expected
            }
        }
        #expect(try holder.scalarInt64("SELECT value FROM sample") == 7)
        #expect(try self.independentWriteAdmission(url) == SQLITE_OK)
    }

    private func independentWriteAdmission(_ url: URL) throws -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/sqlite3")
        process.arguments = [
            "-batch", "-bail", "-init", "/dev/null", url.path,
            "PRAGMA busy_timeout = 0; BEGIN IMMEDIATE; ROLLBACK;",
        ]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        process.waitUntilExit()
        #expect(process.terminationReason == .exit)
        return process.terminationStatus
    }
    #endif

    @Test func `throw after superclass initialization closes the opened handle`() throws {
        final class RejectingOwner: OpenClawSQLiteConnection, @unchecked Sendable {
            init(url: URL) throws {
                try super.init(databaseURL: url, access: .readWrite(createIfMissing: false))
                try self.execute("BEGIN EXCLUSIVE")
                throw Rejected.expected
            }
        }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("widget-cache.sqlite")
        let database = try OpenClawSQLiteConnection(databaseURL: url, access: .readWrite(createIfMissing: true))
        try database.execute("CREATE TABLE sample (value INTEGER)")
        #expect(throws: Rejected.expected) { try RejectingOwner(url: url) }
        try database.execute("BEGIN EXCLUSIVE; INSERT INTO sample VALUES (1); COMMIT")
        #expect(try database.scalarInt64("SELECT COUNT(*) FROM sample") == 1)
    }

    private enum Rejected: Error { case expected }
}
