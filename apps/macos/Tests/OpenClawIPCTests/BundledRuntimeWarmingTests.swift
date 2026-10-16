import Darwin
import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

private struct RuntimeWarmGate {
    let readyURL: URL
    let releaseURL: URL
    let ready: FileHandle
    let release: FileHandle

    init(root: URL) throws {
        self.readyURL = root.appendingPathComponent("warm-ready")
        self.releaseURL = root.appendingPathComponent("warm-release")
        self.ready = try Self.makeFIFO(self.readyURL)
        self.release = try Self.makeFIFO(self.releaseURL)
    }

    private static func makeFIFO(_ url: URL) throws -> FileHandle {
        try #require(mkfifo(url.path, 0o600) == 0)
        let descriptor = open(url.path, O_RDWR | O_CLOEXEC)
        try #require(descriptor >= 0)
        return FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    }

    var script: String {
        """
        printf R > "\(self.readyURL.path)"
        IFS= read -r release < "\(self.releaseURL.path)"
        """
    }

    func waitUntilStarted() async throws {
        let ready = self.ready
        let signal = try await Task.detached { try ready.read(upToCount: 1) }.value
        try #require(signal == Data("R".utf8))
    }

    func resume() throws {
        try self.release.write(contentsOf: Data("continue\n".utf8))
    }

    func close() {
        try? self.resume()
        try? self.ready.close()
        try? self.release.close()
    }
}

struct BundledRuntimeWarmingTests {
    @Test func `app hosting stays in the bundle until warming publishes the durable runtime`() async throws {
        let home = try makeFirstRunTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        let gate = try RuntimeWarmGate(root: home)
        defer { gate.close() }
        let app = home.appendingPathComponent("OpenClaw.app")
        _ = try makeBundledRuntimeTestBundle(
            at: app,
            builtAt: "2026-08-27T00:00:00.000Z",
            buildID: "warming",
            command: "unused",
            warmScript: gate.script)
        let bundle = try #require(Bundle(url: app))
        let profile = AppProfile(environment: ["OPENCLAW_PROFILE": "warming"])
        let source = app.appendingPathComponent("Contents/Resources/runtime")
        let state = profile.stateDirectoryURL(homeDirectory: home)
        let current = state.appendingPathComponent("runtime/current")
        let cli = state.appendingPathComponent("bin/openclaw")
        #expect(try BundledRuntime.forAppHosting(bundle: bundle, profile: profile, homeDirectory: home).root
            .resolvingSymlinksInPath().path == source.resolvingSymlinksInPath().path)
        #expect(!FileManager.default.fileExists(atPath: state.path))

