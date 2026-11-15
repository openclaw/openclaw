import Foundation
import OpenClawKit
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
            let bootstrapped = await calls.arguments.contains { $0.first == "bootstrap" }
            return arguments.first == "print" && !loaded && !bootstrapped ? 113 : 0
        }
        let reloaded = await manager.set(
            enabled: true,
            bundlePath: "/Applications/OpenClaw.app",
            profile: AppProfile(environment: [:])).value

        #expect(reloaded)
        let plist = try #require(PropertyListSerialization.propertyList(
            from: Data(contentsOf: plistURL), format: nil) as? [String: Any])
        #expect(plist["ProgramArguments"] as? [String] == ["/Applications/OpenClaw.app/Contents/MacOS/OpenClaw"])
        let operations = await calls.arguments.map(\.first)
        #expect(operations == (loaded ? ["print"] : ["print", "bootstrap", "print"]))
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
        var observed: Bool? = true
        var failure: String?
        let applied = await manager.set(
            enabled: true,
            bundlePath: "/Applications/OpenClaw.app",
            profile: AppProfile(environment: [:]),
            onResult: { observed = $0
                failure = $1
            }).value

        #expect(!applied)
        #expect(await calls.arguments.isEmpty)
        #expect(try String(contentsOf: blocker, encoding: .utf8) == "original")
        #expect(observed == nil)
        #expect(failure != nil)
    }

    @Test(arguments: [Int32(5), Int32(-1)])
    func `failed bootstraps do not report login changes as applied`(status: Int32) async throws {
        let directory = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: directory) }
        let plistURL = directory.appendingPathComponent("Library/LaunchAgents/login.plist")
        let calls = LoginAgentCalls()
        let manager = LaunchAgentManager(plistURL: plistURL) { arguments in
            await calls.record(arguments)
            return switch arguments.first {
            case "print", "bootout": 3 // An absent job is expected on first enable.
            case "bootstrap": status
            default: 0
            }
        }

        let applied = await manager.set(
            enabled: true,
            bundlePath: "/Applications/OpenClaw.app",
            profile: AppProfile(environment: [:])).value

        #expect(!applied)
        #expect(!FileManager.default.fileExists(atPath: plistURL.path))
        let operations = await calls.arguments.compactMap(\.first)
        #expect(operations.contains("bootstrap"))
        #expect(!operations.contains("kickstart"))
    }

    @Test(arguments: [Int32(5), Int32(-1)])
    func `failed status inspection restores the old plist without starting a job`(status: Int32) async throws {
        let directory = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: directory) }
        let plistURL = directory.appendingPathComponent("login.plist")
        try "original".write(to: plistURL, atomically: true, encoding: .utf8)
        let calls = LoginAgentCalls()
        let manager = LaunchAgentManager(plistURL: plistURL) { arguments in
            await calls.record(arguments)
            return status
        }

        #expect(await !manager.set(
            enabled: true, bundlePath: "/Applications/OpenClaw.app",
            profile: AppProfile(environment: [:])).value)
        #expect(try String(contentsOf: plistURL, encoding: .utf8) == "original")
        #expect(await calls.arguments.allSatisfy { $0.first == "print" })
    }

    @Test func `app state reconciles failed login choices and clears the error after retry`() async throws {
        let directory = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: directory) }
        let plistURL = directory.appendingPathComponent("login.plist")
        let configURL = directory.appendingPathComponent("openclaw.json")
        try "{}".write(to: configURL, atomically: true, encoding: .utf8)
        let calls = LoginAgentCalls()
        let manager = LaunchAgentManager(plistURL: plistURL) { arguments in
            await calls.record(arguments)
            let attempts = await calls.arguments.filter { $0.first == "bootstrap" }.count
            if arguments.first == "print" { return attempts >= 2 ? 0 : 113 }
            if arguments.first == "bootstrap", attempts == 1 { return 5 }
            return 0
        }
        try await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": configURL.path,
            "OPENCLAW_STATE_DIR": directory.appendingPathComponent("state").path,
        ]) {
            let state = AppState(preview: true, launchAtLoginManager: manager)
            do {
                try await state.setLaunchAtLogin(true).value
                Issue.record("A failed bootstrap must reject the settings request")
            } catch {
                #expect(error.localizedDescription.contains("bootstrap"))
            }
            #expect(!state.launchAtLogin)
            #expect(state.launchAtLoginError != nil)
            #expect(!FileManager.default.fileExists(atPath: plistURL.path))

            try await state.setLaunchAtLogin(true).value
            #expect(state.launchAtLogin)
            #expect(state.launchAtLoginError == nil)
            try await state.setLaunchAtLogin(false).value
            #expect(!state.launchAtLogin)
            #expect(!FileManager.default.fileExists(atPath: plistURL.path))
            #expect(await !calls.arguments.contains { $0.first == "bootout" })
        }
    }

    @Test func `queued login choices supersede an enable before activation`() async throws {
        let directory = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: directory) }
        let plistURL = directory.appendingPathComponent("login.plist")
        let configURL = directory.appendingPathComponent("openclaw.json")
        try "{}".write(to: configURL, atomically: true, encoding: .utf8)
        let entered = AsyncTestGate()
        let release = AsyncTestGate()
        defer { release.open() }
        let calls = LoginAgentCalls()
        let manager = LaunchAgentManager(plistURL: plistURL) { arguments in
            await calls.record(arguments)
            if arguments.first == "print" {
                entered.open()
                await release.wait()
                return 113
            }
            return 0
        }
        try await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": configURL.path,
            "OPENCLAW_STATE_DIR": directory.appendingPathComponent("state").path,
        ]) {
            let state = AppState(preview: true, launchAtLoginManager: manager)
            let queue = DeviceSettingsRequestQueue()
            defer { queue.cancel() }
            let replies = AsyncStream<Void>.makeStream()
            defer { replies.continuation.finish() }
            var results = replies.stream.makeAsyncIterator()
            var operations: [Task<Void, Error>] = []
            for enabled in [true, false] {
                queue.enqueueAdmission {
                    let completion = state.setLaunchAtLogin(enabled)
                    operations.append(completion)
                    return {
                        do {
                            try await completion.value
                        } catch {
                            Issue.record("Superseded or disabled login intent must not fail: \(error)")
                        }
                        replies.continuation.yield(())
                    }
                }
                if enabled { await entered.wait() }
            }
            // The later intent must reach AppState while the earlier print is held.
            do {
                try await TestWait.state("queued login disable admission") { !state.launchAtLogin }
            } catch {
                queue.cancel()
                release.open()
                for operation in operations {
                    try? await operation.value
                }
                throw error
            }
            release.open()
            await results.next()
            await results.next()
            #expect(!state.launchAtLogin)
            #expect(state.launchAtLoginError == nil)
            #expect(!FileManager.default.fileExists(atPath: plistURL.path))
            #expect(await calls.arguments.map(\.first) == ["print"])
        }
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
        let data = try LaunchAgentManager.plistContents(bundlePath: "/Applications/OpenClaw.app")
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
            let data = try LaunchAgentManager.plistContents(
                bundlePath: bundlePath,
                preferredPaths: ["/tmp/custom&<bin>", "/usr/bin"])
            let plist = try #require(String(data: data, encoding: .utf8))
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
            let data = try LaunchAgentManager.plistContents(bundlePath: "/Applications/OpenClaw.app")
            let object = try #require(
                PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])

            let environment = try #require(object["EnvironmentVariables"] as? [String: String])
            #expect(environment.keys.sorted() == ["PATH"])
        }
    }
}

private actor LoginAgentCalls {
    private(set) var arguments: [[String]] = []

    func record(_ arguments: [String]) {
        self.arguments.append(arguments)
    }
}
