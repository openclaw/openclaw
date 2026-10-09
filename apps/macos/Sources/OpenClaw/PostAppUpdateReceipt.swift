import Foundation
import OSLog

enum PostAppUpdateCoreUpdate: String, Codable, Sendable {
    case complete
    case gateway
    case node
    case legacyCanonical
}

struct PostAppUpdateReceipt: Codable, Equatable, Sendable {
    let fromVersion: String
    let toVersion: String
    let recordedAt: Date
    fileprivate(set) var gatewayUpdateIncomplete: Bool
    fileprivate(set) var coreUpdate: PostAppUpdateCoreUpdate

    var coreUpdatePending: Bool {
        self.coreUpdate != .complete
    }

    fileprivate(set) var notificationAttempts: Int
    fileprivate(set) var notificationInFlight: Bool
    fileprivate(set) var runtimeBuildID: String?
    fileprivate(set) var setupRecovery: Bool

    var hasPendingRuntimeMigration: Bool {
        !self.coreUpdatePending && (self.setupRecovery || self.gatewayUpdateIncomplete)
    }

    init(
        fromVersion: String,
        toVersion: String,
        recordedAt: Date,
        gatewayUpdateIncomplete: Bool = false,
        coreUpdate: PostAppUpdateCoreUpdate = .complete,
        notificationAttempts: Int = 0,
        notificationInFlight: Bool = false,
        runtimeBuildID: String? = nil,
        setupRecovery: Bool = false)
    {
        self.fromVersion = fromVersion
        self.toVersion = toVersion
        self.recordedAt = recordedAt
        self.gatewayUpdateIncomplete = gatewayUpdateIncomplete
        self.coreUpdate = coreUpdate
        self.notificationAttempts = notificationAttempts
        self.notificationInFlight = notificationInFlight
        self.runtimeBuildID = runtimeBuildID
        self.setupRecovery = setupRecovery
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.fromVersion = try container.decode(String.self, forKey: .fromVersion)
        self.toVersion = try container.decode(String.self, forKey: .toVersion)
        self.recordedAt = try container.decode(Date.self, forKey: .recordedAt)
        self.gatewayUpdateIncomplete = try container.decodeIfPresent(
            Bool.self,
            forKey: .gatewayUpdateIncomplete) ?? false
        // Published receipts dispatched the canonical managed wrapper, before service-specific updates existed.
        self.coreUpdate = try container.decodeIfPresent(PostAppUpdateCoreUpdate.self, forKey: .coreUpdate) ??
            (self.gatewayUpdateIncomplete ? .legacyCanonical : .complete)
        self.notificationAttempts = try container.decodeIfPresent(
            Int.self,
            forKey: .notificationAttempts) ?? 0
        self.notificationInFlight = try container.decodeIfPresent(
            Bool.self,
            forKey: .notificationInFlight) ?? false
        self.runtimeBuildID = try container.decodeIfPresent(String.self, forKey: .runtimeBuildID)
        self.setupRecovery = try container.decodeIfPresent(Bool.self, forKey: .setupRecovery) ?? false
    }
}

enum PostAppUpdateReceiptStore {
    enum NotificationCompletion: Equatable {
        case complete
        case retryScheduled(PostAppUpdateReceipt)
    }

    private static let logger = Logger(subsystem: "ai.openclaw", category: "post-update.receipt")
    static let notificationRetryLimit = 2
    private static let lastLaunchedRuntimeBuildIDKey = "openclaw.lastLaunchedRuntimeBuildID"

    static func record(
        fromVersion: String,
        toVersion: String,
        defaults: UserDefaults = AppDefaults.standard,
        now: Date = Date())
    {
        let from = fromVersion.trimmingCharacters(in: .whitespacesAndNewlines)
        let to = toVersion.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !from.isEmpty, !to.isEmpty, from != to else { return }
        let previous = self.load(defaults: defaults)
        let setup = previous?.setupRecovery == true
        let receipt = PostAppUpdateReceipt(
            fromVersion: from,
            toVersion: to,
            recordedAt: now,
            gatewayUpdateIncomplete: previous?.gatewayUpdateIncomplete ?? false,
            coreUpdate: previous?.coreUpdate ?? .complete,
            setupRecovery: setup)
        self.persist(receipt, defaults: defaults)
    }

