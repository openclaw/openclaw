import Foundation
import Testing
@testable import Clawdbot

@Suite struct LogLocatorTests {
    @Test func launchdGatewayLogPathEnsuresTmpDirExists() throws {
        let dirPath = "/tmp/clawdbot"
        let fm = FileManager.default

        // Simulate a clean machine state where /tmp/clawdbot does not exist.
        if fm.fileExists(atPath: dirPath) {
            try? fm.removeItem(atPath: dirPath)
        }

        _ = LogLocator.launchdGatewayLogPath

        var isDir: ObjCBool = false
        #expect(fm.fileExists(atPath: dirPath, isDirectory: &isDir))
        #expect(isDir.boolValue == true)
    }
}
