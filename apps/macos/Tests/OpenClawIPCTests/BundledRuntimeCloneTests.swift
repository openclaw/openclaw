import Darwin
import Foundation
import Testing
@testable import OpenClaw

struct BundledRuntimeCloneTests {
    @Test(arguments: [false, true])
    func `runtime clone preserves tree and recovers from partial clone failure`(failClone: Bool) throws {
        let root = try makeFirstRunTempDirForTests()
        defer { try? FileManager.default.removeItem(at: root) }
        let source = root.appendingPathComponent("source")
        let destination = root.appendingPathComponent("destination")
        let fileManager = FileManager.default
        try fileManager.createDirectory(
            at: source.appendingPathComponent("nested/empty"),
            withIntermediateDirectories: true)
        let executable = source.appendingPathComponent("nested/bun")
        let contents = Data([0, 1, 2, 127, 255])
        try contents.write(to: executable)
        try fileManager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
        try fileManager.createSymbolicLink(
            atPath: source.appendingPathComponent("link").path,
            withDestinationPath: "nested/bun")
        if failClone {
            try fileManager.createDirectory(at: destination, withIntermediateDirectories: false)
            try Data().write(to: destination.appendingPathComponent("partial"))
            try BundledRuntime.cloneRuntimeTree(from: source, to: destination) { _, _, _ in
                errno = ENOTSUP
                return -1
            }
        } else {
            try BundledRuntime.cloneRuntimeTree(from: source, to: destination)
        }
        #expect(try fileManager.contentsOfDirectory(atPath: destination.path).sorted() == ["link", "nested"])
        #expect(try Data(contentsOf: destination.appendingPathComponent("nested/bun")) == contents)
        let attributes = try fileManager.attributesOfItem(atPath: destination.appendingPathComponent("nested/bun").path)
        #expect(attributes[.posixPermissions] as? Int == 0o755)
        #expect(try fileManager.contentsOfDirectory(atPath: destination.appendingPathComponent("nested/empty").path)
            .isEmpty)
        #expect(try fileManager.destinationOfSymbolicLink(atPath: destination.appendingPathComponent("link").path)
            == "nested/bun")
        try Data("changed".utf8).write(to: destination.appendingPathComponent("nested/bun"))
        #expect(try Data(contentsOf: executable) == contents)
    }
}