    static func pending(
        currentVersion: String?,
        currentRuntimeBuildID: String? = nil,
        defaults: UserDefaults = AppDefaults.standard) -> PostAppUpdateReceipt?
    {
        guard let currentVersion = currentVersion?.nonEmpty,
              let receipt = self.load(defaults: defaults),
              receipt.toVersion.nonEmpty == currentVersion,
              receipt.runtimeBuildID == nil || currentRuntimeBuildID == nil ||
              receipt.runtimeBuildID == currentRuntimeBuildID
        else { return nil }
        return receipt
    }

    static func pendingForLaunch(
        currentVersion: String?,
        currentRuntimeBuildID: String? = nil,
        onboardingSeen: Bool,
        allowsUpdateWorkflow: Bool = true,
        defaults: UserDefaults = AppDefaults.standard,
        now: Date = Date()) -> PostAppUpdateReceipt?
    {
        guard let currentVersion = currentVersion?.nonEmpty else { return nil }
        let previousVersion = defaults.string(forKey: lastLaunchedAppVersionKey)?.nonEmpty
        let runtimeBuildID = currentRuntimeBuildID?.nonEmpty
        let previousBuildID = defaults.string(forKey: self.lastLaunchedRuntimeBuildIDKey)?.nonEmpty
        let receipt: PostAppUpdateReceipt?
        let previousReceipt = self.load(defaults: defaults)
        // A different app target is neither this launch's recovery state nor
        // permission to replace its bytes. Live runtime reconciliation still runs.
        if let previousReceipt, previousReceipt.toVersion != currentVersion { return nil }
        let setupRecovery = previousReceipt?.setupRecovery == true
        if !onboardingSeen || !allowsUpdateWorkflow {
            // Onboarding owns its recovery UI. Keep dispatched maintenance across relaunches,
            // while consuming ordinary app notices that predate first-run setup.
            if previousReceipt?.coreUpdatePending != true, previousReceipt?.hasPendingRuntimeMigration != true {
                self.clear(defaults: defaults)
            }
            receipt = nil
        } else if var pending = self.pending(
            currentVersion: currentVersion,
            currentRuntimeBuildID: runtimeBuildID,
            defaults: defaults)
        {
            if pending.runtimeBuildID == nil, let runtimeBuildID {
                pending.runtimeBuildID = runtimeBuildID
                self.persist(pending, defaults: defaults)
            }
            receipt = pending
        } else if previousVersion != currentVersion ||
            (runtimeBuildID != nil && runtimeBuildID != previousBuildID) || setupRecovery ||
            previousReceipt?.coreUpdatePending == true
        {
            // The first recorder-capable build has no prior launch marker. An
            // onboarded install is therefore an upgrade; fresh installs were gated above.
            let bootstrap = PostAppUpdateReceipt(
                fromVersion: previousVersion ?? "unknown",
                toVersion: currentVersion,
                recordedAt: now,
                gatewayUpdateIncomplete: self.pending(
                    currentVersion: currentVersion, defaults: defaults)?
                    .gatewayUpdateIncomplete ?? (previousReceipt?.gatewayUpdateIncomplete ?? false),
                coreUpdate: previousReceipt?.coreUpdate ?? .complete,
                runtimeBuildID: runtimeBuildID,
                setupRecovery: setupRecovery)
            self.persist(bootstrap, defaults: defaults)
            receipt = bootstrap
        } else {
            receipt = nil
        }
        defaults.set(currentVersion, forKey: lastLaunchedAppVersionKey)
        defaults.set(runtimeBuildID, forKey: self.lastLaunchedRuntimeBuildIDKey)
        return receipt
    }

    static func pendingSetupRecovery(
        currentVersion: String?,
        defaults: UserDefaults = AppDefaults.standard) -> PostAppUpdateReceipt?
    {
        guard let receipt = self.pending(currentVersion: currentVersion, defaults: defaults), receipt.setupRecovery,
              receipt.coreUpdatePending else { return nil }
        return receipt
    }

