import Foundation
import OpenClawNativeState
import Synchronization

/// Selects one owner for each operation; remote failures never acquire offline custody.
public enum DeviceCredentialAccess {
    public typealias Executor = @Sendable (URL, ClientCredentialOperation) throws -> ClientCredentialResult
    private struct Configuration {
        var appCustody: AppClientCredentialCustody?
        var executor: Executor?
    }

    private static let configuration = Mutex(Configuration())
    public static func prepareAppRoots(identityRoot: URL, executionRoot: URL) throws {
        let separate = try OpenClawClientCredentialStore.canonicalPath(identityRoot) !=
            OpenClawClientCredentialStore.canonicalPath(executionRoot)
        let roots = separate ? [identityRoot, executionRoot] : [identityRoot]
        let custody = try AppClientCredentialCustody(roots: roots, independentRoots: separate ? [identityRoot] : [])
        self.configuration.withLock { $0.appCustody = custody }
        for root in roots {
            try self.withOwner(root: root) { _ in }
        }
    }

    public static func install(executor: @escaping Executor) {
        self.configuration.withLock { $0 = Configuration(executor: executor) }
    }

    public static func owns(root: URL) -> Bool {
        self.configuration.withLock { $0.appCustody?.owns(root: root) ?? false }
    }

    public static func close() {
        let custody = self.configuration.withLock { configuration in
            let custody = configuration.appCustody
            configuration = Configuration()
            return custody
        }
        custody?.close()
    }

    public static func execute(root: URL, operation: ClientCredentialOperation) throws -> ClientCredentialResult {
        if let executor = configuration.withLock({ $0.executor }) {
            return try executor(root, operation)
        }
        if self.configuration.withLock({ $0.appCustody != nil }) {
            return try self.executeForApp(root: root, operation: operation)
        }
        if let missing = try self.missingInspection(root: root, operation: operation) { return missing }
        return try self.withPreparedOwner(
            root: root,
            independent: self.qualifiesIndependentRoot(root),
            inspection: self.isInspection(operation))
        { owner in
            if !self.isInspection(operation) { try self.prepareLegacy(owner: owner, root: root) }
            return try self.execute(operation, owner: owner)
        }
    }

    /// App IPC never falls through to offline ownership after shutdown begins.
    public static func executeForApp(root: URL, operation: ClientCredentialOperation) throws -> ClientCredentialResult {
        guard let custody = self.configuration.withLock({ $0.appCustody }) else {
            throw OpenClawNativeStateError("The app credential owner is closed")
        }
        guard custody.owns(root: root) else {
            throw OpenClawNativeStateError("Client credential root does not match an active app owner")
        }
        if let missing = try self.missingInspection(root: root, operation: operation) { return missing }
        return try custody.withOwner(root: root, inspection: self.isInspection(operation)) { owner in
            if !self.isInspection(operation) { try self.prepareLegacy(owner: owner, root: root) }
            return try self.execute(operation, owner: owner)
        }
    }

    private static func isInspection(_ operation: ClientCredentialOperation) -> Bool {
        switch operation.kind {
        case .identityRead, .tokenRead, .tokenList, .socketRead: true
        default: false
        }
    }

