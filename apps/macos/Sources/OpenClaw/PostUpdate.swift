import AppKit
import Foundation
import Observation
import OpenClawChatUI
import OpenClawKit
import SwiftUI

@MainActor
@Observable
final class PostUpdateModel {
    enum Phase: Equatable {
        case checking
        case updating
        case verifying
        case notifying
        case deferred
        case complete
        case failed
    }

    var phase: Phase = .checking
    var title = String(localized: "Finishing your OpenClaw update")
    var message = String(localized: "Checking the Mac app and Gateway…")
    var details: String?

    var isWorking: Bool {
        switch self.phase {
        case .checking, .updating, .verifying, .notifying: true
        case .deferred, .complete, .failed: false
        }
    }

    var mood: OpenClawMascotMood {
        switch self.phase {
        case .checking, .updating, .verifying, .notifying: .working
        case .deferred: .idle
        case .complete: .celebrating
        case .failed: .sad
        }
    }
}

enum PostUpdateGatewayAction: Equatable {
    case none
    case verify
    case ownershipFailure
    case repair
    case update
    case install
    case prepareBundledRuntime
    case managedRuntimeUnavailable
}

enum PostUpdateRuntimeVerification: Equatable {
    case verified
    case deferred
    case failed
}

struct PostUpdateRuntimeContext {
    var connectionMode: AppState.ConnectionMode = .local
    let bundledApp: Bool
    let usesSeededGateway: Bool
    let hasService: Bool
    let installedCLI: GatewayLaunchAgentManager.InstalledServiceCLI?
    let ownsManagedRuntime: Bool
    var localCompanionVerified = false
}

struct PostUpdateGatewayResolution {
    var connectionMode: AppState.ConnectionMode = .local
    let action: PostUpdateGatewayAction
    let installedCLI: GatewayLaunchAgentManager.InstalledServiceCLI?
    let prepareLocalCompanion: Bool
    let serviceInstalled: Bool

    func shouldRestartGateway(connectionMode: AppState.ConnectionMode, paused: Bool) -> Bool {
        self.connectionMode == .local && connectionMode == .local && !paused && self.serviceInstalled
    }

    func shouldResolveCurrentMode(
        after coreUpdate: PostAppUpdateCoreUpdate,
        currentMode: AppState.ConnectionMode) -> Bool
    {
        guard self.action == .repair || self.action == .update else { return false }
        return coreUpdate == .legacyCanonical || self.connectionMode == .remote ||
            self.connectionMode != currentMode
    }

    var needsManagedVerification: Bool {
        switch self.action {
        case .verify, .repair, .update, .install: true
        default: false
        }
    }
}

struct PostUpdateSessionsResponse: Decodable {
    let sessions: [PostUpdateSession]
    let nextOffset: Int?
}

struct PostUpdateSession: Decodable {
    let key: String
    let kind: String
    let lastChannel: String?
    let lastInteractionAt: Double?
    let spawnedBy: String?
    let parentSessionKey: String?
}

enum PostUpdateNotificationContinuation: Equatable {
    case waitForRuntime
    case notify
    case deliveryUnconfirmed
    case completeSilently
}

enum PostUpdateCoreRepairAction: Equatable {
    case none
    case repair
    case reportFailure
}

enum PostUpdateNotificationOutcome: Equatable {
    case delivered
    case noEligibleSession
    case deliveryUnconfirmed
    case skippedUnsupportedGateway
    case skippedWhilePaused
    case retryLater

    var consumesReceipt: Bool {
        self != .retryLater
    }
}

@MainActor
final class PostUpdateController: NSObject, NSWindowDelegate {
    static let shared = PostUpdateController()
    static let updateGuideURL = URL(string: "https://docs.openclaw.ai/install/updating")!
    static let discordURL = URL(string: "https://discord.gg/clawd")!

    private let model = PostUpdateModel()
    private var receipt: PostAppUpdateReceipt?
    private var window: NSWindow?
    private var task: Task<Void, Never>?
    private var retryNodeMigration = false
    private var retryCoreRepair = false
    private var migrationOnlyLaunchCheck = false

    @discardableResult
    func startIfNeeded(profile: AppProfile = .current) -> Bool {
        guard self.task == nil else { return true }
        try? GatewayProcessManager.shared.initializeGatewayHosting()
        guard (try? GatewayProcessManager.shared.shouldDeferLegacyServiceWhilePaused()) == false else { return false }
        guard !profile.isActive || BundledRuntime.isBundledApp else { return false }
        let pending = PostAppUpdateReceiptStore.pendingForLaunch(
            currentVersion: GatewayEnvironment.appVersionString(),
            currentRuntimeBuildID: Bundle.main.infoDictionary?["OpenClawRuntimeBuildID"] as? String,
            onboardingSeen: AppStateStore.shared.onboardingSeen,
            allowsUpdateWorkflow: BundledRuntime.isBundledApp || !CLIInstallBuild.isDebug)
        // A legacy Node migration can fail on the first launch of a same-version rebuild,
        // even when there is no ordinary app update receipt left to replay.
        guard let receipt = Self.launchReceipt(
            pending: pending,
            profile: profile,
            bundledApp: BundledRuntime.isBundledApp,
            onboardingSeen: AppStateStore.shared.onboardingSeen,
            appVersion: GatewayEnvironment.appVersionString())
        else { return false }
        self.migrationOnlyLaunchCheck = pending == nil
        self.receipt = receipt
        self.run()
        return true
    }

    static func launchReceipt(
        pending: PostAppUpdateReceipt?,
        profile: AppProfile,
        bundledApp: Bool,
        onboardingSeen: Bool,
        appVersion: String?) -> PostAppUpdateReceipt?
    {
        guard !profile.isActive || bundledApp else { return nil }
        if let pending { return pending }
        guard bundledApp, onboardingSeen, let appVersion else { return nil }
        return PostAppUpdateReceipt(fromVersion: appVersion, toVersion: appVersion, recordedAt: Date())
    }

    func retry() {
        guard self.receipt != nil, !self.model.isWorking else { return }
        let pendingSetup = PostAppUpdateReceiptStore.pendingSetupRecovery()
        if let pendingSetup { self.receipt = pendingSetup }
        let allowsMigration = Self.allowsNodeMigration(
            paused: AppStateStore.shared.isPaused,
            canActivate: GatewayProcessManager.shared.desiredActive && !GatewayProcessManager.shared.isTerminating,
            receipt: self.receipt)
        let retained = try? GatewayProcessManager.shared.nodeMigrationRetainedCLI()
        let retainedManagedNode = retained?.hadRuntimePin == false && retained?.prefix.first.map {
            GatewayLaunchAgentManager.isManagedNode($0, stateDirectory: AppProfile.current.stateDirectoryURL())
        } == true
        self.retryCoreRepair = Self.coreRepairAction(
            receipt: self.receipt,
            migrationNeedsCoreRepair: GatewayProcessManager.shared.nodeMigrationNeedsCoreRepair,
            migrationFailed: GatewayProcessManager.shared.nodeMigrationFailure != nil,
            explicitRetry: true) == .repair
        self.retryNodeMigration = allowsMigration && !self.retryCoreRepair &&
            (GatewayProcessManager.shared.nodeMigrationFailure != nil ||
                GatewayProcessManager.shared.nodeMigrationVersionUpdated || retainedManagedNode)
        if !allowsMigration, self.receipt?.gatewayUpdateIncomplete == true {
            self.migrationOnlyLaunchCheck = false
        }
        self.run(source: .request)
    }

