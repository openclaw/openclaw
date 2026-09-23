import Foundation
import Testing
@testable import OpenClaw

struct DashboardBrowserDownloadTests {
    @Test func `failed download keeps the previous file and discards partial bytes`() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-browser-download-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("video.mp4")
        let previous = Data("previous complete video".utf8)
        try previous.write(to: file)
        let destination = try DashboardBrowserDownloadDestination(destination: file)
        defer { destination.discard() }
        #expect(!FileManager.default.fileExists(atPath: destination.stagingFile.path))
        try Data("partial transfer".utf8).write(to: destination.stagingFile)
        #expect(try Data(contentsOf: file) == previous)
        destination.discard()
        #expect(try Data(contentsOf: file) == previous)
        #expect(!FileManager.default.fileExists(atPath: destination.stagingDirectory.path))
    }

    @Test(arguments: [false, true])
    func `completed download saves all bytes for a new or replaced file`(_ replacing: Bool) throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-browser-download-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("video.mp4")
        if replacing { try Data("old video".utf8).write(to: file) }
        let destination = try DashboardBrowserDownloadDestination(destination: file)
        defer { destination.discard() }
        let downloaded = Data((0..<8192).map { UInt8($0 % 256) })
        try downloaded.write(to: destination.stagingFile)
        try destination.commit()
        #expect(try Data(contentsOf: file) == downloaded)
        #expect(!FileManager.default.fileExists(atPath: destination.stagingFile.path))
    }
}
