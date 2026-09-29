import Foundation
import Testing
@testable import OpenClaw

@MainActor
struct LaunchAgentManagerTests {
    @Test func `active profile performs no login agent reads or writes`() async throws {
        let directory = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: directory) }
        let plistURL = directory.appendingPathComponent("login.plist")
        try "original".write(to: plistURL, atomically: true, encoding: .utf8)
        let calls = LoginAgentCalls()
        let manager = LaunchAgentManager(plistURL: plistURL) { arguments in
            await calls.record(arguments)
            return 0
        }
        let profile = AppProfile(environment: ["OPENCLAW_PROFILE": "work"])
        var loaded: Bool?
        await manager.loadStatus(profile: profile) { loaded = $0 }.value
        #expect(loaded == false)
        #expect(await !manager.set(enabled: true, bundlePath: "/Applications/OpenClaw.app", profile: profile).value)
        #expect(await !manager.set(enabled: false, bundlePath: "/Applications/OpenClaw.app", profile: profile).value)
        #expect(await !manager.restart(profile: profile).value)
        #expect(try String(contentsOf: plistURL, encoding: .utf8) == "original")
        #expect(await calls.arguments.isEmpty)
    }

    @Test(arguments: [true, false])
    func `enabling refreshes the plist and starts only unloaded login jobs`(loaded: Bool) async throws {
        let directory = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: directory) }
        let plistURL = directory.appendingPathComponent("Library/LaunchAgents/login.plist")
        let calls = LoginAgentCalls()
        let manager = LaunchAgentManager(plistURL: plistURL) { arguments in
            await calls.record(arguments)
            return arguments.first == "print" && !loaded ? 1 : 0
        }
        let reloaded = await manager.set(
            enabled: true,
            bundlePath: "/Applications/OpenClaw.app",
            profile: AppProfile(environment: [:])).value

        #expect(reloaded == !loaded)
        let plist = try #require(PropertyListSerialization.propertyList(
            from: Data(contentsOf: plistURL), format: nil) as? [String: Any])
        #expect(plist["ProgramArguments"] as? [String] == ["/Applications/OpenClaw.app/Contents/MacOS/OpenClaw"])
        let operations = await calls.arguments.map(\.first)
        #expect(operations == (loaded ? ["print"] : ["print", "bootout", "bootstrap", "kickstart"]))
    }

    @Test(arguments: [true, false])
    func `failed login plist persistence never invokes launchctl`(blockedParent: Bool) async throws {
        let directory = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: directory) }
        let plistURL = directory.appendingPathComponent("Library/LaunchAgents/login.plist")
        let blocker = blockedParent
            ? directory.appendingPathComponent("Library")
            : plistURL.appendingPathComponent("existing")
        try FileManager.default.createDirectory(
            at: blocker.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        try "original".write(to: blocker, atomically: true, encoding: .utf8)
        let calls = LoginAgentCalls()
        let manager = LaunchAgentManager(plistURL: plistURL) { arguments in
            await calls.record(arguments)
            return 0
        }
        let applied = await manager.set(
            enabled: true,
            bundlePath: "/Applications/OpenClaw.app",
            profile: AppProfile(environment: [:])).value

        #expect(!applied)
        #expect(await calls.arguments.isEmpty)
        #expect(try String(contentsOf: blocker, encoding: .utf8) == "original")
    }

    @Test func `late startup status does not overwrite a newer disabled login choice`() async throws {
        let directory = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: directory) }
        let plistURL = directory.appendingPathComponent("login.plist")
        try "original".write(to: plistURL, atomically: true, encoding: .utf8)
        let entered = AsyncTestGate()
        let release = AsyncTestGate()
        let manager = LaunchAgentManager(plistURL: plistURL) { _ in
            entered.open()
            await release.wait()
            return 0
        }
        let profile = AppProfile(environment: [:])
        var delivered: [Bool] = []
        let hydration = manager.loadStatus(profile: profile) { delivered.append($0) }
        await entered.wait()
        let disabled = await manager.set(
            enabled: false, bundlePath: "/Applications/OpenClaw.app", profile: profile).value
        release.open()
        await hydration.value

        #expect(disabled)
        #expect(await manager.set(
            enabled: false, bundlePath: "/Applications/OpenClaw.app", profile: profile).value)
        #expect(delivered.isEmpty)
        #expect(!FileManager.default.fileExists(atPath: plistURL.path))
    }

    @Test func `disable supersedes an enabling login job before it can restart the app`() async throws {
        let directory = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: directory) }
        let plistURL = directory.appendingPathComponent("login.plist")
        let entered = AsyncTestGate()
        let release = AsyncTestGate()
        let calls = LoginAgentCalls()
        let manager = LaunchAgentManager(plistURL: plistURL) { arguments in
            await calls.record(arguments)
            if arguments.first == "print" {
                entered.open()
                await release.wait()
                return 1
            }
            return 0
        }
        let profile = AppProfile(environment: [:])
        let enabling = manager.set(enabled: true, bundlePath: "/Applications/OpenClaw.app", profile: profile)
        await entered.wait()
        let disabling = manager.set(enabled: false, bundlePath: "/Applications/OpenClaw.app", profile: profile)
        release.open()
        #expect(await !enabling.value)
        #expect(await disabling.value)
        #expect(!FileManager.default.fileExists(atPath: plistURL.path))
        #expect(await calls.arguments.map(\.first) == ["print"])
    }

    @Test func `launch at login plist does not keep app alive after manual quit`() throws {
        let plist = LaunchAgentManager.plistContents(bundlePath: "/Applications/OpenClaw.app")
        let data = try #require(plist.data(using: .utf8))
        let object = try #require(
            PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])

        #expect(object["RunAtLoad"] as? Bool == true)
        #expect(object["KeepAlive"] == nil)

        let args = try #require(object["ProgramArguments"] as? [String])
        #expect(args == ["/Applications/OpenClaw.app/Contents/MacOS/OpenClaw"])
    }

    @MainActor
    @Test func `launch at login plist preserves normalized profile environment once`() async throws {
        let bundlePath = "/Applications/R&D <Team>/OpenClaw.app"
        let logDirectory = "/tmp/openclaw-login-&<logs>"
        try await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": "  /tmp/custom&<openclaw>\"'.json  ",
            "OPENCLAW_LOG_DIR": logDirectory,
            "OPENCLAW_STATE_DIR": "/tmp/openclaw-state",
        ]) {
            let plist = LaunchAgentManager.plistContents(
                bundlePath: bundlePath,
                preferredPaths: ["/tmp/custom&<bin>", "/usr/bin"])
            let data = try #require(plist.data(using: .utf8))
            let object = try #require(
                PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])

            let environment = try #require(object["EnvironmentVariables"] as? [String: String])
            #expect(object["ProgramArguments"] as? [String] == ["\(bundlePath)/Contents/MacOS/OpenClaw"])
            #expect(object["StandardOutPath"] as? String == "\(logDirectory)/openclaw-stdout.log")
            #expect(object["StandardErrorPath"] as? String == "\(logDirectory)/openclaw-stdout.log")
            #expect(environment["OPENCLAW_CONFIG_PATH"] == "/tmp/custom&<openclaw>\"'.json")
            #expect(environment["OPENCLAW_STATE_DIR"] == "/tmp/openclaw-state")
            #expect(environment["PATH"]?.contains("/tmp/custom&<bin>") == true)
            #expect(plist.components(separatedBy: "<key>OPENCLAW_CONFIG_PATH</key>").count == 2)
            #expect(plist.components(separatedBy: "<key>OPENCLAW_STATE_DIR</key>").count == 2)
        }
    }

    @MainActor
    @Test func `launch at login plist omits unset and blank profile environment`() async throws {
        try await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": nil,
            "OPENCLAW_STATE_DIR": " \n ",
        ]) {
            let plist = LaunchAgentManager.plistContents(bundlePath: "/Applications/OpenClaw.app")
            let data = try #require(plist.data(using: .utf8))
            let object = try #require(
                PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])

            let environment = try #require(object["EnvironmentVariables"] as? [String: String])
            #expect(environment.keys.sorted() == ["PATH"])
            #expect(!plist.contains("OPENCLAW_CONFIG_PATH"))
            #expect(!plist.contains("OPENCLAW_STATE_DIR"))
        }
    }
}

private actor LoginAgentCalls {
    private(set) var arguments: [[String]] = []

    func record(_ arguments: [String]) {
        self.arguments.append(arguments)
    }
}