        let preparation = Task { try await BundledRuntime.seed(bundle: bundle, profile: profile, homeDirectory: home) }
        do {
            try await gate.waitUntilStarted()
            #expect(try BundledRuntime.forAppHosting(bundle: bundle, profile: profile, homeDirectory: home)
                .root.resolvingSymlinksInPath().path == source.resolvingSymlinksInPath().path)
            #expect(try BundledRuntime.seeded(profile: profile, homeDirectory: home) == nil)
            #expect(!FileManager.default.fileExists(atPath: current.path))
            #expect(!FileManager.default.fileExists(atPath: cli.path))
            try gate.resume()
            let runtime = try await preparation.value
            let published = try #require(try BundledRuntime.seeded(profile: profile, homeDirectory: home))
            #expect(published.root.resolvingSymlinksInPath().path == runtime.root.resolvingSymlinksInPath().path)
            #expect(try FileManager.default.destinationOfSymbolicLink(atPath: current.path) == "warming")
            #expect(FileManager.default.isExecutableFile(atPath: cli.path))
            #expect(try BundledRuntime.forAppHosting(bundle: bundle, profile: profile, homeDirectory: home)
                .root.resolvingSymlinksInPath().path == runtime.root.resolvingSymlinksInPath().path)
            // A regression that unnecessarily warms again must finish and fail the probe count, not hang.
            try gate.resume()
            let reused = try await BundledRuntime.seed(bundle: bundle, profile: profile, homeDirectory: home)
            #expect(reused.root.resolvingSymlinksInPath().path == runtime.root.resolvingSymlinksInPath().path)
            #expect(try String(contentsOf: runtime.root.appendingPathComponent("version-probes"), encoding: .utf8)
                == "probe\n")
            #expect(!FileManager.default.fileExists(atPath: source.appendingPathComponent("version-probes").path))
        } catch {
            await BundledRuntime.cancelSeeding(profile: profile, homeDirectory: home)
            throw error
        }
    }

    @Test func `an update hosts from its bundle while the old warmed CLI remains current`() async throws {
        let home = try makeFirstRunTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        let profile = AppProfile(environment: ["OPENCLAW_PROFILE": "update-warming"])
        let olderApp = home.appendingPathComponent("Older.app")
        _ = try makeBundledRuntimeTestBundle(
            at: olderApp, builtAt: "2026-08-26T00:00:00.000Z", buildID: "older", command: "unused")
        let older = try await BundledRuntime.seed(
            bundle: #require(Bundle(url: olderApp)), profile: profile, homeDirectory: home)
        let oldApp = home.appendingPathComponent("Old.app")
        _ = try makeBundledRuntimeTestBundle(
            at: oldApp, builtAt: "2026-08-27T00:00:00.000Z", buildID: "old", command: "unused")
        let oldBundle = try #require(Bundle(url: oldApp))
        let old = try await BundledRuntime.seed(bundle: oldBundle, profile: profile, homeDirectory: home)
        let gate = try RuntimeWarmGate(root: home)
        defer { gate.close() }
        let newApp = home.appendingPathComponent("New.app")
        _ = try makeBundledRuntimeTestBundle(
            at: newApp,
            builtAt: "2026-08-27T00:00:01.000Z",
            buildID: "new",
            command: "unused",
            warmScript: gate.script)
        let newBundle = try #require(Bundle(url: newApp))
        let state = profile.stateDirectoryURL(homeDirectory: home)
        let cli = state.appendingPathComponent("bin/openclaw")
        let previousCLI = try Data(contentsOf: cli)
        let preparation = Task { try await BundledRuntime.seed(
            bundle: newBundle, profile: profile, homeDirectory: home) }
        do {
            try await gate.waitUntilStarted()
            #expect(try BundledRuntime.forAppHosting(bundle: newBundle, profile: profile, homeDirectory: home)
                .root.resolvingSymlinksInPath().path == newApp.appendingPathComponent("Contents/Resources/runtime")
                .resolvingSymlinksInPath().path)
            #expect(try BundledRuntime.seeded(profile: profile, homeDirectory: home)?.root.resolvingSymlinksInPath()
                .path == old.root.resolvingSymlinksInPath().path)
            #expect(try Data(contentsOf: cli) == previousCLI)
            #expect(try FileManager.default.destinationOfSymbolicLink(
                atPath: state.appendingPathComponent("runtime/previous").path) == "older")
            let warmingRoot = state.appendingPathComponent("runtime/new")
            try await BundledRuntime.garbageCollectAfterHealthy(profile: profile, homeDirectory: home)
            #expect(FileManager.default.fileExists(atPath: older.root.path))
            #expect(FileManager.default.fileExists(atPath: old.root.path))
            #expect(FileManager.default.fileExists(atPath: warmingRoot.path))
            try gate.resume()
            let warmed = try await preparation.value
            #expect(try BundledRuntime.forAppHosting(bundle: newBundle, profile: profile, homeDirectory: home)
                .root.resolvingSymlinksInPath().path == warmed.root.resolvingSymlinksInPath().path)
            #expect(try FileManager.default.destinationOfSymbolicLink(
                atPath: state.appendingPathComponent("runtime/previous").path) == "old")
            #expect(FileManager.default.fileExists(atPath: old.root.path))
            // Reinstalling an older app can reuse and republish its warmed generation.
            #expect(try BundledRuntime.forAppHosting(bundle: oldBundle, profile: profile, homeDirectory: home)
                .root.resolvingSymlinksInPath().path == oldApp.appendingPathComponent("Contents/Resources/runtime")
                .resolvingSymlinksInPath().path)
            let rolledBack = try await BundledRuntime.seed(bundle: oldBundle, profile: profile, homeDirectory: home)
            #expect(rolledBack.root.resolvingSymlinksInPath().path == old.root.resolvingSymlinksInPath().path)
            #expect(try FileManager.default.destinationOfSymbolicLink(
                atPath: state.appendingPathComponent("runtime/previous").path) == "new")
            #expect(try String(contentsOf: old.root.appendingPathComponent("version-probes"), encoding: .utf8)
                == "probe\n")
        } catch {
            await BundledRuntime.cancelSeeding(profile: profile, homeDirectory: home)
            throw error
        }
    }

    @Test @MainActor
    func `cancelling before seed starts leaves no runtime state or execution`() async throws {
        let home = try makeFirstRunTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        let app = home.appendingPathComponent("OpenClaw.app")
        _ = try makeBundledRuntimeTestBundle(
            at: app, builtAt: "2026-08-27T00:00:00.000Z", buildID: "not-started", command: "unused")
        let bundle = try #require(Bundle(url: app))
        let profile = AppProfile(environment: ["OPENCLAW_PROFILE": "cancel-before-start"])
        let preparation = Task { try await BundledRuntime.seed(bundle: bundle, profile: profile, homeDirectory: home) }
        preparation.cancel()
        await #expect(throws: CancellationError.self) { try await preparation.value }
        #expect(!FileManager.default.fileExists(atPath: profile.stateDirectoryURL(homeDirectory: home).path))
        #expect(!FileManager.default.fileExists(atPath: app
                .appendingPathComponent("Contents/Resources/runtime/version-probes").path))
    }

    @Test func `quitting cancels warming without publication and next launch resumes it`() async throws {
        let home = try makeFirstRunTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        let gate = try RuntimeWarmGate(root: home)
        defer { gate.close() }
        let app = home.appendingPathComponent("OpenClaw.app")
        _ = try makeBundledRuntimeTestBundle(
            at: app,
            builtAt: "2026-08-27T00:00:00.000Z",
            buildID: "cancelled",
            command: "unused",
            warmScript: gate.script)
        let bundle = try #require(Bundle(url: app))
        let profile = AppProfile(environment: ["OPENCLAW_PROFILE": "cancel-warming"])
        let directory = profile.stateDirectoryURL(homeDirectory: home).appendingPathComponent("runtime")
        let preparation = Task { try await BundledRuntime.seed(bundle: bundle, profile: profile, homeDirectory: home) }
        do {
            try await gate.waitUntilStarted()
            await BundledRuntime.cancelSeeding(profile: profile, homeDirectory: home)
            await #expect(throws: (any Error).self) { try await preparation.value }
            #expect(try BundledRuntime.seeded(profile: profile, homeDirectory: home) == nil)
            #expect(!FileManager.default.fileExists(atPath: directory.appendingPathComponent("current").path))
            #expect(try BundledRuntime.forAppHosting(bundle: bundle, profile: profile, homeDirectory: home)
                .root.resolvingSymlinksInPath().path == app.appendingPathComponent("Contents/Resources/runtime")
                .resolvingSymlinksInPath().path)

            let retry = Task { try await BundledRuntime.seed(bundle: bundle, profile: profile, homeDirectory: home) }
            try await gate.waitUntilStarted()
            try gate.resume()
            let warmed = try await retry.value
            #expect(try BundledRuntime.seeded(profile: profile, homeDirectory: home)?.root.resolvingSymlinksInPath()
                .path == warmed.root.resolvingSymlinksInPath().path)
            #expect(try String(contentsOf: warmed.root.appendingPathComponent("version-probes"), encoding: .utf8)
                == "probe\nprobe\n")
        } catch {
            await BundledRuntime.cancelSeeding(profile: profile, homeDirectory: home)
            throw error
        }
    }

    @Test(arguments: [false, true])
    func `a failed warm preserves the current runtime and is retried`(wrongVersion: Bool) async throws {
        let home = try makeFirstRunTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        let profile = AppProfile(environment: ["OPENCLAW_PROFILE": "failed-warming"])
        let oldApp = home.appendingPathComponent("Old.app")
        _ = try makeBundledRuntimeTestBundle(
            at: oldApp, builtAt: "2026-08-27T00:00:00.000Z", buildID: "old", command: "unused")
        let old = try await BundledRuntime.seed(
            bundle: #require(Bundle(url: oldApp)), profile: profile, homeDirectory: home)
        let fail = home.appendingPathComponent("fail-warm")
        try Data().write(to: fail)
        let app = home.appendingPathComponent("New.app")
        _ = try makeBundledRuntimeTestBundle(
            at: app,
            builtAt: "2026-08-27T00:00:01.000Z",
            buildID: "new",
            command: "unused",
            warmScript: "if [ -e \"\(fail.path)\" ]; then echo 2025.1.1; exit \(wrongVersion ? 0 : 42); fi")
        let bundle = try #require(Bundle(url: app))
        let state = profile.stateDirectoryURL(homeDirectory: home)
        let cli = state.appendingPathComponent("bin/openclaw")
        let previousCLI = try Data(contentsOf: cli)
        await #expect(throws: BundledRuntime.SeedError.self) {
            try await BundledRuntime.seed(bundle: bundle, profile: profile, homeDirectory: home)
        }
        #expect(try BundledRuntime.seeded(profile: profile, homeDirectory: home)?.root.resolvingSymlinksInPath()
            .path == old.root.resolvingSymlinksInPath().path)
        #expect(try Data(contentsOf: cli) == previousCLI)
        #expect(!FileManager.default.fileExists(atPath: state.appendingPathComponent("runtime/previous").path))
        #expect(try BundledRuntime.forAppHosting(bundle: bundle, profile: profile, homeDirectory: home)
            .root.resolvingSymlinksInPath().path == app.appendingPathComponent("Contents/Resources/runtime")
            .resolvingSymlinksInPath().path)
        try FileManager.default.removeItem(at: fail)
        let warmed = try await BundledRuntime.seed(bundle: bundle, profile: profile, homeDirectory: home)
        #expect(try BundledRuntime.seeded(profile: profile, homeDirectory: home)?.root.resolvingSymlinksInPath()
            .path == warmed.root.resolvingSymlinksInPath().path)
        #expect(try String(contentsOf: warmed.root.appendingPathComponent("version-probes"), encoding: .utf8)
            == "probe\nprobe\n")
    }

    @Test func `moving the bundle preserves a running child and resolves the next launch at its new path`() throws {
        let home = try makeFirstRunTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        let app = home.appendingPathComponent("Original.app")
        _ = try makeBundledRuntimeTestBundle(
            at: app, builtAt: "2026-08-27T00:00:00.000Z", buildID: "moved", command: "fixture.ready")
        let bundle = try #require(Bundle(url: app))
        let profile = AppProfile(environment: ["OPENCLAW_PROFILE": "moved-bundle"])
        let runtime = try BundledRuntime.forAppHosting(bundle: bundle, profile: profile, homeDirectory: home)
        let process = Process()
        let input = Pipe()
        let output = Pipe()
        process.executableURL = runtime.executable
        process.arguments = [runtime.packageRoot.appendingPathComponent("dist/mac-node-worker.js").path]
        process.environment = ["PATH": runtime.root.path]
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        try process.run()
        defer {
            try? input.fileHandleForWriting.close()
            if process.isRunning { process.terminate() }
            process.waitUntilExit()
        }
        let expected = Data("{\"type\":\"ready\"".utf8)
        #expect(try output.fileHandleForReading.read(upToCount: expected.count) == expected)
        let moved = home.appendingPathComponent("Renamed.app")
        try FileManager.default.moveItem(at: app, to: moved)
        #expect(process.isRunning)
        let next = try BundledRuntime.forAppHosting(
            bundle: #require(Bundle(url: moved)), profile: profile, homeDirectory: home)
        #expect(next.root.resolvingSymlinksInPath().path == moved.appendingPathComponent("Contents/Resources/runtime")
            .resolvingSymlinksInPath().path)
        #expect(FileManager.default.isExecutableFile(atPath: next.executable.path))
        try input.fileHandleForWriting.close()
        process.waitUntilExit()
        #expect(process.terminationStatus == 0)
    }
}
