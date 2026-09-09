import Foundation
import OpenClawChatUI

/// Legacy preference import and name normalization. The Gateway owns the catalog.
enum SessionGroupStore {
    static let defaultsKey = "openclaw:sessions:custom-groups"

    @MainActor private static var legacyImport: Task<Void, Error>?
    private static let importedKey = "openclaw:sessions:custom-groups:imported-owner"

    /// Unowned empty legacy groups belong to the first connected Gateway's
    /// ambient owner. Keep the source intact until a confirmed import.
    @MainActor
    static func importLegacyGroups(
        using lease: OpenClawChatSessionGroupsRouteLease,
        gatewayID: String,
        agentID: String,
        resolveLegacyOwner: @escaping @MainActor () async -> String?,
        existingCatalogNames: @escaping @MainActor () async throws -> Set<String>,
        defaults: UserDefaults = .standard) async throws
    {
        if let pending = self.legacyImport {
            try await pending.value
        }
        guard defaults.string(forKey: self.importedKey) == nil else { return }
        let legacy = self.load(defaults: defaults)
        guard !legacy.isEmpty else { return }
        let task = Task { @MainActor in
            guard await resolveLegacyOwner() == agentID else { return }
            let assignedNames = try await existingCatalogNames()
            let orphanNames = legacy.filter { !assignedNames.contains($0) }
            let importedOwner = [gatewayID, agentID].joined(separator: "\u{1F}")
            guard !orphanNames.isEmpty else {
                defaults.set(importedOwner, forKey: self.importedKey)
                return
            }
            guard let current = try await lease.listGroups() else {
                throw OpenClawChatTransportSendError.notDispatched
            }
            let result = try await lease.putGroups(names: self.normalized(current.groups.map(\.name) + orphanNames))
            guard result.ok else {
                throw NSError(domain: "SessionGroupImport", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: "Group import was incomplete. Refresh to try again.",
                ])
            }
            defaults.set(importedOwner, forKey: self.importedKey)
        }
        self.legacyImport = task
        defer { self.legacyImport = nil }
        try await task.value
    }

    static func load(defaults: UserDefaults = .standard) -> [String] {
        self.normalized(defaults.stringArray(forKey: self.defaultsKey) ?? [])
    }

    static func normalized(_ groups: [String]) -> [String] {
        var seen = Set<String>()
        return groups
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    static func adding(_ groups: [String], _ name: String) -> [String] {
        self.normalized(groups + [name])
    }
}
