import Foundation
import Testing
@testable import OpenClaw

@MainActor
struct PostUpdateBundledRuntimeTests {
    @Test func `setup recovery survives relaunches and target changes without welcome notifications`() throws {
        let suite = "PostUpdateBundledRuntimeTests.setup.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        PostAppUpdateReceiptStore.recordSetupRecovery(
            fromVersion: "2026.8.1", toVersion: "2026.9.1", runtimeBuildID: "build-a", defaults: defaults)
        #expect(PostAppUpdateReceiptStore.pendingForLaunch(
            currentVersion: "2026.9.1",
            currentRuntimeBuildID: "build-b",
            onboardingSeen: false,
            defaults: defaults) == nil)
        let preserved = try #require(PostAppUpdateReceiptStore.pendingSetupRecovery(defaults: defaults))
        #expect(preserved.gatewayUpdateIncomplete)
        #expect(preserved.setupRecovery)
        #expect(!PostUpdateController.isNotificationOnlyRetry(preserved))

        PostAppUpdateReceiptStore.record(fromVersion: "2026.9.1", toVersion: "2026.9.2", defaults: defaults)
        #expect(PostAppUpdateReceiptStore.pendingForLaunch(
            currentVersion: "2026.9.2",
            currentRuntimeBuildID: "build-c",
            onboardingSeen: false,
            defaults: defaults) == nil)
        let retargeted = try #require(PostAppUpdateReceiptStore.pendingForLaunch(
            currentVersion: "2026.9.2",
            currentRuntimeBuildID: "build-c",
            onboardingSeen: true,
            defaults: defaults))
        #expect(retargeted.toVersion == "2026.9.2")
        #expect(retargeted.runtimeBuildID == "build-c")
        #expect(retargeted.gatewayUpdateIncomplete)
        #expect(retargeted.setupRecovery)
        let verified = PostAppUpdateReceiptStore.setGatewayUpdateIncomplete(
            false,
            receipt: retargeted,
            defaults: defaults)
        #expect(verified.setupRecovery)
        PostAppUpdateReceiptStore.completeSetupRecovery(currentVersion: "2026.9.2", defaults: defaults)
        #expect(PostAppUpdateReceiptStore.pending(currentVersion: "2026.9.2", defaults: defaults) == nil)
        #expect(PostAppUpdateReceiptStore.pendingForLaunch(
            currentVersion: "2026.9.2",
            currentRuntimeBuildID: "build-c",
            onboardingSeen: true,
            defaults: defaults) == nil)

        PostAppUpdateReceiptStore.record(fromVersion: "2026.9.2", toVersion: "2026.9.3", defaults: defaults)
        PostAppUpdateReceiptStore.recordSetupRecovery(
            fromVersion: "2026.9.2", toVersion: "2026.9.3", defaults: defaults)
        PostAppUpdateReceiptStore.completeSetupRecovery(currentVersion: "2026.9.3", defaults: defaults)
        let appUpdate = try #require(PostAppUpdateReceiptStore.pending(currentVersion: "2026.9.3", defaults: defaults))
        #expect(!appUpdate.setupRecovery)
        #expect(appUpdate.gatewayUpdateIncomplete)
    }

    @Test(arguments: [false, true])
    func `bundled launch retains legacy Gateway and notification recovery`(notificationInFlight: Bool) throws {
        let suite = "PostUpdateBundledRuntimeTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let recordedAt = Date(timeIntervalSince1970: 1_720_000_000)
        PostAppUpdateReceiptStore.record(
            fromVersion: "2026.8.1",
            toVersion: "2026.9.1",
            defaults: defaults,
            now: recordedAt)
        var legacy = try #require(PostAppUpdateReceiptStore.pending(
            currentVersion: "2026.9.1", defaults: defaults))
        legacy = PostAppUpdateReceiptStore.setGatewayUpdateIncomplete(
            !notificationInFlight, receipt: legacy, defaults: defaults)
        legacy = PostAppUpdateReceiptStore.recordNotificationFailure(receipt: legacy, defaults: defaults)
        PostAppUpdateReceiptStore.setNotificationInFlight(
            notificationInFlight, receipt: legacy, defaults: defaults)

        let enriched = try #require(PostAppUpdateReceiptStore.pendingForLaunch(
            currentVersion: "2026.9.1",
            currentRuntimeBuildID: "build-a",
            onboardingSeen: true,
            defaults: defaults,
            now: recordedAt.addingTimeInterval(60)))
        #expect(enriched.fromVersion == "2026.8.1")
        #expect(enriched.toVersion == "2026.9.1")
        #expect(enriched.recordedAt == recordedAt)
        #expect(enriched.gatewayUpdateIncomplete == !notificationInFlight)
        #expect(enriched.notificationAttempts == 1)
        #expect(enriched.notificationInFlight == notificationInFlight)
        #expect(enriched.runtimeBuildID == "build-a")
        #expect(PostAppUpdateReceiptStore.pendingForLaunch(
            currentVersion: "2026.9.1",
            currentRuntimeBuildID: "build-a",
            onboardingSeen: true,
            defaults: defaults,
            now: recordedAt.addingTimeInterval(120)) == enriched)
    }

    @Test func `same version runtime rebuild is updated once and preserves failed retries`() throws {
        let suite = "PostUpdateBundledRuntimeTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let now = Date(timeIntervalSince1970: 1_720_000_000)

        #expect(PostAppUpdateReceiptStore.pendingForLaunch(
            currentVersion: "2026.9.1",
            currentRuntimeBuildID: "build-a",
            onboardingSeen: false,
            defaults: defaults,
            now: now) == nil)
        #expect(PostAppUpdateReceiptStore.pendingForLaunch(
            currentVersion: "2026.9.1",
            currentRuntimeBuildID: "build-a",
            onboardingSeen: true,
            defaults: defaults,
            now: now) == nil)

        let update = try #require(PostAppUpdateReceiptStore.pendingForLaunch(
            currentVersion: "2026.9.1",
            currentRuntimeBuildID: "build-b",
            onboardingSeen: true,
            defaults: defaults,
            now: now))
        #expect(update.fromVersion == "2026.9.1")
        #expect(update.toVersion == "2026.9.1")
        #expect(update.runtimeBuildID == "build-b")

        let incomplete = PostAppUpdateReceiptStore.setGatewayUpdateIncomplete(
            true, receipt: update, defaults: defaults)
        #expect(PostAppUpdateReceiptStore.pendingForLaunch(
            currentVersion: "2026.9.1",
            currentRuntimeBuildID: "build-b",
            onboardingSeen: true,
            defaults: defaults,
            now: now) == incomplete)

        let replacement = try #require(PostAppUpdateReceiptStore.pendingForLaunch(
            currentVersion: "2026.9.1",
            currentRuntimeBuildID: "build-c",
            onboardingSeen: true,
            defaults: defaults,
            now: now))
        #expect(replacement.runtimeBuildID == "build-c")
        #expect(replacement.gatewayUpdateIncomplete)
        #expect(PostUpdateController.gatewayAction(
            status: .ready(location: "/fixture/openclaw", version: "2026.9.1"),
            ownsManagedRuntime: true,
            gatewayUpdateIncomplete: replacement.gatewayUpdateIncomplete) == .repair)
        let notified = PostAppUpdateReceiptStore.setNotificationInFlight(
            true, receipt: replacement, defaults: defaults)
        let retry = PostAppUpdateReceiptStore.recordNotificationFailure(receipt: notified, defaults: defaults)
        #expect(retry.runtimeBuildID == "build-c")
        PostAppUpdateReceiptStore.clear(defaults: defaults)
        #expect(PostAppUpdateReceiptStore.pendingForLaunch(
            currentVersion: "2026.9.1",
            currentRuntimeBuildID: "build-c",
            onboardingSeen: true,
            defaults: defaults,
            now: now) == nil)
    }

    @Test(arguments: [false, true], [
        "/fixture/state/tools/node/bin/node",
        "/fixture/state/runtime/build/bin/bun",
    ])
    func `bundled app selects the legacy service updater even beside a seed`(
        seedExists: Bool,
        executable: String) async
    {
        let state = URL(fileURLWithPath: "/fixture/state")
        let cli = GatewayLaunchAgentManager.InstalledServiceCLI(
            prefix: [executable, "/fixture/state/lib/node_modules/openclaw/dist/index.js"],
            sqliteLibrary: nil)
        let cases: [(CLIInstaller.Status, Bool, PostUpdateGatewayAction)] = [
            (.incompatible(location: "/fixture/openclaw", found: "2026.8.1", required: "2026.9.1"), false, .update),
            (.ready(location: "/fixture/openclaw", version: "2026.9.1"), true, .repair),
            (.unusable(location: "/fixture/openclaw"), true, .managedRuntimeUnavailable),
        ]
        for (status, incomplete, expected) in cases {
            let usesSeededGateway = GatewayHosting.usesSeededGateway(
                hasService: true,
                installedCLI: cli,
                hasCurrentSeed: seedExists,
                stateDirectory: state)
            #expect(!usesSeededGateway)
            var inspectedLegacy = false
            let resolution = await PostUpdateController.resolveGatewayAction(
                context: PostUpdateRuntimeContext(
                    bundledApp: true,
                    usesSeededGateway: usesSeededGateway,
                    hasService: true,
                    installedCLI: cli,
                    ownsManagedRuntime: true),
                gatewayUpdateIncomplete: incomplete)
            {
                inspectedLegacy = true
                return status
            }
            #expect(inspectedLegacy)
            #expect(resolution.action == expected)
            #expect(resolution.action != .prepareBundledRuntime)
        }
    }

    @Test(arguments: [false, true])
    func `bundled service ownership survives missing current metadata`(seedExists: Bool) async {
        let state = URL(fileURLWithPath: "/fixture/state")
        let cases: [([String]?, Bool, Bool, PostUpdateGatewayAction)] = [
            (nil, false, false, seedExists ? .prepareBundledRuntime : .none),
            (
                ["/fixture/state/runtime/build/bin/bun", "/fixture/state/runtime/build/lib/openclaw.mjs"],
                true,
                true,
                .prepareBundledRuntime),
            // Seeded packages with an operator runtime still use the bundled update owner,
            // whose reinstall guard reports the operator pin without replacing it.
            (
                ["/operator/bun", "/fixture/state/runtime/build/lib/openclaw.mjs"],
                true,
                true,
                .prepareBundledRuntime),
            (["/operator/node", "/operator/openclaw/dist/index.js"], true, false, .none),
            (nil, true, true, .managedRuntimeUnavailable),
        ]
        for (prefix, hasService, owned, expected) in cases {
            let cli = prefix.map {
                GatewayLaunchAgentManager.InstalledServiceCLI(prefix: $0, sqliteLibrary: nil)
            }
            let usesSeededGateway = GatewayHosting.usesSeededGateway(
                hasService: hasService,
                installedCLI: cli,
                hasCurrentSeed: seedExists,
                stateDirectory: state)
            var inspectedLegacy = false
            let resolution = await PostUpdateController.resolveGatewayAction(
                context: PostUpdateRuntimeContext(
                    bundledApp: true,
                    usesSeededGateway: usesSeededGateway,
                    hasService: hasService,
                    installedCLI: cli,
                    ownsManagedRuntime: owned),
                gatewayUpdateIncomplete: false)
            {
                inspectedLegacy = true
                return .missing(location: "/fixture/openclaw")
            }
            #expect(!inspectedLegacy)
            #expect(resolution.action == expected)
        }
    }

    @Test(arguments: [false, true])
    func `remote primary keeps legacy node work separate from its local companion`(hasCompanion: Bool) async {
        let cli = GatewayLaunchAgentManager.InstalledServiceCLI(
            prefix: ["/fixture/state/tools/node/bin/node", "/fixture/state/lib/node_modules/openclaw/dist/index.js"],
            sqliteLibrary: nil)
        for incomplete in [false, true] {
            var probes = 0
            let resolution = await PostUpdateController.resolveGatewayAction(
                context: PostUpdateRuntimeContext(
                    connectionMode: .remote,
                    bundledApp: true,
                    usesSeededGateway: hasCompanion,
                    hasService: true,
                    installedCLI: cli,
                    ownsManagedRuntime: true),
                gatewayUpdateIncomplete: incomplete)
            {
                probes += 1
                return incomplete
                    ? .ready(location: "/fixture/openclaw", version: "2026.9.1")
                    : .incompatible(location: "/fixture/openclaw", found: "2026.8.1", required: "2026.9.1")
            }
            #expect(probes == 1)
            #expect(resolution.action == (incomplete ? .repair : .update))
            #expect(resolution.installedCLI?.prefix == cli.prefix)
            #expect(resolution.needsManagedVerification)
            #expect(resolution.prepareLocalCompanion == hasCompanion)
        }
        var probedAbsentService = false
        let companionOnly = await PostUpdateController.resolveGatewayAction(
            context: PostUpdateRuntimeContext(
                connectionMode: .remote,
                bundledApp: true,
                usesSeededGateway: hasCompanion,
                hasService: false,
                installedCLI: nil,
                ownsManagedRuntime: false),
            gatewayUpdateIncomplete: true)
        {
            probedAbsentService = true
            return .missing(location: "/fixture/openclaw")
        }
        #expect(!probedAbsentService)
        #expect(companionOnly.action == .none)
        #expect(!companionOnly.needsManagedVerification)
        #expect(companionOnly.prepareLocalCompanion == hasCompanion)
    }

    @Test func `bundled Gateway updates never select package registry work`() {
        let statuses: [CLIInstaller.Status?] = [
            nil,
            .ready(location: "/fixture/openclaw", version: "2026.9.1"),
            .missing(location: "/fixture/openclaw"),
            .unusable(location: "/fixture/openclaw"),
            .incompatible(location: "/fixture/openclaw", found: "2026.8.1", required: "2026.9.1"),
        ]
        for status in statuses {
            for incomplete in [false, true] {
                #expect(PostUpdateController.gatewayAction(
                    status: status,
                    ownsManagedRuntime: true,
                    gatewayUpdateIncomplete: incomplete,
                    usesBundledRuntime: true) == .prepareBundledRuntime)
                #expect(PostUpdateController.gatewayAction(
                    status: status,
                    ownsManagedRuntime: false,
                    gatewayUpdateIncomplete: incomplete,
                    usesBundledRuntime: true) == (incomplete ? .ownershipFailure : .none))
            }
        }
    }
}
