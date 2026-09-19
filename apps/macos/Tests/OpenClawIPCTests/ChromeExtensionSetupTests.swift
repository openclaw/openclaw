import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@MainActor
struct ChromeExtensionSetupTests {
    private let prepared = ChromeExtensionSetup.Result(
        action: .install,
        target: .init(
            kind: "local-host", platform: "darwin", hostname: "Example Mac", profile: "chrome", relayPort: 18792),
        phase: .needsBrowserAction, reason: "chrome_approval_required",
        installation: .init(
            nativeHostRegistered: true, installRequested: true, discoveredProfiles: 0,
            awaitingApproval: true, automaticBootstrapSupported: true),
        connection: .init(state: .notChecked, extensionVersion: nil), nextAction: .approveExtension)

    @Test(arguments: [["OpenClaw"], ["OpenClaw", "--background-only"]])
    func `admitted startup and successful CLI updates serialize with manual retry`(arguments: [String]) async throws {
        let center = NotificationCenter()
        let events = AsyncStream<Void>.makeStream()
        var iterator = events.stream.makeAsyncIterator()
        var release: CheckedContinuation<Void, Never>?
        var calls = 0
        var active = 0
        var peak = 0
        let setup = ChromeExtensionSetup { _ in
            calls += 1
            active += 1
            peak = max(peak, active)
            defer { active -= 1 }
            if calls == 1 {
                await withCheckedContinuation { continuation in
                    release = continuation
                    events.continuation.yield(())
                }
            } else {
                events.continuation.yield(())
            }
            return self.prepared
        }
        defer {
            setup.stop()
            events.continuation.finish()
        }
        let plan = AppLaunchRuntimePlan(arguments: arguments)
        setup.start(plan: plan, profile: AppProfile(environment: [:]), center: center)
        setup.start(plan: plan, profile: AppProfile(environment: [:]), center: center)
        await iterator.next()
        #expect(calls == 1)
        center.post(name: .openclawCLIInstalled, object: nil)
        let manual = Task { try await setup.run(action: .install) { true } }
        release?.resume()
        await iterator.next()
        await iterator.next()
        #expect(try await manual.value == self.prepared)
        #expect(calls == 3)
        #expect(peak == 1)
    }

    @Test func `elevation helper never installs browser artifacts`() async throws {
        var calls = 0
        let setup = ChromeExtensionSetup { _ in
            calls += 1
            return self.prepared
        }
        defer { setup.stop() }
        let center = NotificationCenter()
        setup.start(plan: AppLaunchRuntimePlan(arguments: ["OpenClaw", "--elevation-host"]), center: center)
        center.post(name: .openclawCLIInstalled, object: nil)
        // A manual operation drains the same queue, proving neither startup nor the notification enqueued work.
        #expect(try await setup.run(action: .install) { true } == self.prepared)
        #expect(calls == 1)
    }

    @Test func `best effort startup failure leaves manual retry available`() async throws {
        var calls = 0
        let setup = ChromeExtensionSetup { _ in
            calls += 1
            if calls == 1 { throw ChromeExtensionSetup.SetupError.unavailable }
            return self.prepared
        }
        defer { setup.stop() }
        setup.start(
            plan: AppLaunchRuntimePlan(arguments: ["OpenClaw"]),
            profile: AppProfile(environment: [:]),
            center: NotificationCenter())
        #expect(try await setup.run(action: .install) { true } == self.prepared)
        #expect(calls == 2)
    }

    @Test(arguments: [false, true])
    func `queued manual retry cannot write after retirement or cancellation`(cancel: Bool) async throws {
        let started = AsyncStream<Void>.makeStream()
        var iterator = started.stream.makeAsyncIterator()
        var release: CheckedContinuation<Void, Never>?
        var calls = 0
        var current = true
        let setup = ChromeExtensionSetup { _ in
            calls += 1
            await withCheckedContinuation { continuation in
                release = continuation
                started.continuation.yield(())
            }
            return self.prepared
        }
        defer {
            setup.stop()
            started.continuation.finish()
        }
        setup.start(
            plan: AppLaunchRuntimePlan(arguments: ["OpenClaw"]),
            profile: AppProfile(environment: [:]),
            center: NotificationCenter())
        await iterator.next()
        let admitted = AsyncStream<Void>.makeStream()
        var admissions = admitted.stream.makeAsyncIterator()
        let manual = Task {
            try await setup.run(action: .install) {
                admitted.continuation.yield(())
                return current
            }
        }
        await admissions.next()
        if cancel {
            manual.cancel()
            await #expect(throws: ChromeExtensionSetup.SetupError.self) { try await manual.value }
        } else {
            current = false
        }
        release?.resume()
        await #expect(throws: ChromeExtensionSetup.SetupError.self) { try await manual.value }
        #expect(calls == 1)
        admitted.continuation.finish()
    }