    private static func missingInspection(
        root: URL,
        operation: ClientCredentialOperation) throws -> ClientCredentialResult?
    {
        guard self.isInspection(operation),
              !FileManager.default.fileExists(atPath: OpenClawClientCredentialStore.databaseURL(rootURL: root).path)
        else { return nil }
        let sharedFile = try ClientCredentialReceipt.SharedFile.inspectIfPresent(
            root.appendingPathComponent("state/openclaw.sqlite"))
        var inputs: [URL] = []
        for profile in [GatewayDeviceIdentityProfile.primary, .node, .shareExtension] {
            let directory = root.appendingPathComponent("identity")
            inputs += [
                directory.appendingPathComponent(profile.identityFileName),
                directory.appendingPathComponent(profile.authFileName),
            ]
            if try OpenClawClientCredentialStore.canonicalPath(root) ==
                OpenClawClientCredentialStore.canonicalPath(DeviceIdentityPaths.stateDirURL())
            {
                for source in DeviceIdentityPaths.legacyIdentitySources(profile: profile) {
                    inputs += [source.identityURL, source.authURL]
                }
            }
        }
        inputs += inputs.flatMap {
            [$0.appendingPathExtension("native-importing"), $0.appendingPathExtension("doctor-importing")]
        }
        guard sharedFile == nil, !inputs.contains(where: { FileManager.default.fileExists(atPath: $0.path) }) else {
            throw OpenClawNativeStateError(
                "Local credentials require migration; run openclaw doctor --fix before inspecting them")
        }
        switch operation.kind {
        case .identityRead: return ClientCredentialResult(kind: .identity)
        case .tokenRead: return ClientCredentialResult(kind: .token)
        case .socketRead: return ClientCredentialResult(kind: .socket)
        case .tokenList:
            var result = ClientCredentialResult(kind: .tokens)
            result.tokens = []
            return result
        default: return nil
        }
    }

    private static func execute(
        _ operation: ClientCredentialOperation,
        owner: OpenClawClientCredentialStore) throws -> ClientCredentialResult
    {
        if operation.kind == .identityCreate, let candidate = operation.identity {
            _ = try DeviceIdentityStore.material(
                deviceId: candidate.deviceID,
                publicKeyPEM: candidate.publicKeyPEM,
                privateKeyPEM: candidate.privateKeyPEM,
                createdAtMs: candidate.createdAtMs)
        }
        guard operation.kind == .identityRepair, let replacement = operation.identity else {
            return try owner.execute(operation)
        }
        let current = try owner.readIdentity(key: replacement.key)
        var result = ClientCredentialResult(kind: .identityRepair)
        if let current, (try? DeviceIdentityStore.material(
            deviceId: current.deviceID,
            publicKeyPEM: current.publicKeyPEM,
            privateKeyPEM: current.privateKeyPEM,
            createdAtMs: current.createdAtMs)) != nil
        {
            result.identity = current
            result.repaired = false
            result.rotated = false
            return result
        }
        var selected = replacement
        var salvaged = false
        if let current,
           let publicKey = DeviceIdentityStore.rawPublicKey(fromPEM: current.publicKeyPEM),
           let privateKey = DeviceIdentityStore.rawPrivateKey(fromPEM: current.privateKeyPEM),
           DeviceIdentityStore.keyPairMatches(publicKeyData: publicKey, privateKeyData: privateKey)
        {
            let material = DeviceIdentityStore.material(
                publicKeyData: publicKey,
                privateKeyData: privateKey,
                createdAtMs: max(0, current.createdAtMs))
            selected = .init(
                key: current.key,
                deviceID: material.identity.deviceId,
                publicKeyPEM: material.publicKeyPEM,
                privateKeyPEM: material.privateKeyPEM,
                createdAtMs: material.identity.createdAtMs,
                updatedAtMs: replacement.updatedAtMs)
            salvaged = true
        }
        _ = try DeviceIdentityStore.material(
            deviceId: selected.deviceID,
            publicKeyPEM: selected.publicKeyPEM,
            privateKeyPEM: selected.privateKeyPEM,
            createdAtMs: selected.createdAtMs)
        try owner.replaceIdentityForRepair(selected)
        result.identity = selected
        result.repaired = true
        result.rotated = !salvaged
        return result
    }

    static func withOwner<T>(root: URL, _ operation: (OpenClawClientCredentialStore) throws -> T) throws -> T {
        let configured = self.configuration.withLock { $0 }
        if let custody = configured.appCustody { return try custody.withOwner(root: root, operation) }
        guard configured.executor == nil else {
            throw OpenClawNativeStateError("Local credential import requires the active app owner")
        }
        return try self.withPreparedOwner(root: root, independent: self.qualifiesIndependentRoot(root), operation)
    }

    private static func qualifiesIndependentRoot(_ root: URL) throws -> Bool {
        #if os(iOS) || os(watchOS)
        return true
        #else
        guard let legacy = DeviceIdentityPaths.legacyStateDirURL() else { return false }
        return try OpenClawClientCredentialStore.canonicalPath(root) ==
            OpenClawClientCredentialStore.canonicalPath(legacy)
        #endif
    }