    static func allowsNodeMigration(paused: Bool, canActivate: Bool, receipt: PostAppUpdateReceipt?) -> Bool {
        canActivate && !paused && receipt?.coreUpdatePending != true
    }

    static func coreRepairAction(
        receipt: PostAppUpdateReceipt?,
        migrationNeedsCoreRepair: Bool,
        migrationFailed: Bool,
        explicitRetry: Bool) -> PostUpdateCoreRepairAction
    {
        guard receipt?.coreUpdatePending == true else { return .none }
        if receipt?.coreUpdate == .gateway, migrationFailed, !migrationNeedsCoreRepair, !explicitRetry {
            return .reportFailure
        }
        return .repair
    }

    func close() {
        self.window?.close()
    }

    func openUpdateGuide() {
        AppActivation.shared.open(Self.updateGuideURL)
    }

    func openDiscord() {
        AppActivation.shared.open(Self.discordURL)
    }

    func windowWillClose(_ notification: Notification) {
        guard let closing = notification.object as? NSWindow, closing === window else { return }
        self.window = nil
    }

    private func show() {
        if let window {
            DockIconManager.shared.temporarilyShowDock()
            AppActivation.shared.makeKeyAndOrderFront(window: window)
            AppActivation.shared.activate()
            return
        }
        let hosting = NSHostingController(rootView: PostUpdateView(model: model))
        let window = NSWindow(contentViewController: hosting)
        window.isRestorable = false
        window.title = String(localized: "OpenClaw updated")
        window.setContentSize(NSSize(width: 560, height: 600))
        window.styleMask = OnboardingController.windowStyleMask
        window.contentMinSize = NSSize(width: 560, height: 600)
        window.contentMaxSize = NSSize(width: 560, height: 760)
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = true
        window.delegate = self
        window.center()
        DockIconManager.shared.temporarilyShowDock()
        AppActivation.shared.makeKeyAndOrderFront(window: window)
        AppActivation.shared.activate()
        self.window = window
    }

