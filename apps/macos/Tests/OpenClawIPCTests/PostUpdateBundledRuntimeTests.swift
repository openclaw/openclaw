import Foundation
import Testing
@testable import OpenClaw

@MainActor
struct PostUpdateBundledRuntimeTests {
    @Test(arguments: [PostAppUpdateCoreUpdate.complete, .gateway, .node])
    func `core dispatch preserves a superseding target regardless of owner`(_ owner: PostAppUpdateCoreUpdate) throws {
        let suite = "PostUpdateBundledRuntimeTests.dispatchTarget.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        PostAppUpdateReceiptStore.record(fromVersion: "2026.8.1", toVersion: "2026.9.1", defaults: defaults)
        let stale = try #require(PostAppUpdateReceiptStore.pending(currentVersion: "2026.9.1", defaults: defaults))
        PostAppUpdateReceiptStore.record(fromVersion: "2026.9.1", toVersion: "2026.9.2", defaults: defaults)
        if owner != .complete {
            let newer = try #require(PostAppUpdateReceiptStore.pending(currentVersion: "2026.9.2", defaults: defaults))
            try PostAppUpdateReceiptStore.recordCoreUpdateDispatch(receipt: newer, owner: owner, defaults: defaults)
        }
        let before = defaults.data(forKey: postAppUpdateReceiptKey)
        #expect(throws: GatewayHostingError.self) {
            try PostAppUpdateReceiptStore.recordCoreUpdateDispatch(receipt: stale, owner: .gateway, defaults: defaults)
        }
        #expect(defaults.data(forKey: postAppUpdateReceiptKey) == before)
    }

    @Test(arguments: [
        ("2026.9.2", "2026.9.1", false),
        ("2026.9.0", "2026.9.1", true),
        ("2026.9.1", "2026.9.1-beta.1", false),
        ("2026.9.1-beta.1", "2026.9.1", true),
    ])
    func `app launch carries core recovery forward without retargeting it backward`(
        _ pendingVersion: String, _ runningVersion: String, _ advances: Bool) throws
    {
        let suite = "PostUpdateBundledRuntimeTests.launchTarget.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        try PostAppUpdateReceiptStore.recordSetupRecovery(
            fromVersion: "2026.8.1", toVersion: pendingVersion, defaults: defaults)
        let before = defaults.data(forKey: postAppUpdateReceiptKey)
        let receipt = PostAppUpdateReceiptStore.pendingForLaunch(
            currentVersion: runningVersion, onboardingSeen: true, defaults: defaults)
        if advances {
            #expect(receipt?.toVersion == runningVersion)
            #expect(receipt?.coreUpdate == .gateway)
        } else {
            #expect(receipt == nil)
            #expect(defaults.data(forKey: postAppUpdateReceiptKey) == before)
        }
    }

    @Test(arguments: ["2026.9.0", "2026.9.1", "2026.9.2"])
    func `setup recovery explicitly retargets only forward`(_ pendingVersion: String) throws {
        let suite = "PostUpdateBundledRuntimeTests.setupTarget.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        try PostAppUpdateReceiptStore.recordSetupRecovery(
            fromVersion: "2026.8.1", toVersion: pendingVersion, defaults: defaults)
        let before = defaults.data(forKey: postAppUpdateReceiptKey)
        if pendingVersion == "2026.9.2" {
            #expect(throws: GatewayHostingError.self) {
                try PostAppUpdateReceiptStore.recordSetupRecovery(
                    fromVersion: "2026.9.1", toVersion: "2026.9.1", defaults: defaults)
            }
            #expect(defaults.data(forKey: postAppUpdateReceiptKey) == before)
        } else {
            try PostAppUpdateReceiptStore.recordSetupRecovery(
                fromVersion: "2026.9.1", toVersion: "2026.9.1", defaults: defaults)
            #expect(PostAppUpdateReceiptStore.pending(currentVersion: "2026.9.1", defaults: defaults)?
                .coreUpdate == .gateway)
        }
    }

    @Test(arguments: ["begin", "reset", "failure", "runtime-status", "begin-core", "begin-runtime"])
    func `late notification writes preserve a newer update target`(_ operation: String) throws {
        let suite = "PostUpdateBundledRuntimeTests.notificationWrites.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        PostAppUpdateReceiptStore.record(
            fromVersion: "2026.8.1", toVersion: "2026.9.1", defaults: defaults)
        let notifying = try #require(PostAppUpdateReceiptStore.pending(
            currentVersion: "2026.9.1", defaults: defaults))
        if operation == "begin-core" {
            try PostAppUpdateReceiptStore.recordCoreUpdateDispatch(
                receipt: notifying, owner: .gateway, defaults: defaults)
        } else if operation == "begin-runtime" {
            PostAppUpdateReceiptStore.recordMigrationFailure(receipt: notifying, defaults: defaults)
        } else {
            PostAppUpdateReceiptStore.record(
                fromVersion: "2026.9.1", toVersion: "2026.9.2", defaults: defaults)
            let newer = try #require(PostAppUpdateReceiptStore.pending(
                currentVersion: "2026.9.2", defaults: defaults))
            try PostAppUpdateReceiptStore.recordCoreUpdateDispatch(
                receipt: newer, owner: .gateway, defaults: defaults)
        }
        let stored = defaults.data(forKey: postAppUpdateReceiptKey)
        switch operation {
        case "failure":
            let latest = PostAppUpdateReceiptStore.recordNotificationFailure(receipt: notifying, defaults: defaults)
            #expect(latest.toVersion == "2026.9.2")
        case "runtime-status":
            let latest = PostAppUpdateReceiptStore.setGatewayUpdateIncomplete(
                false, receipt: notifying, defaults: defaults)
            #expect(latest.toVersion == "2026.9.2")
        default:
            let admitted: PostAppUpdateReceipt? = PostAppUpdateReceiptStore.setNotificationInFlight(
                operation != "reset", receipt: notifying, defaults: defaults)
            #expect(admitted == nil)
        }
        #expect(defaults.data(forKey: postAppUpdateReceiptKey) == stored)
    }

    @Test(arguments: ["core", "runtime", "replaced", "verified-setup", "verified-ordinary"])
    func `runtime verification completes only the receipt it verified`(_ scenario: String) throws {
        let suite = "PostUpdateBundledRuntimeTests.runtimeCompletion.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        if scenario == "verified-setup" {
            try PostAppUpdateReceiptStore.recordSetupRecovery(
                fromVersion: "2026.8.1", toVersion: "2026.9.1", defaults: defaults)
            PostAppUpdateReceiptStore.completeCoreRepair(
                currentVersion: "2026.9.1", owner: .gateway, defaults: defaults)
        } else {
            PostAppUpdateReceiptStore.record(
                fromVersion: "2026.8.1", toVersion: "2026.9.1", defaults: defaults)
        }
        let verifying = try #require(PostAppUpdateReceiptStore.pending(
            currentVersion: "2026.9.1", defaults: defaults))
        let pending: PostAppUpdateReceipt?
        switch scenario {
        case "core":
            pending = try PostAppUpdateReceiptStore.recordCoreUpdateDispatch(
                receipt: verifying, owner: .gateway, defaults: defaults)
        case "runtime":
            pending = PostAppUpdateReceiptStore.recordMigrationFailure(receipt: verifying, defaults: defaults)
        case "replaced":
            PostAppUpdateReceiptStore.record(
                fromVersion: "2026.9.1", toVersion: "2026.9.2", defaults: defaults)
            pending = try #require(PostAppUpdateReceiptStore.pending(
                currentVersion: "2026.9.2", defaults: defaults))
        default:
            pending = nil
        }
        let stored = defaults.data(forKey: postAppUpdateReceiptKey)
        let completion = PostAppUpdateReceiptStore.completeRuntimeVerification(receipt: verifying, defaults: defaults)
        if let pending {
            #expect(completion == .recovery(pending))
            #expect(defaults.data(forKey: postAppUpdateReceiptKey) == stored)
        } else {
            let verified = try #require(PostAppUpdateReceiptStore.pending(
                currentVersion: "2026.9.1", defaults: defaults))
            #expect(completion == .verified(verified))
            #expect(!verified.coreUpdatePending)
            #expect(!verified.gatewayUpdateIncomplete)
        }
    }

    @Test(arguments: [
        "core-delivered", "core-exhausted", "runtime-delivered", "runtime-exhausted",
        "new-target", "delivered", "retry", "exhausted",
    ])
    func `delayed notification completion preserves newer update recovery`(_ scenario: String) throws {
        let suite = "PostUpdateBundledRuntimeTests.notificationCompletion.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        PostAppUpdateReceiptStore.record(
            fromVersion: "2026.8.1", toVersion: "2026.9.1", defaults: defaults)
        var notification = try #require(PostAppUpdateReceiptStore.pending(
            currentVersion: "2026.9.1", defaults: defaults))
        if scenario.hasSuffix("exhausted") {
            notification = PostAppUpdateReceiptStore.recordNotificationFailure(
                receipt: notification, defaults: defaults)
        }
        let pending: PostAppUpdateReceipt?
        if scenario.hasPrefix("core-") {
            pending = try PostAppUpdateReceiptStore.recordCoreUpdateDispatch(
                receipt: notification, owner: .gateway, defaults: defaults)
        } else if scenario.hasPrefix("runtime-") {
            pending = PostAppUpdateReceiptStore.recordMigrationFailure(receipt: notification, defaults: defaults)
        } else if scenario == "new-target" {
            PostAppUpdateReceiptStore.record(
                fromVersion: "2026.9.1", toVersion: "2026.9.2", defaults: defaults)
            pending = try #require(PostAppUpdateReceiptStore.pending(
                currentVersion: "2026.9.2", defaults: defaults))
        } else {
            pending = nil
        }
        let stored = defaults.data(forKey: postAppUpdateReceiptKey)
        let completion = PostAppUpdateReceiptStore.finishNotification(
            receipt: notification, retry: scenario == "retry" || scenario.hasSuffix("exhausted"),
            defaults: defaults)
        if let pending {
            #expect(completion == .recovery(pending))
            #expect(defaults.data(forKey: postAppUpdateReceiptKey) == stored)
        } else if scenario == "retry" {
            let retried = try #require(PostAppUpdateReceiptStore.pending(
                currentVersion: "2026.9.1", defaults: defaults))
            #expect(completion == .retryScheduled(retried))
            #expect(retried.notificationAttempts == 1)
            #expect(!retried.coreUpdatePending)
        } else {
            #expect(completion == .complete)
            #expect(defaults.data(forKey: postAppUpdateReceiptKey) == nil)
        }
    }

    @Test(arguments: [false, true], ["onboarding", "workflow", "record", "retarget"])
    func `core repair completion preserves receipt origin across interruption and relaunch`(
        ordinaryNotice: Bool, boundary: String) throws
    {
        let suite = "PostUpdateBundledRuntimeTests.coreRepair.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let recordedAt = Date(timeIntervalSince1970: 1_720_000_000)
        if ordinaryNotice {
            PostAppUpdateReceiptStore.record(
                fromVersion: "2026.8.1", toVersion: "2026.9.1", defaults: defaults, now: recordedAt)
            var notice = try #require(PostAppUpdateReceiptStore.pendingForLaunch(
                currentVersion: "2026.9.1", currentRuntimeBuildID: "build-one", onboardingSeen: true,
                defaults: defaults))
            notice = PostAppUpdateReceiptStore.recordNotificationFailure(receipt: notice, defaults: defaults)
            PostAppUpdateReceiptStore.setNotificationInFlight(true, receipt: notice, defaults: defaults)
        }
        try PostAppUpdateReceiptStore.recordSetupRecovery(
            fromVersion: "2026.8.1", toVersion: "2026.9.1", runtimeBuildID: "build-one",
            defaults: defaults, now: recordedAt)
        let interrupted = try #require(PostAppUpdateReceiptStore.pendingForLaunch(
            currentVersion: "2026.9.1", currentRuntimeBuildID: "build-one", onboardingSeen: true,
            defaults: defaults))
        #expect(interrupted.gatewayUpdateIncomplete)
        #expect(interrupted.coreUpdatePending)
        #expect(PostUpdateController.notificationContinuation(
            receipt: interrupted, runtimeVerification: .verified, migrationOnlyLaunchCheck: false) == .waitForRuntime)
        #expect(interrupted.setupRecovery == !ordinaryNotice)

        let completed = try #require(PostAppUpdateReceiptStore.completeCoreRepair(
            currentVersion: "2026.9.1", owner: .gateway, defaults: defaults))
        #expect(completed.fromVersion == "2026.8.1")
        #expect(completed.toVersion == "2026.9.1")
        #expect(completed.recordedAt == recordedAt)
        #expect(completed.runtimeBuildID == "build-one")
        #expect(completed.notificationAttempts == (ordinaryNotice ? 1 : 0))
        #expect(completed.notificationInFlight == ordinaryNotice)
        #expect(completed.setupRecovery == !ordinaryNotice)
        #expect(completed.gatewayUpdateIncomplete == ordinaryNotice)
        #expect(!completed.coreUpdatePending)
        #expect(PostAppUpdateReceiptStore.pendingSetupRecovery(defaults: defaults) == nil)
        #expect(PostUpdateController.notificationContinuation(
            receipt: completed, runtimeVerification: .deferred, migrationOnlyLaunchCheck: false) == .waitForRuntime)

        let failedRuntime = PostAppUpdateReceiptStore.recordMigrationFailure(receipt: completed, defaults: defaults)
        let relaunched = try #require(PostAppUpdateReceiptStore.pendingForLaunch(
            currentVersion: "2026.9.1", currentRuntimeBuildID: "build-one", onboardingSeen: true,
            defaults: defaults))
        #expect(relaunched == failedRuntime)
        #expect(!relaunched.coreUpdatePending)
        #expect(relaunched.hasPendingRuntimeMigration)
        #expect(PostUpdateController.coreRepairAction(
            receipt: relaunched, migrationNeedsCoreRepair: false,
            migrationFailed: false, explicitRetry: true) == .none)
        let named = AppProfile(environment: ["OPENCLAW_PROFILE": "rollback-fixture"])
        #expect(PostUpdateController.shouldOfferRuntimeMigrationRetry(
            profile: named, receipt: relaunched, serviceInstalled: true, retainedManagedNode: true))
        #expect(!PostUpdateController.shouldOfferRuntimeMigrationRetry(
            profile: named, receipt: relaunched, serviceInstalled: true, retainedManagedNode: false))
        #expect(!PostUpdateController.shouldOfferRuntimeMigrationRetry(
            profile: named, receipt: relaunched, serviceInstalled: false, retainedManagedNode: true))
        #expect(PostUpdateController.notificationContinuation(
            receipt: failedRuntime, runtimeVerification: .deferred, migrationOnlyLaunchCheck: false) == .waitForRuntime)
        #expect(PostUpdateController.notificationContinuation(
            receipt: failedRuntime, runtimeVerification: .verified, migrationOnlyLaunchCheck: false) ==
            (ordinaryNotice ? .deliveryUnconfirmed : .completeSilently))
        switch boundary {
        case "onboarding", "workflow":
            #expect(PostAppUpdateReceiptStore.pendingForLaunch(
                currentVersion: "2026.9.1", currentRuntimeBuildID: "build-one",
                onboardingSeen: boundary != "onboarding", allowsUpdateWorkflow: boundary != "workflow",
                defaults: defaults) == nil)
            #expect(PostAppUpdateReceiptStore.pending(currentVersion: "2026.9.1", defaults: defaults) == failedRuntime)
        case "record":
            PostAppUpdateReceiptStore.record(
                fromVersion: "2026.9.1", toVersion: "2026.9.2", defaults: defaults)
            let next = try #require(PostAppUpdateReceiptStore.pending(currentVersion: "2026.9.2", defaults: defaults))
            #expect(next.hasPendingRuntimeMigration)
            #expect(!next.coreUpdatePending)
        default:
            let next = try #require(PostAppUpdateReceiptStore.pendingForLaunch(
                currentVersion: "2026.9.2", currentRuntimeBuildID: "build-two", onboardingSeen: true,
                defaults: defaults))
            #expect(next.hasPendingRuntimeMigration)
            #expect(!next.coreUpdatePending)
        }
    }

    @Test func `named bundled launches monitor migration failures without an ordinary receipt`() throws {
        let named = AppProfile(environment: ["OPENCLAW_PROFILE": "migration-fixture"])
        let receipt = try #require(PostUpdateController.launchReceipt(
            pending: nil, profile: named, bundledApp: true, onboardingSeen: true, appVersion: "2026.9.1"))
        #expect(receipt.fromVersion == "2026.9.1")
        #expect(receipt.toVersion == "2026.9.1")
        #expect(PostUpdateController.launchReceipt(
            pending: nil, profile: named, bundledApp: true, onboardingSeen: false, appVersion: "2026.9.1") == nil)
        #expect(PostUpdateController.launchReceipt(
            pending: receipt, profile: named, bundledApp: false, onboardingSeen: true, appVersion: "2026.9.1") == nil)
        #expect(PostUpdateController.launchReceipt(
            pending: receipt, profile: named, bundledApp: true, onboardingSeen: true, appVersion: "2026.9.1") ==
            receipt)
    }

    @Test func `fresh core update failure stops while deferred repair and explicit retry can proceed`() throws {
        let suite = "PostUpdateBundledRuntimeTests.coreRetry.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let ordinary = try PostAppUpdateReceiptStore.recordCoreUpdateDispatch(
            receipt: PostAppUpdateReceipt(
                fromVersion: "2026.8.1", toVersion: "2026.9.1", recordedAt: .distantPast),
            owner: .gateway, defaults: defaults)
        #expect(PostUpdateController.coreRepairAction(
            receipt: ordinary, migrationNeedsCoreRepair: false,
            migrationFailed: true, explicitRetry: false) == .reportFailure)
        #expect(PostUpdateController.coreRepairAction(
            receipt: ordinary, migrationNeedsCoreRepair: true,
            migrationFailed: true, explicitRetry: false) == .repair)
        #expect(PostUpdateController.coreRepairAction(
            receipt: ordinary, migrationNeedsCoreRepair: false,
            migrationFailed: true, explicitRetry: true) == .repair)
        let completed = try #require(PostAppUpdateReceiptStore.completeCoreRepair(
            currentVersion: ordinary.toVersion, owner: .gateway, defaults: defaults))
        let runtimeFailure = PostAppUpdateReceiptStore.recordMigrationFailure(receipt: completed, defaults: defaults)
        #expect(PostUpdateController.coreRepairAction(
            receipt: runtimeFailure, migrationNeedsCoreRepair: false,
            migrationFailed: true, explicitRetry: true) == .none)
    }

    @Test func `setup recovery survives relaunches and target changes without welcome notifications`() throws {
        let suite = "PostUpdateBundledRuntimeTests.setup.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        try PostAppUpdateReceiptStore.recordSetupRecovery(
            fromVersion: "2026.8.1", toVersion: "2026.9.1", runtimeBuildID: "build-a", defaults: defaults)
        #expect(PostAppUpdateReceiptStore.pendingForLaunch(
            currentVersion: "2026.9.1",
            currentRuntimeBuildID: "build-b",
            onboardingSeen: false,
            defaults: defaults) == nil)
        let preserved = try #require(PostAppUpdateReceiptStore.pendingSetupRecovery(defaults: defaults))
        #expect(preserved.gatewayUpdateIncomplete)
        #expect(preserved.coreUpdatePending)
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
        #expect(retargeted.coreUpdatePending)
        #expect(retargeted.setupRecovery)
        let runtimeOnly = PostAppUpdateReceiptStore.setGatewayUpdateIncomplete(
            false, receipt: retargeted, defaults: defaults)
        PostAppUpdateReceiptStore.completeSetupRecovery(currentVersion: "2026.9.2", defaults: defaults)
        #expect(PostAppUpdateReceiptStore.pending(currentVersion: "2026.9.2", defaults: defaults) == runtimeOnly)
        let verified = try #require(PostAppUpdateReceiptStore.completeCoreRepair(
            currentVersion: "2026.9.2", owner: .gateway, defaults: defaults))
        #expect(verified.setupRecovery)
        #expect(!verified.coreUpdatePending)
        PostAppUpdateReceiptStore.completeSetupRecovery(currentVersion: "2026.9.2", defaults: defaults)
        #expect(PostAppUpdateReceiptStore.pending(currentVersion: "2026.9.2", defaults: defaults) == nil)
        #expect(PostAppUpdateReceiptStore.pendingForLaunch(
            currentVersion: "2026.9.2",
            currentRuntimeBuildID: "build-c",
            onboardingSeen: true,
            defaults: defaults) == nil)

        PostAppUpdateReceiptStore.record(fromVersion: "2026.9.2", toVersion: "2026.9.3", defaults: defaults)
        try PostAppUpdateReceiptStore.recordSetupRecovery(
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
        let stored = try #require(defaults.data(forKey: postAppUpdateReceiptKey))
        var published = try #require(JSONSerialization.jsonObject(with: stored) as? [String: Any])
        published.removeValue(forKey: "coreUpdate")
        try defaults.set(JSONSerialization.data(withJSONObject: published), forKey: postAppUpdateReceiptKey)
        legacy = try #require(PostAppUpdateReceiptStore.pending(currentVersion: "2026.9.1", defaults: defaults))
        #expect(legacy.coreUpdatePending == !notificationInFlight)
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
        #expect(enriched.coreUpdatePending == !notificationInFlight)
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
        #expect(!replacement.coreUpdatePending)
        #expect(PostUpdateController.gatewayAction(
            status: .ready(location: "/fixture/openclaw", version: "2026.9.1"),
            ownsManagedRuntime: true,
            gatewayUpdateIncomplete: replacement.coreUpdatePending) == .none)
        let verified = PostAppUpdateReceiptStore.setGatewayUpdateIncomplete(
            false, receipt: replacement, defaults: defaults)
        let notified = try #require(PostAppUpdateReceiptStore.setNotificationInFlight(
            true, receipt: verified, defaults: defaults))
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
                receipt: PostAppUpdateReceipt(
                    fromVersion: "2026.8.1", toVersion: "2026.9.1", recordedAt: .distantPast,
                    gatewayUpdateIncomplete: incomplete, coreUpdate: incomplete ? .gateway : .complete))
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
                receipt: PostAppUpdateReceipt(
                    fromVersion: "2026.8.1", toVersion: "2026.9.1", recordedAt: .distantPast))
            {
                inspectedLegacy = true
                return .missing(location: "/fixture/openclaw")
            }
            #expect(!inspectedLegacy)
            #expect(resolution.action == expected)
        }
    }

    @Test(arguments: [false, true], [false, true])
    func `remote primary keeps legacy node work separate from its local companion`(
        hasCompanion: Bool,
        companionVerified: Bool) async
    {
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
                    ownsManagedRuntime: true,
                    localCompanionVerified: companionVerified),
                receipt: PostAppUpdateReceipt(
                    fromVersion: "2026.8.1", toVersion: "2026.9.1", recordedAt: .distantPast,
                    gatewayUpdateIncomplete: incomplete))
            {
                probes += 1
                return incomplete
                    ? .ready(location: "/fixture/openclaw", version: "2026.9.1")
                    : .incompatible(location: "/fixture/openclaw", found: "2026.8.1", required: "2026.9.1")
            }
            #expect(probes == 1)
            #expect(resolution.action == (incomplete ? .verify : .update))
            #expect(resolution.installedCLI?.prefix == cli.prefix)
            #expect(resolution.needsManagedVerification)
            #expect(resolution.prepareLocalCompanion == (hasCompanion && !companionVerified))
        }
        var probedAbsentService = false
        let companionOnly = await PostUpdateController.resolveGatewayAction(
            context: PostUpdateRuntimeContext(
                connectionMode: .remote,
                bundledApp: true,
                usesSeededGateway: hasCompanion,
                hasService: false,
                installedCLI: nil,
                ownsManagedRuntime: false,
                localCompanionVerified: companionVerified),
            receipt: PostAppUpdateReceipt(
                fromVersion: "2026.8.1", toVersion: "2026.9.1", recordedAt: .distantPast,
                gatewayUpdateIncomplete: true, coreUpdate: .gateway))
        {
            probedAbsentService = true
            return .missing(location: "/fixture/openclaw")
        }
        #expect(!probedAbsentService)
        #expect(companionOnly.action == .ownershipFailure)
        #expect(!companionOnly.needsManagedVerification)
        #expect(companionOnly.prepareLocalCompanion == (hasCompanion && !companionVerified))
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

    @Test func `completed migration preserves notification receipts and synthetic launches remain silent`() {
        let receipt = PostAppUpdateReceipt(
            fromVersion: "2026.8.1",
            toVersion: "2026.9.1",
            recordedAt: .distantPast,
            notificationAttempts: 1)
        for verification in [PostUpdateRuntimeVerification.deferred, .verified, .failed] {
            #expect(PostUpdateController.notificationContinuation(
                receipt: receipt,
                runtimeVerification: verification,
                migrationOnlyLaunchCheck: false) == (verification == .failed ? .waitForRuntime : .notify))
        }
        for inFlight in [false, true] {
            let pendingRuntime = PostAppUpdateReceipt(
                fromVersion: "2026.8.1",
                toVersion: "2026.9.1",
                recordedAt: .distantPast,
                gatewayUpdateIncomplete: true,
                notificationInFlight: inFlight)
            #expect(PostUpdateController.notificationContinuation(
                receipt: pendingRuntime,
                runtimeVerification: .deferred,
                migrationOnlyLaunchCheck: false) == .waitForRuntime)
            #expect(PostUpdateController.notificationContinuation(
                receipt: pendingRuntime,
                runtimeVerification: .verified,
                migrationOnlyLaunchCheck: false) == (inFlight ? .deliveryUnconfirmed : .notify))
            #expect(PostUpdateController.notificationContinuation(
                receipt: pendingRuntime,
                runtimeVerification: .verified,
                migrationOnlyLaunchCheck: true) == .completeSilently)
        }
    }

    @Test func `paused retries and unfinished setup repair stay with the core updater`() {
        let setup = PostAppUpdateReceipt(
            fromVersion: "2026.8.1",
            toVersion: "2026.9.1",
            recordedAt: .distantPast,
            gatewayUpdateIncomplete: true,
            coreUpdate: .gateway,
            setupRecovery: true)
        let migration = PostAppUpdateReceipt(
            fromVersion: "2026.8.1",
            toVersion: "2026.9.1",
            recordedAt: .distantPast,
            gatewayUpdateIncomplete: true)
        for paused in [false, true] {
            #expect(!PostUpdateController.allowsNodeMigration(paused: paused, canActivate: true, receipt: setup))
            #expect(PostUpdateController
                .allowsNodeMigration(paused: paused, canActivate: true, receipt: migration) == !paused)
            #expect(PostUpdateController
                .allowsNodeMigration(paused: paused, canActivate: true, receipt: nil) == !paused)
        }
        // A remote primary without a local companion is unpaused but has no local activation intent.
        #expect(!PostUpdateController.allowsNodeMigration(paused: false, canActivate: false, receipt: migration))
        #expect(!PostUpdateController.allowsNodeMigration(paused: false, canActivate: false, receipt: nil))
        #expect(PostUpdateController.notificationContinuation(
            receipt: setup, runtimeVerification: .deferred, migrationOnlyLaunchCheck: false) == .waitForRuntime)
    }
}