    static func withPreparedOwner<T>(
        root: URL,
        independent: Bool,
        inspection: Bool = false,
        _ operation: (OpenClawClientCredentialStore) throws -> T) throws -> T
    {
        let shared = root.appendingPathComponent("state/openclaw.sqlite")
        try OpenClawNativeStateSQLite.assertNoOfflineMaintenance(databaseURL: shared)
        let owner = try OpenClawClientCredentialStore(rootURL: root, createIfMissing: !inspection, migration: true)
        defer { owner.close() }
        try NativeClientCredentialMigration.prepare(
            root: root, owner: owner, allowIndependentSource: independent, inspection: inspection)
        try owner.assertReady(rootURL: root)
        try Task.checkCancellation()
        try OpenClawNativeStateSQLite.assertNoOfflineMaintenance(databaseURL: shared)
        return try operation(owner)
    }

    private static func prepareLegacy(owner: OpenClawClientCredentialStore, root: URL) throws {
        for profile in [GatewayDeviceIdentityProfile.primary, .node, .shareExtension] {
            let sources: [DeviceIdentityPaths.LegacyIdentitySource]
            if try OpenClawClientCredentialStore.canonicalPath(root) ==
                OpenClawClientCredentialStore.canonicalPath(DeviceIdentityPaths.stateDirURL())
            {
                sources = DeviceIdentityPaths.legacyIdentitySources(profile: profile)
            } else {
                let directory = root.appendingPathComponent("identity")
                sources = [.init(
                    stateDirURL: root,
                    identityURL: directory.appendingPathComponent(profile.identityFileName),
                    authURL: directory.appendingPathComponent(profile.authFileName))]
            }
            try DeviceIdentitySQLiteStore.prepareLegacy(owner: owner, root: root, profile: profile, sources: sources)
            try DeviceAuthStore.prepareLegacy(owner: owner, profile: profile, stateDirectoryURL: root)
        }
    }

    public static func executeOffline(
        root: URL,
        operation: ClientCredentialOperation) throws -> ClientCredentialResult
    {
        if let missing = try self.missingInspection(root: root, operation: operation) { return missing }
        return try self.withPreparedOwner(
            root: root, independent: self.qualifiesIndependentRoot(root), inspection: self.isInspection(operation))
        {
            if !self.isInspection(operation) { try self.prepareLegacy(owner: $0, root: root) }
            return try self.execute(operation, owner: $0)
        }
    }

    static var isRemote: Bool {
        configuration.withLock { $0.executor != nil }
    }
}

/// Retains the app's root-bound route, while every operation releases physical custody.
final class AppClientCredentialCustody: @unchecked Sendable {
    private let roots: Set<String>
    private let independentRoots: Set<String>
    private let lock = NSLock()
    private var closed = false

    init(roots: [URL], independentRoots: [URL]) throws {
        self.roots = try Set(roots.map(OpenClawClientCredentialStore.canonicalPath))
        self.independentRoots = try Set(independentRoots.map(OpenClawClientCredentialStore.canonicalPath))
    }

    func owns(root: URL) -> Bool {
        guard let key = try? OpenClawClientCredentialStore.canonicalPath(root) else { return false }
        return self.lock.withLock { !self.closed && self.roots.contains(key) }
    }

    func withOwner<T>(
        root: URL,
        inspection: Bool = false,
        _ operation: (OpenClawClientCredentialStore) throws -> T) throws -> T
    {
        self.lock.lock()
        defer { self.lock.unlock() }
        let key = try OpenClawClientCredentialStore.canonicalPath(root)
        guard !self.closed, self.roots.contains(key) else {
            throw OpenClawNativeStateError("Client credential root does not match an active app owner")
        }
        return try DeviceCredentialAccess.withPreparedOwner(
            root: root,
            independent: self.independentRoots.contains(key),
            inspection: inspection,
            operation)
    }

    func close() {
        self.lock.withLock { self.closed = true }
    }
}