    private func run(source: GatewayProcessManager.ActivationSource = .recovery) {
        guard (try? GatewayProcessManager.shared.shouldDeferLegacyServiceWhilePaused()) == false else { return }
        guard let receipt, task == nil else { return }
        if self.stopSupersededUpdate(receipt) { return }
        self.model.phase = .checking
        self.model.title = String(localized: "Finishing your OpenClaw update")
        self.model.message = String(localized: "Checking the Mac app and Gateway…")
        self.model.details = nil
        self.window?.standardWindowButton(.closeButton)?.isEnabled = false
        let generation = GatewayProcessManager.shared.gatewayStartGeneration
        self.task = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.finishUpdate(receipt: receipt, source: source, generation: generation)
            self.window?.standardWindowButton(.closeButton)?.isEnabled = true
            self.task = nil
        }
    }

    private func finishNodeMigrationIfNeeded(
        receipt: PostAppUpdateReceipt,
        connectionMode: AppState.ConnectionMode) async -> Bool
    {
        guard BundledRuntime.isBundledApp else { return false }
        await GatewayProcessManager.shared.waitForStartupAttempt()
        let pendingSetup = PostAppUpdateReceiptStore.pendingSetupRecovery()
        var currentReceipt = pendingSetup ?? PostAppUpdateReceiptStore
            .pending(currentVersion: receipt.toVersion) ?? receipt
        self.receipt = currentReceipt
        let manager = GatewayProcessManager.shared
        let retained = try? manager.nodeMigrationRetainedCLI()
        let coreRepair = Self.coreRepairAction(
            receipt: currentReceipt,
            migrationNeedsCoreRepair: manager.nodeMigrationNeedsCoreRepair,
            migrationFailed: manager.nodeMigrationFailure != nil,
            explicitRetry: self.retryCoreRepair)
        self.retryCoreRepair = false
        if coreRepair == .repair {
            self.retryNodeMigration = false
            self.migrationOnlyLaunchCheck = false
            return false
        }
        if coreRepair == .reportFailure, let failure = manager.nodeMigrationFailure {
            guard self.setGatewayUpdateIncomplete(true, receipt: currentReceipt) else { return true }
            self.show()
            self.fail(message: String(localized: "The Gateway runtime migration could not finish."), details: failure)
            return true
        }
        guard Self.allowsNodeMigration(
            paused: AppStateStore.shared.isPaused,
            canActivate: GatewayProcessManager.shared.desiredActive && !GatewayProcessManager.shared.isTerminating,
            receipt: currentReceipt)
        else {
            self.retryNodeMigration = false
            if pendingSetup != nil || currentReceipt.gatewayUpdateIncomplete { self.migrationOnlyLaunchCheck = false }
            return false
        }
        if self.retryNodeMigration {
            self.retryNodeMigration = false
            self.model.phase = .updating
            self.model.message = String(localized: "Switching the Gateway to the bundled runtime…")
            self.show()
            do { try await GatewayProcessManager.shared.retryManagedNodeMigration() } catch {
                currentReceipt = PostAppUpdateReceiptStore.pendingSetupRecovery() ??
                    PostAppUpdateReceiptStore.pending(currentVersion: receipt.toVersion) ?? currentReceipt
                self.receipt = PostAppUpdateReceiptStore.recordMigrationFailure(receipt: currentReceipt)
                self.fail(
                    message: String(localized: "The Gateway runtime migration could not finish."),
                    details: error.localizedDescription)
                return true
            }
            currentReceipt = PostAppUpdateReceiptStore.pendingSetupRecovery() ??
                PostAppUpdateReceiptStore.pending(currentVersion: receipt.toVersion) ?? currentReceipt
        }
        if let failure = GatewayProcessManager.shared.nodeMigrationFailure {
            self.receipt = PostAppUpdateReceiptStore.recordMigrationFailure(receipt: currentReceipt)
            self.show()
            self.fail(
                message: String(localized: "The Gateway runtime migration could not finish."),
                details: failure)
            return true
        }
        if !manager.nodeMigrationCompleted, Self.shouldOfferRuntimeMigrationRetry(
            profile: .current,
            receipt: currentReceipt,
            serviceInstalled: GatewayLaunchAgentManager.launchdProgramArguments()?.isEmpty == false,
            retainedManagedNode: retained?.hadRuntimePin == false && retained?.prefix.first.map {
                GatewayLaunchAgentManager.isManagedNode($0, stateDirectory: AppProfile.current.stateDirectoryURL())
            } == true)
        {
            self.show()
            self.fail(
                message: String(localized: "The Gateway runtime migration could not finish."),
                details: "The restored Node Gateway is still running. Choose Retry to finish switching it to Bun.")
            return true
        }
        if GatewayProcessManager.shared.nodeMigrationVersionUpdated {
            guard self.setGatewayUpdateIncomplete(true, receipt: currentReceipt) else { return true }
            self.deferNodeRuntimeMigration()
            return true
        }
        if GatewayProcessManager.shared.nodeMigrationCompleted {
            // This migration verified the local companion, not a remote-primary Mac node service.
            guard connectionMode != .remote,
                  AppStateStore.shared.connectionMode == connectionMode else { return false }
            return await self.finishNotificationIfReady(
                receipt: currentReceipt, connectionMode: connectionMode, runtimeVerification: .verified)
        }
        return false
    }

    private func finishNotificationIfReady(
        receipt: PostAppUpdateReceipt,
        connectionMode: AppState.ConnectionMode,
        runtimeVerification: PostUpdateRuntimeVerification = .deferred,
        readyConnectionMode: AppState.ConnectionMode? = nil) async -> Bool
    {
        if self.stopSupersededUpdate(receipt) { return true }
        let continuation = Self.notificationContinuation(
            receipt: receipt,
            runtimeVerification: runtimeVerification,
            migrationOnlyLaunchCheck: self.migrationOnlyLaunchCheck)
        guard continuation != .waitForRuntime else { return false }
        if self.shouldDeferBundledRuntimeCompletion(receipt: receipt, connectionMode: connectionMode) {
            self.deferRuntimeVerification()
            return true
        }
        if runtimeVerification == .verified {
            switch PostAppUpdateReceiptStore.completeRuntimeVerification(receipt: receipt) {
            case let .verified(updated):
                self.receipt = updated
            case let .recovery(pending):
                self.showPendingUpdateRecovery(pending)
                return true
            }
        }
        switch continuation {
        case .waitForRuntime:
            return false
        case .notify:
            await self.finishNotification(
                receipt: receipt, connectionMode: connectionMode, readyConnectionMode: readyConnectionMode)
        case .deliveryUnconfirmed:
            self.finishNotification(
                outcome: .deliveryUnconfirmed,
                receipt: receipt,
                connectionMode: readyConnectionMode ?? self.notificationReadyConnectionMode(connectionMode))
        case .completeSilently:
            self.model.phase = .complete
            self.model.message = String(localized: "The Gateway is ready on the bundled runtime.")
            self.model.details = nil
            PostAppUpdateReceiptStore.clear()
            self.receipt = nil
        }
        return true
    }

    private func finishUpdate(
        receipt: PostAppUpdateReceipt,
        source: GatewayProcessManager.ActivationSource,
        generation: UInt64) async
    {
        if BundledRuntime.isBundledApp { await GatewayProcessManager.shared.waitForStartupAttempt() }
        var receipt = PostAppUpdateReceiptStore.pendingSetupRecovery() ??
            PostAppUpdateReceiptStore.pending(currentVersion: receipt.toVersion) ?? receipt
        if self.stopSupersededUpdate(receipt) { return }
        self.receipt = receipt
        guard !AppProfile.current.isActive || BundledRuntime.isBundledApp else {
            self.finishSilently()
            return
        }
        let connectionMode = AppStateStore.shared.connectionMode
        guard connectionMode != .unconfigured else {
            self.finishSilently()
            return
        }
        if self.shouldDeferPausedLegacyRuntime(receipt: receipt, connectionMode: connectionMode) {
            self.deferRuntimeVerification()
            return
        }

        // Pending notification work precedes migration status, including same-version startup migrations.
        if await self.finishNotificationIfReady(receipt: receipt, connectionMode: connectionMode) { return }
        if await self.finishNodeMigrationIfNeeded(receipt: receipt, connectionMode: connectionMode) { return }
        if AppStateStore.shared.connectionMode != connectionMode {
            await self.finishUpdate(receipt: self.receipt ?? receipt, source: source, generation: generation)
            return
        }
        receipt = self.receipt ?? receipt

        let verifiedCompanion = connectionMode == .remote && GatewayProcessManager.shared.nodeMigrationCompleted
        if self.migrationOnlyLaunchCheck, !verifiedCompanion {
            self.finishSilently()
            return
        }

        let repairingNodeMigration = BundledRuntime.isBundledApp && Self.shouldRepairNodeMigration(
            receipt: receipt,
            migrationNeedsCoreRepair: GatewayProcessManager.shared.nodeMigrationNeedsCoreRepair,
            migrationFailed: GatewayProcessManager.shared.nodeMigrationFailure != nil)
        let resolution: PostUpdateGatewayResolution
        do {
            resolution = try await self.resolveGatewayAction(
                connectionMode: connectionMode,
                receipt: receipt,
                repairingNodeMigration: repairingNodeMigration)
        } catch {
            guard self.setGatewayUpdateIncomplete(true, receipt: receipt) else { return }
            self.show()
            self.fail(message: String(localized: "Gateway verification failed."), details: error.localizedDescription)
            return
        }
        guard await self.performGatewayUpdate(
            resolution: resolution,
            connectionMode: resolution.connectionMode,
            receipt: receipt,
            verifiedCompanion: verifiedCompanion,
            repairingNodeMigration: repairingNodeMigration)
        else { return }

        if resolution.shouldResolveCurrentMode(
            after: receipt.coreUpdate, currentMode: AppStateStore.shared.connectionMode)
        {
            self.retryNodeMigration = Self.allowsNodeMigration(
                paused: AppStateStore.shared.isPaused,
                canActivate: GatewayProcessManager.shared.desiredActive && !GatewayProcessManager.shared.isTerminating,
                receipt: self.receipt)
            await self.finishUpdate(receipt: self.receipt ?? receipt, source: source, generation: generation)
            return
        }

        let verification = await self.verifyRuntimeUpdates(
            resolution: resolution,
            connectionMode: resolution.connectionMode,
            receipt: receipt,
            source: source,
            generation: generation)
        if resolution.connectionMode != AppStateStore.shared.connectionMode {
            await self.finishUpdate(receipt: self.receipt ?? receipt, source: source, generation: generation)
            return
        }
        switch verification {
        case .failed:
            return
        case .deferred:
            self.deferRuntimeVerification()
            return
        case .verified:
            break
        }
        if repairingNodeMigration, connectionMode == .remote {
            await self.finishUpdate(receipt: self.receipt ?? receipt, source: source, generation: generation)
            return
        }
        // Verification owns the persistence boundary, including a possibly delivered notification.
        _ = await self.finishNotificationIfReady(
            receipt: self.receipt ?? receipt,
            connectionMode: connectionMode,
            runtimeVerification: verification,
            readyConnectionMode: (resolution.prepareLocalCompanion || verifiedCompanion) && resolution
                .action == .none ? .local : connectionMode)
    }

    private func finishNotification(
        receipt: PostAppUpdateReceipt,
        connectionMode: AppState.ConnectionMode,
        readyConnectionMode: AppState.ConnectionMode? = nil) async
    {
        self.model.phase = .notifying
        self.model.message = String(localized: "Letting your agent know you’re back…")
        let notification = connectionMode == .local && AppStateStore.shared.isPaused
            ? PostUpdateNotificationOutcome.skippedWhilePaused
            : await self.notifyMostRecentSession(
                version: receipt.toVersion,
                connectionMode: connectionMode,
                receipt: receipt)

        self.finishNotification(
            outcome: notification,
            receipt: receipt,
            connectionMode: readyConnectionMode ?? self.notificationReadyConnectionMode(connectionMode))
    }

    private func notificationReadyConnectionMode(_ connectionMode: AppState.ConnectionMode) -> AppState.ConnectionMode {
        // A notification retry has no new legacy-node health proof. Report the verified
        // local companion when present, while delivery still targets the remote primary.
        connectionMode == .remote && GatewayProcessManager.shared.usesSeededGateway ? .local : connectionMode
    }

    private func finishNotification(
        outcome notification: PostUpdateNotificationOutcome,
        receipt: PostAppUpdateReceipt,
        connectionMode: AppState.ConnectionMode)
    {
        let notificationRetryScheduled: Bool
        switch PostAppUpdateReceiptStore.finishNotification(
            receipt: self.receipt ?? receipt, retry: !notification.consumesReceipt)
        {
        case let .retryScheduled(updated):
            self.receipt = updated
            notificationRetryScheduled = true
        case .complete:
            notificationRetryScheduled = false
        case let .recovery(pending):
            self.showPendingUpdateRecovery(pending)
            return
        }
        self.model.phase = .complete
        self.model.title = String(localized: "Welcome back")
        self.model.message = connectionMode == .local
            ? String(format: String(localized: "OpenClaw %@ and its Gateway are ready."), receipt.toVersion)
            : String(format: String(localized: "OpenClaw %@ and its Mac node runtime are ready."), receipt.toVersion)
        self.model.details = switch (notification, notificationRetryScheduled) {
        case (.retryLater, true):
            String(localized: "Your agent could not be notified yet. OpenClaw will retry after the next app launch.")
        case (.retryLater, false):
            if connectionMode == .local {
                String(
                    localized: """
                    OpenClaw could not notify your agent automatically. \
                    The app and Gateway update are complete.
                    """)
            } else {
                String(
                    localized: """
                    OpenClaw could not notify your agent automatically. \
                    The app and Mac node update are complete.
                    """)
            }
        case (.deliveryUnconfirmed, _):
            String(
                localized: """
                OpenClaw could not confirm the agent notification. \
                It will not retry, to avoid a duplicate welcome.
                """)
        case (.skippedUnsupportedGateway, _):
            String(
                localized: "The remote Gateway is older than this Mac app, so OpenClaw skipped the agent notification.")
        case (.skippedWhilePaused, _):
            String(localized: "The Gateway remains paused, so OpenClaw did not wake your agent.")
        default:
            nil
        }
    }

    private func setGatewayUpdateIncomplete(
        _ incomplete: Bool,
        receipt: PostAppUpdateReceipt) -> Bool
    {
        let updated = PostAppUpdateReceiptStore.setGatewayUpdateIncomplete(
            incomplete,
            receipt: receipt)
        guard updated.toVersion == receipt.toVersion else {
            self.receipt = nil
            self.close()
            return false
        }
        self.receipt = updated
        return true
    }

    private func stopSupersededUpdate(_ receipt: PostAppUpdateReceipt) -> Bool {
        guard let version = GatewayEnvironment.appVersionString(), receipt.toVersion != version else { return false }
        self.receipt = nil
        self.close()
        return true
    }

    private func showPendingUpdateRecovery(_ receipt: PostAppUpdateReceipt) {
        if self.stopSupersededUpdate(receipt) { return }
        self.receipt = receipt
        self.show()
        self.fail(
            message: String(localized: "The Gateway update still needs to finish."),
            details: String(localized: "Choose Retry to finish the pending update and verify the Gateway."))
    }

    private func notifyMostRecentSession(
        version: String,
        connectionMode: AppState.ConnectionMode,
        receipt: PostAppUpdateReceipt) async -> PostUpdateNotificationOutcome
    {
        guard let serverLease = await GatewayConnection.shared.captureServerLease() else {
            return .retryLater
        }
        if connectionMode == .remote {
            let gatewayVersion = await GatewayConnection.shared.cachedGatewayVersion(
                ifCurrentServerLease: serverLease)
            if let blocked = Self.remoteNotificationBlocker(
                gatewayVersion: gatewayVersion,
                appVersion: version)
            {
                return blocked
            }
        }

        let session: PostUpdateSession
        do {
            guard let selected = try await Self.preferredNotificationSession(loadPage: { offset in
                var params: [String: OpenClawKit.AnyCodable] = [
                    "limit": OpenClawKit.AnyCodable(100),
                    "includeGlobal": OpenClawKit.AnyCodable(false),
                    "includeUnknown": OpenClawKit.AnyCodable(false),
                    "configuredAgentsOnly": OpenClawKit.AnyCodable(true),
                    "requireLastInteraction": OpenClawKit.AnyCodable(true),
                    "sortBy": OpenClawKit.AnyCodable("lastInteractionAt"),
                ]
                if offset > 0 {
                    params["offset"] = OpenClawKit.AnyCodable(offset)
                }
                let data = try await GatewayConnection.shared.request(
                    method: "sessions.list",
                    params: params,
                    ifCurrentServerLease: serverLease)
                return try JSONDecoder().decode(PostUpdateSessionsResponse.self, from: data)
            }) else { return .noEligibleSession }
            session = selected
        } catch {
            // Read-only discovery is safe to retry after the next app launch.
            return .retryLater
        }

        let text =
            "OpenClaw updated to \(version). Briefly welcome the user back and say you are updated, " +
            "then continue normally."
        guard let notificationReceipt = PostAppUpdateReceiptStore.setNotificationInFlight(
            true,
            receipt: self.receipt ?? receipt)
        else { return .retryLater }
        self.receipt = notificationReceipt
        do {
            _ = try await GatewayConnection.shared.request(
                method: "system-event",
                params: [
                    "text": OpenClawKit.AnyCodable(text),
                    "sessionKey": OpenClawKit.AnyCodable(session.key),
                    "wake": OpenClawKit.AnyCodable(true),
                ],
                ifCurrentServerLease: serverLease)
            return .delivered
        } catch {
            let outcome = Self.notificationSendFailureOutcome(error)
            if outcome == .retryLater,
               let readyToRetry = PostAppUpdateReceiptStore.setNotificationInFlight(
                   false,
                   receipt: notificationReceipt)
            {
                self.receipt = readyToRetry
            }
            return outcome
        }
    }

    static func supportsPostUpdateNotification(
        gatewayVersion: String?,
        appVersion: String) -> Bool
    {
        guard Semver.parse(gatewayVersion) != nil,
              Semver.parse(appVersion) != nil,
              let gatewayVersion
        else { return false }
        return !CLIInstallPrompter.isManagedUpgrade(
            found: gatewayVersion,
            required: appVersion)
    }

    static func notificationContinuation(
        receipt: PostAppUpdateReceipt,
        runtimeVerification: PostUpdateRuntimeVerification,
        migrationOnlyLaunchCheck: Bool) -> PostUpdateNotificationContinuation
    {
        guard !receipt.coreUpdatePending, runtimeVerification != .failed else { return .waitForRuntime }
        if receipt.setupRecovery {
            return runtimeVerification == .verified ? .completeSilently : .waitForRuntime
        }
        if self.isNotificationOnlyRetry(receipt) { return .notify }
        if receipt.notificationInFlight && !receipt.gatewayUpdateIncomplete { return .deliveryUnconfirmed }
        guard runtimeVerification == .verified else { return .waitForRuntime }
        guard !migrationOnlyLaunchCheck else { return .completeSilently }
        return receipt.notificationInFlight ? .deliveryUnconfirmed : .notify
    }

    static func isNotificationOnlyRetry(_ receipt: PostAppUpdateReceipt) -> Bool {
        !receipt.coreUpdatePending && !receipt.setupRecovery && receipt.notificationAttempts > 0 &&
            !receipt.notificationInFlight &&
            !receipt.gatewayUpdateIncomplete
    }

    static func gatewayAction(
        status: CLIInstaller.Status? = nil,
        ownsManagedRuntime: Bool,
        gatewayUpdateIncomplete: Bool,
        usesBundledRuntime: Bool = false) -> PostUpdateGatewayAction
    {
        if gatewayUpdateIncomplete, !ownsManagedRuntime {
            return .ownershipFailure
        }
        guard ownsManagedRuntime else { return .none }
        if usesBundledRuntime { return .prepareBundledRuntime }
        guard let status else { return .none }
        return switch status {
        case .ready:
            gatewayUpdateIncomplete ? .repair : .none
        case let .incompatible(_, found, required):
            CLIInstallPrompter.isManagedUpgrade(found: found, required: required) ? .update : .none
        case .missing, .unusable:
            .install
        }
    }

    static func shouldPresentOwnershipFailure(
        connectionMode: AppState.ConnectionMode,
        gatewayUpdateIncomplete: Bool) -> Bool
    {
        gatewayUpdateIncomplete && connectionMode != .unconfigured
    }

    static func remoteNotificationBlocker(
        gatewayVersion: String?,
        appVersion: String) -> PostUpdateNotificationOutcome?
    {
        guard let gatewayVersion else { return .retryLater }
        return Self.supportsPostUpdateNotification(
            gatewayVersion: gatewayVersion,
            appVersion: appVersion) ? nil : .skippedUnsupportedGateway
    }

    static func ownsManagedRuntime(
        connectionMode: AppState.ConnectionMode,
        programArguments: [String],
        gatewayUpdateChannel: String?,
        installPolicy: String?,
        launchAgentWriteDisabled: Bool) -> Bool
    {
        CLIInstallPrompter.managedRepairGatesOpen(
            launchAgentUsesManagedCLI: CLIInstallPrompter.launchAgentUsesManagedCLI(
                programArguments: programArguments),
            gatewayUpdateChannel: gatewayUpdateChannel,
            installPolicy: installPolicy,
            // This debug gate owns only the local Gateway LaunchAgent. Remote
            // mode proves ownership from the node service command instead.
            launchAgentWriteDisabled: connectionMode == .local && launchAgentWriteDisabled)
    }

    static func notificationSendFailureOutcome(_ error: Error) -> PostUpdateNotificationOutcome {
        if error is OpenClawChatTransportSendError || error is GatewayResponseError {
            return .retryLater
        }
        // The request may have committed before another transport failure was
        // observed. Consuming the attempt avoids a duplicate welcome.
        return .deliveryUnconfirmed
    }

    static func preferredNotificationSession(
        loadPage: (Int) async throws -> PostUpdateSessionsResponse) async throws -> PostUpdateSession?
    {
        var offset = 0
        while true {
            let page = try await loadPage(offset)
            if let session = page.sessions.first(where: { session in
                // External direct sessions may belong to other people. Only
                // wake the internal operator surface after an app update.
                session.kind == "direct" &&
                    session.lastChannel?.lowercased() == "webchat" &&
                    session.lastInteractionAt != nil &&
                    session.spawnedBy == nil &&
                    session.parentSessionKey == nil
            }) {
                return session
            }
            guard let nextOffset = page.nextOffset, nextOffset > offset else { return nil }
            offset = nextOffset
        }
    }

    private func finishSilently() {
        guard self.receipt?.coreUpdatePending != true,
              !BundledRuntime.isBundledApp || self.receipt?.hasPendingRuntimeMigration != true
        else {
            if let receipt = self.receipt,
               self.shouldDeferBundledRuntimeCompletion(
                   receipt: receipt, connectionMode: AppStateStore.shared.connectionMode)
            {
                self.deferRuntimeVerification()
                return
            }
            self.show()
            self.fail(
                message: String(localized: "Gateway update failed."),
                details: String(localized: "The managed runtime does not match the updated Mac app."))
            return
        }
        if let receipt = self.receipt,
           case let .recovery(pending) = PostAppUpdateReceiptStore.finishNotification(receipt: receipt, retry: false)
        {
            self.showPendingUpdateRecovery(pending)
            return
        }
        self.receipt = nil
        self.close()
    }

    private func finishAfterOwnershipCheckFailure(
        connectionMode: AppState.ConnectionMode,
        receipt: PostAppUpdateReceipt)
    {
        guard Self.shouldPresentOwnershipFailure(
            connectionMode: connectionMode,
            gatewayUpdateIncomplete: receipt.gatewayUpdateIncomplete)
        else {
            self.finishSilently()
            return
        }

        // An incomplete receipt proves app-owned Gateway work already began.
        // Keep it retryable when the service record is temporarily unreadable.
        self.show()
        switch connectionMode {
        case .local:
            self.fail(
                message: String(localized: "The Gateway could not be checked."),
                details: String(
                    localized: """
                    OpenClaw could not read the Gateway service ownership record. \
                    Retry after checking the Gateway LaunchAgent.
                    """))
        case .remote:
            self.fail(
                message: String(localized: "The Mac node could not be checked."),
                details: String(
                    localized: """
                    OpenClaw could not read the node service ownership record. \
                    Retry after checking the node LaunchAgent.
                    """))
        case .unconfigured:
            self.finishSilently()
        }
    }

    private func fail(message: String, details: String?) {
        self.model.phase = .failed
        self.model.title = String(localized: "Gateway update needs help")
        self.model.message = message
        self.model.details = details
    }
}

