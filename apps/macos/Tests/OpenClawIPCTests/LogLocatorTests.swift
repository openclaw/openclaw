import Foundation
import Testing
@testable import OpenClaw

struct LogLocatorTests {
    @Test func `structured logs follow the selected state directory`() async throws {
        let fm = FileManager()
        let root = fm.temporaryDirectory.appendingPathComponent("openclaw-log-locator-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: root) }

        for directory in ["production/logs", "test/logs", "fallback/tmp/openclaw-\(getuid())"] {
            let logDir = root.appendingPathComponent(directory)
            try fm.createDirectory(at: logDir, withIntermediateDirectories: true)
            let log = logDir.appendingPathComponent("openclaw-2026-11-12.log")
            try Data("{}\n".utf8).write(to: log)
            let stateDir = root.appendingPathComponent(String(directory.split(separator: "/")[0]))
            await TestIsolation.withEnvValues([
                "OPENCLAW_STATE_DIR": stateDir.path,
                "OPENCLAW_LOG_DIR": nil,
            ]) {
                #expect(LogLocator.bestLogFile()?.resolvingSymlinksInPath() == log.resolvingSymlinksInPath())
            }
        }
    }

    @Test func `launchd gateway log path ensures tmp dir exists`() async {
        let fm = FileManager()
        let baseDir = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        let logDir = baseDir.appendingPathComponent("openclaw-tests-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: logDir) }

        // Env mutation must hold TestIsolationLock; raw setenv races parallel
        // tests scanning environ (e.g. OPENCLAW_CONFIG_PATH readers).
        await TestIsolation.withEnvValues(["OPENCLAW_LOG_DIR": logDir.path]) {
            _ = LogLocator.launchdGatewayLogPath
        }

        var isDir: ObjCBool = false
        #expect(fm.fileExists(atPath: logDir.path, isDirectory: &isDir))
        #expect(isDir.boolValue == true)
    }
}
