import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized) struct NodeServiceManagerTests {
    @Test func `builds node service commands with current CLI shape`() throws {
        let tmp = try makeTempDirForTests()
        CommandResolver.setProjectRoot(tmp.path)

        let openclawPath = tmp.appendingPathComponent("node_modules/.bin/openclaw")
        try makeExecutableForTests(at: openclawPath)

        let start = NodeServiceManager._testServiceCommand(["start"])
        #expect(start == [openclawPath.path, "node", "start", "--json"])

        let stop = NodeServiceManager._testServiceCommand(["stop"])
        #expect(stop == [openclawPath.path, "node", "stop", "--json"])
    }
}