extension PostUpdateController {
    private func resolveGatewayAction(
        connectionMode: AppState.ConnectionMode,
        receipt: PostAppUpdateReceipt,
        repairingNodeMigration: Bool) async throws -> PostUpdateGatewayResolution
    {
        let connectionMode: AppState.ConnectionMode = switch receipt.coreUpdate {
        case .gateway: .local
        case .node: .remote
        case .complete, .legacyCanonical: connectionMode
        }
        let bundled = BundledRuntime.isBundledApp
        // Published receipts bind the canonical package; selected-service recovery follows core repair.
        if receipt.coreUpdate == .legacyCanonical {
            let context = PostUpdateRuntimeContext(
                connectionMode: connectionMode,
                bundledApp: bundled,
                usesSeededGateway: false,
                hasService: false,
                installedCLI: nil,
                ownsManagedRuntime: false)
            return await Self.resolveGatewayAction(context: context, receipt: receipt) {
                await CLIInstaller.managedStatus(expectedVersion: receipt.toVersion, usesBundledRuntime: false)
            }
        }
        if bundled {
            await GatewayProcessManager.shared.waitForStartupAttempt()
            if repairingNodeMigration || connectionMode == .local || AppStateStore.shared
                .hostsLocalGatewayWithRemotePrimary
            {
                try GatewayProcessManager.shared.loadRetainedServiceForResume()
            }
        }
        let usesSeededGateway = GatewayProcessManager.shared.usesSeededGateway
        let companionVerified = GatewayProcessManager.shared.nodeMigrationCompleted
        let prepareCompanion = !repairingNodeMigration && connectionMode == .remote && bundled && usesSeededGateway &&
            !companionVerified
        var context: PostUpdateRuntimeContext
        do {
            context = try Self.captureRuntimeContext(
                connectionMode: connectionMode,
                bundledApp: bundled,
                usesSeededGateway: usesSeededGateway,
                repairingNodeMigration: repairingNodeMigration)
        } catch {
            return .init(
                connectionMode: repairingNodeMigration ? .local : connectionMode,
                action: .ownershipFailure,
                installedCLI: nil,
                prepareLocalCompanion: prepareCompanion,
                serviceInstalled: true)
        }
        context.localCompanionVerified = companionVerified
        return await Self.resolveGatewayAction(context: context, receipt: receipt) {
            await CLIInstaller.managedStatus(
                installedCLI: context.installedCLI,
                usesBundledRuntime: false)
        }
    }