    @discardableResult
    static func recordSetupRecovery(
        fromVersion: String,
        toVersion: String,
        runtimeBuildID: String? = nil,
        setupRecovery: Bool = false,
        defaults: UserDefaults = AppDefaults.standard,
        now: Date = Date()) -> PostAppUpdateReceipt
    {
        let pending = self.pending(currentVersion: toVersion, defaults: defaults)
        let receipt = pending?.coreUpdatePending != true || pending?.coreUpdate == .gateway ||
            pending?.coreUpdate == .legacyCanonical
            ? pending : nil
        return self.recordCoreUpdateDispatch(
            receipt: receipt ?? PostAppUpdateReceipt(
                fromVersion: fromVersion, toVersion: toVersion, recordedAt: now,
                runtimeBuildID: runtimeBuildID, setupRecovery: true),
            owner: .gateway, setupRecovery: setupRecovery, defaults: defaults)
    }

    static func completeSetupRecovery(
        currentVersion: String?, defaults: UserDefaults = AppDefaults.standard)
    {
        guard let receipt = self.pending(currentVersion: currentVersion, defaults: defaults),
              receipt.setupRecovery, !receipt.coreUpdatePending else { return }
        self.clear(defaults: defaults)
    }

    @discardableResult
    static func recordCoreUpdateDispatch(
        receipt: PostAppUpdateReceipt,
        owner: PostAppUpdateCoreUpdate,
        setupRecovery: Bool = false,
        defaults: UserDefaults = AppDefaults.standard) -> PostAppUpdateReceipt
    {
        // Live service and CLI executor ownership admit dispatch; this is only a checkpoint.
        let updated = self.setUpdateState(
            incomplete: true, coreUpdate: owner, receipt: receipt, setupRecovery: setupRecovery, defaults: defaults)
        if !defaults.synchronize() {
            self.logger.warning("Update checkpoint could not be synchronized; continuing the live update")
        }
        return updated
    }

    @discardableResult
    static func completeCoreRepair(
        receipt: PostAppUpdateReceipt,
        owner: PostAppUpdateCoreUpdate,
        defaults: UserDefaults = AppDefaults.standard) -> PostAppUpdateReceipt
    {
        guard receipt.coreUpdate == owner else { return receipt }
        // Package success does not prove that the selected service restarted.
        // Setup recovery already carries that pending runtime phase.
        return self.setUpdateState(
            incomplete: !receipt.setupRecovery,
            coreUpdate: .complete,
            receipt: receipt,
            defaults: defaults)
    }

    @discardableResult
    static func recordMigrationFailure(
        receipt: PostAppUpdateReceipt,
        setupRecovery: Bool = false,
        defaults: UserDefaults = AppDefaults.standard) -> PostAppUpdateReceipt
    {
        // A completed setup repair still awaits runtime health, but must not run core repair again.
        let coreRepairCompleted = (receipt.setupRecovery || setupRecovery) && !receipt.coreUpdatePending
        return self.setGatewayUpdateIncomplete(
            !coreRepairCompleted, receipt: receipt, setupRecovery: setupRecovery, defaults: defaults)
    }

    private static func load(defaults: UserDefaults) -> PostAppUpdateReceipt? {
        guard let data = defaults.data(forKey: postAppUpdateReceiptKey) else { return nil }
        return try? JSONDecoder().decode(PostAppUpdateReceipt.self, from: data)
    }

    static func clear(
        receipt: PostAppUpdateReceipt? = nil,
        defaults: UserDefaults = AppDefaults.standard)
    {
        if let receipt, self.load(defaults: defaults) != receipt { return }
        defaults.removeObject(forKey: postAppUpdateReceiptKey)
    }

    static func finishNotification(
        receipt: PostAppUpdateReceipt,
        retry: Bool,
        defaults: UserDefaults = AppDefaults.standard) -> NotificationCompletion
    {
        guard let current = self.load(defaults: defaults) else { return .complete }
        guard current == receipt, !current.coreUpdatePending, !current.hasPendingRuntimeMigration
        else { return .complete }
        if retry {
            let updated = self.recordNotificationFailure(receipt: current, defaults: defaults)
            if updated.notificationAttempts < self.notificationRetryLimit { return .retryScheduled(updated) }
        }
        self.clear(defaults: defaults)
        return .complete
    }

