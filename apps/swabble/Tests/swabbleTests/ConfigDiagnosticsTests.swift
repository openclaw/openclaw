import Foundation
import XCTest

@available(macOS 26.0, *)
final class ConfigDiagnosticsTests: XCTestCase {
    func testDamagedConfigDoesNotReportDisabledOrRecommendReplacingSettings() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let log = home.appendingPathComponent("Library/Application Support/swabble/transcripts.log")
        try FileManager.default.createDirectory(at: log.deletingLastPathComponent(), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        try "meeting note\n".write(to: log, atomically: true, encoding: .utf8)
        let config = home.appendingPathComponent("config.json")
        try "{".write(to: config, atomically: true, encoding: .utf8)

        let status = try self.report("status", config: config, home: home)
        XCTAssertTrue(status.contains("wake: unknown"))
        XCTAssertFalse(status.contains("wake: disabled"))
        XCTAssertTrue(status.contains("- meeting note"))
        let doctor = try self.report("doctor", config: config, home: home)
        XCTAssertTrue(doctor.contains("Config: invalid or incompatible JSON"))
        XCTAssertFalse(doctor.contains("run setup"))
        XCTAssertEqual(try String(contentsOf: config, encoding: .utf8), "{")
    }

    private func report(_ command: String, config: URL, home: URL) throws -> String {
        let process = Process()
        process.executableURL = Bundle(for: Self.self).bundleURL.deletingLastPathComponent()
            .appendingPathComponent("swabble")
        process.arguments = [command, "--config", config.path]
        process.environment = ["HOME": home.path, "CFFIXED_USER_HOME": home.path, "PATH": "/usr/bin:/bin"]
        process.currentDirectoryURL = home
        process.standardInput = FileHandle.nullDevice
        let output = Pipe()
        process.standardOutput = output
        let finished = self.expectation(description: "swabble \(command) exits")
        process.terminationHandler = { _ in finished.fulfill() }
        try process.run()
        self.wait(for: [finished], timeout: 10)
        if process.isRunning { process.terminate() }
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0)
        return try XCTUnwrap(String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8))
    }
}