    static func captureRuntimeContext(
        connectionMode: AppState.ConnectionMode,
        bundledApp: Bool,
        usesSeededGateway: Bool,
        repairingNodeMigration: Bool = false) throws -> PostUpdateRuntimeContext
    {
        // A remote primary's failed local companion still belongs to the Gateway repair owner.
        let runtimeMode: AppState.ConnectionMode = repairingNodeMigration ? .local : connectionMode
        let programArguments: [String]
        let installedCLI: GatewayLaunchAgentManager.InstalledServiceCLI?
        let hasService: Bool
        switch runtimeMode {
        case .local:
            guard let arguments = GatewayLaunchAgentManager.launchdProgramArguments() else {
                throw GatewayHostingError(message: GatewayProcessManager.Installation.ownershipFailure)
            }
            installedCLI = arguments.isEmpty && bundledApp
                ? try GatewayProcessManager.shared.serviceCLIForResume()
                : GatewayLaunchAgentManager.installedServiceCLI()
            programArguments = arguments.isEmpty ? installedCLI.map { $0.prefix + ["gateway"] } ?? [] : arguments
            hasService = !arguments.isEmpty
        case .remote:
            guard let arguments = NodeServiceManager.launchdProgramArguments() else {
                throw GatewayHostingError(message: GatewayProcessManager.Installation.ownershipFailure)
            }
            programArguments = arguments
            installedCLI = NodeServiceManager.installedServiceCLI()
            hasService = !arguments.isEmpty
        case .unconfigured:
            programArguments = []
            installedCLI = nil
            hasService = false
        }
        return PostUpdateRuntimeContext(
            connectionMode: runtimeMode,
            bundledApp: bundledApp,
            usesSeededGateway: usesSeededGateway,
            hasService: hasService,
            installedCLI: installedCLI,
            ownsManagedRuntime: Self.ownsManagedRuntime(
                connectionMode: runtimeMode,
                programArguments: programArguments,
                gatewayUpdateChannel: OpenClawConfigFile.gatewayUpdateChannel(),
                installPolicy: CLIInstallPolicy.storedPolicy(),
                launchAgentWriteDisabled: GatewayLaunchAgentManager.isLaunchAgentWriteDisabled()))
    }

