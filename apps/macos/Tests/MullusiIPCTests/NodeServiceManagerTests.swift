import Foundation
import Testing
@testable import Mullusi

@Suite(.serialized) struct NodeServiceManagerTests {
    @Test func `builds node service commands with current CLI shape`() async throws {
        try await TestIsolation.withUserDefaultsValues(["mullusi.gatewayProjectRootPath": nil]) {
            let tmp = try makeTempDirForTests()
            CommandResolver.setProjectRoot(tmp.path)

            let mullusiPath = tmp.appendingPathComponent("node_modules/.bin/mullusi")
            try makeExecutableForTests(at: mullusiPath)

            let start = NodeServiceManager._testServiceCommand(["start"])
            #expect(start == [mullusiPath.path, "node", "start", "--json"])

            let stop = NodeServiceManager._testServiceCommand(["stop"])
            #expect(stop == [mullusiPath.path, "node", "stop", "--json"])
        }
    }
}