    static func completeRuntimeVerification(
        receipt: PostAppUpdateReceipt,
        defaults: UserDefaults = AppDefaults.standard) -> PostAppUpdateReceipt
    {
        var verified = receipt
        verified.gatewayUpdateIncomplete = false
        verified.coreUpdate = .complete
        // Runtime health completes this operation, but only the core updater may
        // settle a stored package checkpoint. Foreign progress remains untouched.
        if !receipt.coreUpdatePending {
            self.persistCheckpoint(verified, replacing: receipt, defaults: defaults)
        }
        return verified
    }

    @discardableResult
    static func setGatewayUpdateIncomplete(
        _ incomplete: Bool,
        receipt: PostAppUpdateReceipt,
        setupRecovery: Bool = false,
        defaults: UserDefaults = AppDefaults.standard) -> PostAppUpdateReceipt
    {
        self.setUpdateState(
            incomplete: incomplete, coreUpdate: receipt.coreUpdate, receipt: receipt,
            setupRecovery: setupRecovery, defaults: defaults)
    }

    private static func setUpdateState(
        incomplete: Bool,
        coreUpdate: PostAppUpdateCoreUpdate,
        receipt: PostAppUpdateReceipt,
        setupRecovery: Bool = false,
        defaults: UserDefaults) -> PostAppUpdateReceipt
    {
        var updated = receipt
        updated.gatewayUpdateIncomplete = incomplete
        updated.coreUpdate = coreUpdate
        // Silence belongs to the new checkpoint, not the expected CAS snapshot.
        updated.setupRecovery = receipt.setupRecovery || setupRecovery
        self.persistCheckpoint(updated, replacing: receipt, defaults: defaults)
        return updated
    }

    @discardableResult
    static func recordNotificationFailure(
        receipt: PostAppUpdateReceipt,
        defaults: UserDefaults = AppDefaults.standard) -> PostAppUpdateReceipt
    {
        // One later-launch retry handles restart races. The bound prevents
        // permanent auth/schema errors from reopening this window forever.
        var updated = receipt
        updated.notificationAttempts = min(receipt.notificationAttempts, self.notificationRetryLimit - 1) + 1
        self.persistCheckpoint(updated, replacing: receipt, defaults: defaults)
        return updated
    }

    @discardableResult
    static func setNotificationInFlight(
        _ inFlight: Bool,
        receipt: PostAppUpdateReceipt,
        defaults: UserDefaults = AppDefaults.standard) -> PostAppUpdateReceipt?
    {
        guard let current = self.load(defaults: defaults), current == receipt,
              !inFlight || (!current.coreUpdatePending && !current.hasPendingRuntimeMigration)
        else { return nil }
        var updated = current
        updated.notificationInFlight = inFlight
        guard self.persist(updated, defaults: defaults) else { return nil }
        // Cross the persistence boundary before the Gateway request. A crash
        // after enqueue must not replay this one-time welcome on next launch.
        guard defaults.synchronize() else { return nil }
        return updated
    }

    private static func persistCheckpoint(
        _ updated: PostAppUpdateReceipt, replacing receipt: PostAppUpdateReceipt, defaults: UserDefaults)
    {
        // Late callbacks preserve foreign bytes without importing their progress into
        // this operation. The caller continues using its independently verified result.
        guard self.load(defaults: defaults).map({
            $0 == receipt && (!$0.coreUpdatePending || !updated.coreUpdatePending ||
                $0.coreUpdate == .legacyCanonical || $0.coreUpdate == updated.coreUpdate)
        }) ?? true else {
            self.logger.warning("Update checkpoint changed; preserving it and continuing the live update")
            return
        }
        if !self.persist(updated, defaults: defaults) {
            self.logger.warning("Update checkpoint could not be saved; continuing the live update")
        }
    }

    @discardableResult
    private static func persist(_ receipt: PostAppUpdateReceipt, defaults: UserDefaults) -> Bool {
        guard let data = try? JSONEncoder().encode(receipt) else { return false }
        defaults.set(data, forKey: postAppUpdateReceiptKey)
        return defaults.data(forKey: postAppUpdateReceiptKey) == data
    }
}