    static func resolveGatewayAction(
        context: PostUpdateRuntimeContext,
        receipt: PostAppUpdateReceipt,
        managedStatus: () async -> CLIInstaller.Status) async -> PostUpdateGatewayResolution
    {
        if receipt.coreUpdate == .legacyCanonical {
            let action: PostUpdateGatewayAction
            if let authority = try? CLIInstaller.captureCanonicalUpdateAuthority(
                executable: CLIInstaller.managedExecutableLocation()), authority.currentError() == nil
            {
                let legacy = await Self.gatewayAction(
                    status: managedStatus(), ownsManagedRuntime: true, gatewayUpdateIncomplete: true)
                action = legacy == .install ? .managedRuntimeUnavailable : legacy
            } else {
                action = .ownershipFailure
            }
            return PostUpdateGatewayResolution(
                connectionMode: context.connectionMode,
                action: action,
                installedCLI: nil,
                prepareLocalCompanion: false,
                serviceInstalled: false)
        }
        let remote = context.connectionMode == .remote
        let action: PostUpdateGatewayAction
        if remote, !context.hasService {
            action = receipt.coreUpdatePending ? .ownershipFailure : .none
        } else if !remote, context.bundledApp, context.usesSeededGateway,
                  !context.hasService || context.ownsManagedRuntime
        {
            action = .prepareBundledRuntime
        } else if !context.ownsManagedRuntime {
            action = receipt.gatewayUpdateIncomplete ? .ownershipFailure : .none
        } else if context.bundledApp, context.hasService, context.installedCLI == nil {
            action = .managedRuntimeUnavailable
        } else {
            let legacyAction = await Self.gatewayAction(
                status: managedStatus(),
                ownsManagedRuntime: true,
                gatewayUpdateIncomplete: receipt.coreUpdatePending)
            if receipt.hasPendingRuntimeMigration, legacyAction == .none {
                action = .verify
            } else {
                // A legacy service must not enter the fresh bundled install flow.
                action = context.bundledApp && legacyAction == .install ? .managedRuntimeUnavailable : legacyAction
            }
        }
        return PostUpdateGatewayResolution(
            connectionMode: context.connectionMode,
            action: action,
            installedCLI: context.installedCLI,
            prepareLocalCompanion: remote && context.bundledApp && context.usesSeededGateway &&
                !context.localCompanionVerified,
            serviceInstalled: context.hasService)
    }