    @Test func `named app profiles do not claim the shared Chrome manifest automatically`() async throws {
        var calls = 0
        let setup = ChromeExtensionSetup { _ in
            calls += 1
            return self.prepared
        }
        defer { setup.stop() }
        let center = NotificationCenter()
        setup.start(
            plan: AppLaunchRuntimePlan(arguments: ["OpenClaw"]),
            profile: AppProfile(environment: ["OPENCLAW_PROFILE": "fixture"]),
            center: center)
        center.post(name: .openclawCLIInstalled, object: nil)
        #expect(try await setup.run(action: .install) { true } == self.prepared)
        #expect(calls == 1)
    }

    @Test func `canceling active manual setup reaches its child without canceling later retries`() async throws {
        let started = AsyncStream<Void>.makeStream()
        var iterator = started.stream.makeAsyncIterator()
        var calls = 0
        var cancelled = false
        let setup = ChromeExtensionSetup { _ in
            calls += 1
            if calls == 1 {
                started.continuation.yield(())
                do {
                    try await Task.sleep(for: .seconds(60))
                } catch {
                    cancelled = Task.isCancelled
                    throw error
                }
            }
            return self.prepared
        }
        defer {
            setup.stop()
            started.continuation.finish()
        }
        let manual = Task { try await setup.run(action: .install) { true } }
        await iterator.next()
        manual.cancel()
        await #expect(throws: ChromeExtensionSetup.SetupError.self) { try await manual.value }
        #expect(try await setup.run(action: .install) { true } == self.prepared)
        #expect(cancelled)
        #expect(calls == 2)
    }

    private static let pending = """
    {"action":"install","target":{"kind":"local-host","platform":"darwin","hostname":"Example Mac",
    "profile":"chrome","relayPort":18792},"phase":"needs_browser_action","reason":"chrome_approval_required",
    "installation":{"nativeHostRegistered":true,"installRequested":true,"discoveredProfiles":0,
    "awaitingApproval":true,"automaticBootstrapSupported":true},"connection":{"state":"not_checked"},
    "nextAction":"approve_extension","privatePath":"must not cross bridge"}
    """

    @Test(arguments: ChromeExtensionSetupAction.allCases)
    func `canonical actions pass through the serialized owner`(action: ChromeExtensionSetupAction) async throws {
        let setup = ChromeExtensionSetup { selected in
            try ChromeExtensionSetup.readResult(
                Self.pending.replacingOccurrences(
                    of: "\"action\":\"install\"", with: "\"action\":\"\(selected.rawValue)\""),
                action: selected)
        }
        defer { setup.stop() }
        let result = try await setup.run(action: action) { true }
        #expect(result.action == action)
        #expect(ChromeExtensionSetup.arguments(action: action) == [
            "browser", "extension", "setup", "--action", action.rawValue,
            "--json", "--wait-ms", "1000",
        ])
    }

    @Test func `canonical saved browser profile crosses the native result boundary`() throws {
        let result = try ChromeExtensionSetup.readResult(
            Self.pending.replacingOccurrences(of: "\"profile\":\"chrome\"", with: "\"profile\":\"work\""),
            action: .install)
        #expect(result.target.profile == "work")
        #expect(!ChromeExtensionSetup.arguments(action: .install).contains("--browser-profile"))
    }

    @Test func `released bridge receives exactly its three canonical installation fields`() throws {
        let result = try ChromeExtensionSetup.readResult(Self.pending, action: .install)
        let bytes = try JSONEncoder().encode(result.legacyInstallation)
        let actual = try #require(JSONSerialization.jsonObject(with: bytes) as? NSDictionary)
        #expect(actual == ["nativeHostRegistered": true, "installRequested": true, "discoveredProfiles": 0])
    }

    @Test func `registration and pending approval preserve controller state without claiming connected`() throws {
        let result = try ChromeExtensionSetup.readResult(Self.pending, action: .install)
        #expect(result.installation.nativeHostRegistered)
        #expect(result.installation.awaitingApproval)
        #expect(result.phase == .needsBrowserAction)
        #expect(result.connection.state == .notChecked)
        #expect(result.nextAction == .approveExtension)
        let json = try #require(String(data: JSONEncoder().encode(result), encoding: .utf8))
        #expect(!json.contains("privatePath"))
    }

    @Test(arguments: [
        ("local-host", "remote-host"), ("darwin", "linux"), ("18792", "0"),
        ("\"profile\":\"chrome\"", "\"profile\":\"invalid/profile\""),
        ("needs_browser_action", "unknown"), ("chrome_approval_required", "raw private diagnostic"),
    ])
    func `rejects invalid host targets and controller states`(_ replacement: (String, String)) {
        #expect(throws: (any Error).self) {
            try ChromeExtensionSetup.readResult(
                Self.pending.replacingOccurrences(of: replacement.0, with: replacement.1), action: .install)
        }
    }

    @Test func `rejects a result belonging to another action`() {
        #expect(throws: (any Error).self) {
            try ChromeExtensionSetup.readResult(Self.pending, action: .verify)
        }
    }
}
