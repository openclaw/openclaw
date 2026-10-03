import Foundation

enum PostAppUpdateCoreUpdate: String, Codable, Sendable {
    case complete
    case gateway
    case node
    case legacyCanonical
}

struct PostAppUpdateReceipt: Codable, Equatable {
    private enum CodingKeys: String, CodingKey {
        case fromVersion
        case toVersion
        case recordedAt
        case gatewayUpdateIncomplete
        case coreUpdate
        case notificationAttempts
        case notificationInFlight
        case runtimeBuildID
        case setupRecovery
    }

    let fromVersion: String
    let toVersion: String
    let recordedAt: Date
    let gatewayUpdateIncomplete: Bool
    let coreUpdate: PostAppUpdateCoreUpdate

    var coreUpdatePending: Bool {
        self.coreUpdate != .complete
    }

    let notificationAttempts: Int
    let notificationInFlight: Bool
    let runtimeBuildID: String?
    let setupRecovery: Bool

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
    enum RuntimeCompletion: Equatable {
        case verified(PostAppUpdateReceipt)
        case recovery(PostAppUpdateReceipt)
    }

    enum NotificationCompletion: Equatable {
        case complete
        case retryScheduled(PostAppUpdateReceipt)
        case recovery(PostAppUpdateReceipt)
    }

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
        guard let currentVersion = normalized(currentVersion),
              let receipt = self.load(defaults: defaults),
              normalized(receipt.toVersion) == currentVersion,
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
        guard let currentVersion = normalized(currentVersion) else { return nil }
        let previousVersion = self.normalized(defaults.string(forKey: lastLaunchedAppVersionKey))
        let runtimeBuildID = self.normalized(currentRuntimeBuildID)
        let previousBuildID = self.normalized(defaults.string(forKey: self.lastLaunchedRuntimeBuildIDKey))
        let receipt: PostAppUpdateReceipt?
        let previousReceipt = self.load(defaults: defaults)
        if let previousReceipt, previousReceipt.toVersion != currentVersion,
           !CLIInstallPrompter.isManagedUpgrade(found: previousReceipt.toVersion, required: currentVersion)
        {
            return nil
        }
        let setupRecovery = previousReceipt?.setupRecovery == true
        if !onboardingSeen || !allowsUpdateWorkflow {
            // Onboarding owns its recovery UI. Keep dispatched maintenance across relaunches,
            // while consuming ordinary app notices that predate first-run setup.
            if previousReceipt?.coreUpdatePending != true, previousReceipt?.hasPendingRuntimeMigration != true {
                self.clear(defaults: defaults)
            }
            receipt = nil
        } else if let pending = self.pending(
            currentVersion: currentVersion,
            currentRuntimeBuildID: runtimeBuildID,
            defaults: defaults)
        {
            if pending.runtimeBuildID == nil, let runtimeBuildID {
                let enriched = PostAppUpdateReceipt(
                    fromVersion: pending.fromVersion,
                    toVersion: pending.toVersion,
                    recordedAt: pending.recordedAt,
                    gatewayUpdateIncomplete: pending.gatewayUpdateIncomplete,
                    coreUpdate: pending.coreUpdate,
                    notificationAttempts: pending.notificationAttempts,
                    notificationInFlight: pending.notificationInFlight,
                    runtimeBuildID: runtimeBuildID,
                    setupRecovery: pending.setupRecovery)
                self.persist(enriched, defaults: defaults)
                receipt = enriched
            } else {
                receipt = pending
            }
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

    static func pendingSetupRecovery(defaults: UserDefaults = AppDefaults.standard) -> PostAppUpdateReceipt? {
        guard let receipt = self.load(defaults: defaults), receipt.setupRecovery,
              receipt.coreUpdatePending else { return nil }
        return receipt
    }

    static func recordSetupRecovery(
        fromVersion: String,
        toVersion: String,
        runtimeBuildID: String? = nil,
        defaults: UserDefaults = AppDefaults.standard,
        now: Date = Date()) throws
    {
        if let current = self.load(defaults: defaults), current.toVersion != toVersion {
            guard !current.coreUpdatePending || current.coreUpdate == .gateway,
                  CLIInstallPrompter.isManagedUpgrade(found: current.toVersion, required: toVersion)
            else {
                throw GatewayHostingError(message: "The recorded update must finish in its target app before setup.")
            }
            // Setup explicitly advances its target; delayed dispatch callbacks cannot retarget it.
            self.record(fromVersion: current.toVersion, toVersion: toVersion, defaults: defaults, now: now)
        }
        let previous = self.pendingSetupRecovery(defaults: defaults)
        let receipt = self.pending(currentVersion: toVersion, defaults: defaults) ?? PostAppUpdateReceipt(
            fromVersion: previous?.fromVersion ?? fromVersion,
            toVersion: toVersion,
            recordedAt: previous?.recordedAt ?? now,
            runtimeBuildID: runtimeBuildID,
            setupRecovery: true)
        try self.recordCoreUpdateDispatch(receipt: receipt, owner: .gateway, defaults: defaults)
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
        defaults: UserDefaults = AppDefaults.standard) throws -> PostAppUpdateReceipt
    {
        // The caller may have awaited a probe since reading its receipt. Admission belongs to the store.
        let current = self.load(defaults: defaults)
        guard current == nil || current?.toVersion == receipt.toVersion else {
            throw GatewayHostingError(message: "Another app update replaced this target; its recovery was preserved.")
        }
        guard owner != .complete,
              current?.coreUpdatePending != true || current?.coreUpdate == owner
        else {
            throw GatewayHostingError(
                message: "Another managed runtime update is incomplete. Finish it before updating this installation.")
        }
        let latest = current ?? receipt
        let updated = self.setUpdateState(
            incomplete: true, coreUpdate: owner, receipt: latest, defaults: defaults)
        defaults.synchronize()
        return updated
    }

    @discardableResult
    static func completeCoreRepair(
        currentVersion: String?,
        owner: PostAppUpdateCoreUpdate,
        defaults: UserDefaults = AppDefaults.standard) -> PostAppUpdateReceipt?
    {
        guard let receipt = self.pending(currentVersion: currentVersion, defaults: defaults) else { return nil }
        guard receipt.coreUpdate == owner else { return receipt }
        // Published canonical repair owns package work; the current service is resolved afterward.
        return self.setUpdateState(
            incomplete: !receipt.setupRecovery && owner != .legacyCanonical,
            coreUpdate: .complete,
            receipt: receipt,
            defaults: defaults)
    }

    @discardableResult
    static func recordMigrationFailure(
        receipt: PostAppUpdateReceipt,
        defaults: UserDefaults = AppDefaults.standard) -> PostAppUpdateReceipt
    {
        // A completed setup repair still awaits runtime health, but must not run core repair again.
        let coreRepairCompleted = receipt.setupRecovery && !receipt.coreUpdatePending
        return self.setGatewayUpdateIncomplete(!coreRepairCompleted, receipt: receipt, defaults: defaults)
    }

    private static func load(defaults: UserDefaults) -> PostAppUpdateReceipt? {
        guard let data = defaults.data(forKey: postAppUpdateReceiptKey) else { return nil }
        return try? JSONDecoder().decode(PostAppUpdateReceipt.self, from: data)
    }

    static func clear(defaults: UserDefaults = AppDefaults.standard) {
        defaults.removeObject(forKey: postAppUpdateReceiptKey)
    }

    static func finishNotification(
        receipt: PostAppUpdateReceipt,
        retry: Bool,
        defaults: UserDefaults = AppDefaults.standard) -> NotificationCompletion
    {
        guard let current = self.load(defaults: defaults) else { return .complete }
        guard current == receipt, !current.coreUpdatePending, !current.hasPendingRuntimeMigration
        else { return .recovery(current) }
        if retry {
            let updated = self.recordNotificationFailure(receipt: current, defaults: defaults)
            if updated.notificationAttempts < self.notificationRetryLimit { return .retryScheduled(updated) }
        }
        self.clear(defaults: defaults)
        return .complete
    }

    static func completeRuntimeVerification(
        receipt: PostAppUpdateReceipt,
        defaults: UserDefaults = AppDefaults.standard) -> RuntimeCompletion
    {
        let current = self.load(defaults: defaults) ?? receipt
        guard current == receipt, !current.coreUpdatePending else { return .recovery(current) }
        return .verified(self.setGatewayUpdateIncomplete(false, receipt: current, defaults: defaults))
    }

    @discardableResult
    static func setGatewayUpdateIncomplete(
        _ incomplete: Bool,
        receipt: PostAppUpdateReceipt,
        defaults: UserDefaults = AppDefaults.standard) -> PostAppUpdateReceipt
    {
        let current = self.load(defaults: defaults) ?? receipt
        guard current.toVersion == receipt.toVersion else { return current }
        return self.setUpdateState(
            incomplete: incomplete, coreUpdate: current.coreUpdate, receipt: current, defaults: defaults)
    }

    private static func setUpdateState(
        incomplete: Bool,
        coreUpdate: PostAppUpdateCoreUpdate,
        receipt: PostAppUpdateReceipt,
        defaults: UserDefaults) -> PostAppUpdateReceipt
    {
        let updated = PostAppUpdateReceipt(
            fromVersion: receipt.fromVersion,
            toVersion: receipt.toVersion,
            recordedAt: receipt.recordedAt,
            gatewayUpdateIncomplete: incomplete,
            coreUpdate: coreUpdate,
            notificationAttempts: receipt.notificationAttempts,
            notificationInFlight: receipt.notificationInFlight,
            runtimeBuildID: receipt.runtimeBuildID,
            setupRecovery: receipt.setupRecovery)
        self.persist(updated, defaults: defaults)
        return updated
    }

    @discardableResult
    static func recordNotificationFailure(
        receipt: PostAppUpdateReceipt,
        defaults: UserDefaults = AppDefaults.standard) -> PostAppUpdateReceipt
    {
        // One later-launch retry handles restart races. The bound prevents
        // permanent auth/schema errors from reopening this window forever.
        let current = self.load(defaults: defaults) ?? receipt
        guard current.toVersion == receipt.toVersion else { return current }
        let receipt = current
        let updated = PostAppUpdateReceipt(
            fromVersion: receipt.fromVersion,
            toVersion: receipt.toVersion,
            recordedAt: receipt.recordedAt,
            gatewayUpdateIncomplete: receipt.gatewayUpdateIncomplete,
            coreUpdate: receipt.coreUpdate,
            notificationAttempts: min(receipt.notificationAttempts + 1, self.notificationRetryLimit),
            notificationInFlight: receipt.notificationInFlight,
            runtimeBuildID: receipt.runtimeBuildID,
            setupRecovery: receipt.setupRecovery)
        self.persist(updated, defaults: defaults)
        return updated
    }

    @discardableResult
    static func setNotificationInFlight(
        _ inFlight: Bool,
        receipt: PostAppUpdateReceipt,
        defaults: UserDefaults = AppDefaults.standard) -> PostAppUpdateReceipt?
    {
        let current = self.load(defaults: defaults) ?? receipt
        guard current.toVersion == receipt.toVersion,
              !inFlight || (!current.coreUpdatePending && !current.hasPendingRuntimeMigration)
        else { return nil }
        let receipt = current
        let updated = PostAppUpdateReceipt(
            fromVersion: receipt.fromVersion,
            toVersion: receipt.toVersion,
            recordedAt: receipt.recordedAt,
            gatewayUpdateIncomplete: receipt.gatewayUpdateIncomplete,
            coreUpdate: receipt.coreUpdate,
            notificationAttempts: receipt.notificationAttempts,
            notificationInFlight: inFlight,
            runtimeBuildID: receipt.runtimeBuildID,
            setupRecovery: receipt.setupRecovery)
        self.persist(updated, defaults: defaults)
        // Cross the persistence boundary before the Gateway request. A crash
        // after enqueue must not replay this one-time welcome on next launch.
        defaults.synchronize()
        return updated
    }

    private static func persist(_ receipt: PostAppUpdateReceipt, defaults: UserDefaults) {
        guard let data = try? JSONEncoder().encode(receipt) else { return }
        defaults.set(data, forKey: postAppUpdateReceiptKey)
    }

    private static func normalized(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }
}