    private func verifyRuntimeUpdates(
        resolution: PostUpdateGatewayResolution,
        connectionMode: AppState.ConnectionMode,
        receipt: PostAppUpdateReceipt,
        source: GatewayProcessManager.ActivationSource,
        generation: UInt64) async -> PostUpdateRuntimeVerification
    {
        guard AppStateStore.shared.connectionMode == connectionMode else { return .deferred }
        self.model.phase = .verifying
        self.model.message = connectionMode == .local
            ? String(localized: "Restarting and verifying the Gateway…")
            : String(localized: "Verifying the Mac node runtime…")
        if resolution.needsManagedVerification {
            let verification = await self.verifyRuntime(
                connectionMode: connectionMode,
                installedCLI: resolution.installedCLI,
                serviceInstalled: resolution.serviceInstalled,
                receipt: receipt,
                source: source,
                generation: generation)
            guard AppStateStore.shared.connectionMode == connectionMode else { return .deferred }
            guard verification == .verified else { return verification }
        }
        if resolution.action == .prepareBundledRuntime || resolution.prepareLocalCompanion {
            return await self.prepareBundledRuntime(
                receipt: self.receipt ?? receipt, source: source, generation: generation)
        }
        return .verified
    }

    private func prepareBundledRuntime(
        receipt: PostAppUpdateReceipt,
        source: GatewayProcessManager.ActivationSource,
        generation: UInt64) async -> PostUpdateRuntimeVerification
    {
        guard self.setGatewayUpdateIncomplete(true, receipt: receipt) else { return .failed }
        self.model.phase = .updating
        self.model.message = String(localized: "Preparing the bundled Gateway runtime…")
        self.show()
        do {
            let activation = try await GatewayProcessManager.shared.prepareBundledRuntimeAfterUpdate(
                source: self.activationSource(source, generation: generation))
            switch activation {
            case .ready: return .verified
            case .deferred: return .deferred
            case let .failed(reason):
                self.fail(
                    message: String(localized: "The bundled Gateway update could not finish."), details: reason)
                return .failed
            }
        } catch {
            if error is CancellationError, AppStateStore.shared.isPaused { return .deferred }
            self.fail(
                message: String(localized: "The bundled Gateway update could not finish."),
                details: error.localizedDescription)
            return .failed
        }
    }

    static func shouldOfferRuntimeMigrationRetry(
        profile: AppProfile,
        receipt: PostAppUpdateReceipt,
        serviceInstalled: Bool,
        retainedManagedNode: Bool) -> Bool
    {
        profile.isActive && receipt.hasPendingRuntimeMigration && serviceInstalled && retainedManagedNode
    }

    static func shouldRepairNodeMigration(
        receipt: PostAppUpdateReceipt,
        migrationNeedsCoreRepair: Bool,
        migrationFailed: Bool) -> Bool
    {
        receipt.coreUpdate == .gateway && (migrationNeedsCoreRepair || migrationFailed)
    }

    private func consume(
        _ outcome: ManagedCLIUpdateOutcome, targetVersion: String, owner: PostAppUpdateCoreUpdate) -> Bool
    {
        switch outcome {
        case let .success(_, installedVersion):
            guard installedVersion == targetVersion else {
                self.fail(
                    message: String(localized: "Gateway verification failed."),
                    details: String(localized: "The managed runtime does not match the updated Mac app."))
                return false
            }
            self.receipt = PostAppUpdateReceiptStore.completeCoreRepair(
                currentVersion: targetVersion, owner: owner) ?? self.receipt
            guard self.receipt?.coreUpdatePending != true else {
                self.fail(
                    message: String(localized: "Gateway update failed."),
                    details: "Another managed runtime update still needs repair.")
                return false
            }
            return true
        case let .failure(message, details):
            self.fail(message: message, details: details)
            return false
        }
    }

    private func activationSource(
        _ source: GatewayProcessManager.ActivationSource, generation: UInt64) -> GatewayProcessManager.ActivationSource
    {
        GatewayProcessManager.shared.gatewayStartGeneration == generation ? source : .recovery
    }

    private func shouldDeferBundledRuntimeCompletion(
        receipt: PostAppUpdateReceipt,
        connectionMode: AppState.ConnectionMode) -> Bool
    {
        BundledRuntime.isBundledApp && receipt.hasPendingRuntimeMigration &&
            (connectionMode == .local || AppStateStore.shared.hostsLocalGatewayWithRemotePrimary) &&
            (AppStateStore.shared.isPaused || GatewayProcessManager.shared.isTerminating)
    }

    private func deferNodeRuntimeMigration() {
        self.show()
        self.fail(
            message: String(localized: "The Gateway version is updated and still running on Node."),
            details: String(
                localized: """
                Choose Retry or relaunch OpenClaw to switch this same-version Gateway to the bundled runtime.
                """))
    }

    private func deferRuntimeVerification() {
        self.model.phase = .deferred
        self.model.message = String(localized: "The Gateway remains paused, so OpenClaw did not wake your agent.")
        self.model.details = String(localized: "Resume OpenClaw to finish starting and verifying the Gateway.")
    }

    private func shouldDeferPausedLegacyRuntime(
        receipt: PostAppUpdateReceipt,
        connectionMode: AppState.ConnectionMode) -> Bool
    {
        guard connectionMode == .local, AppStateStore.shared.isPaused, receipt.hasPendingRuntimeMigration,
              GatewayLaunchAgentManager.launchdProgramArguments()?.isEmpty == true,
              let cli = try? GatewayProcessManager.shared.serviceCLIForResume(),
              let executable = cli.prefix.first else { return false }
        return GatewayLaunchAgentManager.isManagedNode(
            executable, stateDirectory: AppProfile.current.stateDirectoryURL())
    }

