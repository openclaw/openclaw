import Foundation
import Testing
@testable import OpenClaw

struct TestIsolationTests {
    private enum BodyFailure: Error {
        case expected
    }

    @Test(arguments: [
        (initial: nil, temporary: "temporary"),
        (initial: nil, temporary: nil),
        (initial: "", temporary: "temporary"),
        (initial: "", temporary: nil),
        (initial: " original \t\n", temporary: "temporary"),
        (initial: " original \t\n", temporary: nil),
    ] as [(initial: String?, temporary: String?)], [false, true])
    @MainActor
    func `environment values restore exactly after completion or throw`(
        _ values: (initial: String?, temporary: String?),
        shouldThrow: Bool) async
    {
        let key = "OPENCLAW_TEST_ISOLATION_\(UUID().uuidString.replacingOccurrences(of: "-", with: "_"))"
        await TestIsolationLock.shared.acquire()
        #expect(getenv(key) == nil)
        if let initial = values.initial {
            #expect(setenv(key, initial, 1) == 0)
        }
        await TestIsolationLock.shared.release()

        var bodyRan = false
        var didThrow = false
        do {
            let result = try await TestIsolation.withEnvValues([key: values.temporary]) {
                bodyRan = true
                #expect(getenv(key).map { String(cString: $0) } == values.temporary)
                if shouldThrow {
                    throw BodyFailure.expected
                }
                return "completed"
            }
            #expect(result == "completed")
        } catch {
            didThrow = true
            #expect(error as? BodyFailure == .expected)
        }
        #expect(bodyRan)
        #expect(didThrow == shouldThrow)

        await TestIsolationLock.shared.acquire()
        #expect(getenv(key).map { String(cString: $0) } == values.initial)
        #expect(unsetenv(key) == 0)
        await TestIsolationLock.shared.release()
    }

    @Test(arguments: [false, true])
    @MainActor
    func `launch agent fixtures preserve the process home across callbacks and cleanup`(shouldThrow: Bool) async throws {
        let root = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: root) }
        let processHome = FileManager.default.homeDirectoryForCurrentUser
        let homeEnvironment = ["HOME", "CFFIXED_USER_HOME"].map { (key: String) in
            (key, getenv(key).map { String(cString: $0) })
        }
        let gatewayArguments = ["/fixture/openclaw", "gateway"]
        let gatewayPlist = GatewayLaunchAgentManager.plistURL(homeDirectory: root, profile: .current)
        try FileManager.default.createDirectory(
            at: gatewayPlist.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        try PropertyListSerialization.data(
            fromPropertyList: ["ProgramArguments": gatewayArguments], format: .xml, options: 0).write(to: gatewayPlist)

        do {
            try await TestIsolation.withIsolatedState(launchAgentHomeDirectory: root) {
                #expect(FileManager.default.homeDirectoryForCurrentUser == processHome)
                for (key, value) in homeEnvironment {
                    #expect(getenv(key).map { String(cString: $0) } == value)
                }
                #expect(GatewayLaunchAgentManager.launchdProgramArguments() == gatewayArguments)
                // UI callbacks need the fixture even when they do not inherit the test task.
                let callbackHome = await Task.detached { LaunchAgentPlist.homeDirectoryURL }.value
                #expect(callbackHome == root)
                if shouldThrow { throw BodyFailure.expected }
            }
            #expect(!shouldThrow)
        } catch {
            #expect(shouldThrow)
            #expect(error as? BodyFailure == .expected)
        }

        await TestIsolationLock.shared.acquire()
        #expect(LaunchAgentPlist.testingHomeDirectoryURL == nil)
        #expect(LaunchAgentPlist.homeDirectoryURL == processHome)
        #expect(FileManager.default.homeDirectoryForCurrentUser == processHome)
        for (key, value) in homeEnvironment {
            #expect(getenv(key).map { String(cString: $0) } == value)
        }
        await TestIsolationLock.shared.release()
    }
}