    private func performGatewayUpdate(
        resolution: PostUpdateGatewayResolution,
        connectionMode: AppState.ConnectionMode,
        receipt: PostAppUpdateReceipt,
        verifiedCompanion: Bool,
        repairingNodeMigration: Bool) async -> Bool
    {
        let restartGateway = resolution.shouldRestartGateway(
            connectionMode: AppStateStore.shared.connectionMode, paused: AppStateStore.shared.isPaused)

        // App-only relaunches stay invisible. The window belongs only to
        // confirmed managed Gateway work and its recovery path.
        switch resolution.action {
        case .verify:
            self.show()
        case .managedRuntimeUnavailable:
            guard self.setGatewayUpdateIncomplete(true, receipt: receipt) else { return false }
            self.show()
            self.fail(
                message: String(localized: "Gateway verification failed."),
                details: String(localized: "The managed runtime does not match the updated Mac app."))
            return false
        case .none:
            if !resolution.prepareLocalCompanion, !verifiedCompanion {
                self.finishSilently()
                return false
            }
        case .ownershipFailure:
            if resolution.prepareLocalCompanion || verifiedCompanion {
                guard self.setGatewayUpdateIncomplete(true, receipt: receipt) else { return false }
            }
            self.finishAfterOwnershipCheckFailure(
                connectionMode: connectionMode,
                receipt: self.receipt ?? receipt)
            return false
        case .prepareBundledRuntime:
            break
        case .repair, .update:
            self.model.phase = .updating
            self.show()
            let owner: PostAppUpdateCoreUpdate = receipt.coreUpdate == .legacyCanonical
                ? .legacyCanonical : (connectionMode == .remote ? .node : .gateway)
            let outcome = await CLIInstaller.updateManaged(
                targetVersion: receipt.toVersion,
                restartGateway: restartGateway,
                repair: resolution.action == .repair,
                installedCLI: resolution.installedCLI,
                onDispatch: {
                    self.receipt = try PostAppUpdateReceiptStore.recordCoreUpdateDispatch(
                        receipt: self.receipt ?? receipt, owner: owner)
                },
                statusHandler: { [weak self] message in
                    self?.model.message = message
                })
            guard self.consume(outcome, targetVersion: receipt.toVersion, owner: owner) else { return false }
            if repairingNodeMigration, resolution.serviceInstalled,
               !resolution.shouldResolveCurrentMode(
                   after: receipt.coreUpdate, currentMode: AppStateStore.shared.connectionMode)
            {
                self.deferNodeRuntimeMigration()
                return false
            }
        case .install:
            guard self.setGatewayUpdateIncomplete(true, receipt: receipt) else { return false }
            self.model.phase = .updating
            self.show()
            let installed = await CLIInstaller.install(target: .exact(receipt.toVersion)) { [weak self] message in
                self?.model.message = message
            }
            guard installed else {
                self.fail(
                    message: String(localized: "Gateway recovery failed."),
                    details: String(localized: "The managed OpenClaw runtime could not be reinstalled."))
                return false
            }
        }
        guard self.receipt?.coreUpdatePending != true else {
            self.show()
            self.fail(
                message: String(localized: "Gateway update failed."),
                details: String(localized: "The managed runtime does not match the updated Mac app."))
            return false
        }
        return true
    }

    private func verifyNodeRuntime() async -> PostUpdateRuntimeVerification {
        guard AppStateStore.shared.connectionMode == .remote else { return .deferred }
        let restartError = await NodeServiceManager.restart()
        guard AppStateStore.shared.connectionMode == .remote else { return .deferred }
        if let error = restartError {
            self.fail(
                message: String(localized: "The Mac node did not restart."),
                details: error)
            return .failed
        }
        let running = await NodeServiceManager.waitUntilRunning()
        guard AppStateStore.shared.connectionMode == .remote else { return .deferred }
        guard running else {
            self.fail(
                message: String(localized: "The Mac node did not become ready."),
                details: String(localized: "The node service restarted but did not remain running."))
            return .failed
        }
        return .verified
    }

    private func verifyRuntime(
        connectionMode: AppState.ConnectionMode,
        installedCLI: GatewayLaunchAgentManager.InstalledServiceCLI?,
        serviceInstalled: Bool,
        receipt: PostAppUpdateReceipt,
        source: GatewayProcessManager.ActivationSource,
        generation: UInt64) async -> PostUpdateRuntimeVerification
    {
        let reconstructService = connectionMode == .local && BundledRuntime.isBundledApp && !serviceInstalled
        var verifiedCLI = installedCLI
        if reconstructService, let installedCLI {
            do {
                verifiedCLI = try GatewayProcessManager.shared.refreshLegacyNodeCLI(afterCoreUpdate: installedCLI)
            } catch {
                self.fail(
                    message: String(localized: "Gateway verification failed."),
                    details: error.localizedDescription)
                return .failed
            }
        }
        let runtimeStatus = await CLIInstaller.managedStatus(
            expectedVersion: receipt.toVersion, installedCLI: verifiedCLI, usesBundledRuntime: false)
        guard AppStateStore.shared.connectionMode == connectionMode else { return .deferred }
        guard case .ready = runtimeStatus else {
            self.fail(
                message: String(localized: "Gateway verification failed."),
                details: String(localized: "The managed runtime does not match the updated Mac app."))
            return .failed
        }
        if connectionMode == .remote { return await self.verifyNodeRuntime() }

        if self.shouldDeferBundledRuntimeCompletion(receipt: self.receipt ?? receipt, connectionMode: connectionMode) {
            return .deferred
        }
        if reconstructService, let verifiedCLI {
            if AppStateStore.shared.isPaused { return .deferred }
            do {
                try await GatewayProcessManager.shared.retryManagedNodeMigration(coreRepairVerifiedCLI: verifiedCLI)
                if self.shouldDeferBundledRuntimeCompletion(
                    receipt: self.receipt ?? receipt, connectionMode: connectionMode) { return .deferred }
                guard GatewayProcessManager.shared.nodeMigrationCompleted else {
                    throw GatewayHostingError(message: "The repaired Gateway could not finish switching to Bun. Retry.")
                }
            } catch {
                if error is CancellationError, AppStateStore.shared.isPaused { return .deferred }
                self.receipt = PostAppUpdateReceiptStore.recordMigrationFailure(receipt: self.receipt ?? receipt)
                self.fail(
                    message: String(localized: "The Gateway runtime migration could not finish."),
                    details: error.localizedDescription)
                return .failed
            }
        } else {
            await GatewayConnection.shared.shutdown()
            let activation = await CLIInstaller.activateLocalGateway(
                start: {
                    GatewayProcessManager.shared.setActive(
                        true, source: self.activationSource(source, generation: generation))
                })
            switch activation {
            case .failed:
                self.fail(
                    message: String(localized: "The Gateway did not start."),
                    details: String(localized: "The update is installed, but Gateway health did not become ready."))
                return .failed
            case .deferred:
                // Legacy unbundled installs accept an on-disk update while paused.
                return BundledRuntime.isBundledApp ? .deferred : .verified
            case .ready:
                break
            }
        }
        if self.shouldDeferBundledRuntimeCompletion(receipt: self.receipt ?? receipt, connectionMode: connectionMode) {
            return .deferred
        }
        await ControlChannel.shared.refreshEndpoint(reason: "post-app-update")
        guard AppStateStore.shared.connectionMode == connectionMode else { return .deferred }
        if self.shouldDeferBundledRuntimeCompletion(receipt: self.receipt ?? receipt, connectionMode: connectionMode) {
            return .deferred
        }
        guard ControlChannel.shared.state == .connected else {
            self.fail(
                message: String(localized: "The Gateway could not reconnect."),
                details: String(
                    localized: "OpenClaw installed the update but could not verify the Gateway connection."))
            return .failed
        }
        return .verified
    }
}
