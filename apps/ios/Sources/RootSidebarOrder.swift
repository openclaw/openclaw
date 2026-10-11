import Foundation
import OpenClawChatUI

extension RootTabs {
    /// The persisted order is independent of the currently loaded agent.
    /// A missing row is not evidence that its saved slot should be discarded.
    enum SidebarEntry: Hashable, Identifiable {
        case route(SidebarDestination)
        case session(String)

        var id: String {
            switch self {
            case .route(.agents): "route:agents-home"
            case let .route(destination): "route:" + destination.rawValue
            case let .session(key): "session:" + key
            }
        }

        init?(canonicalID: String) {
            if canonicalID.hasPrefix("session:") {
                let key = String(canonicalID.dropFirst(8)).trimmingCharacters(in: .whitespacesAndNewlines)
                guard !key.isEmpty else { return nil }
                self = .session(key)
            } else if canonicalID == "route:agents-home" {
                self = .route(.agents)
            } else if canonicalID.hasPrefix("route:"),
                      let route = SidebarDestination(rawValue: String(canonicalID.dropFirst(6))),
                      RootTabs.pinnableSidebarPages.contains(route)
            {
                self = .route(route)
            } else {
                return nil
            }
        }
    }

    // v2026.9.9 shipped these page choices and defaults under sidebar.pinnedPages.
    // Extending the mixed order must not remove existing customization choices.
    static let sidebarCustomizablePages = pinnableSidebarPages
    static let defaultSidebarEntries = defaultPinnedSidebarPages.map(SidebarEntry.route)

    static func sidebarSessionSlot(for session: OpenClawChatSessionEntry) -> String {
        // Qualified keys match the web preference verbatim. Unqualified native
        // rows need the data owner's agent-scoped identity to prevent two agents'
        // "global" or literal-key sessions from sharing a preference slot. This
        // is an ordering ID only, never a key to send in a Gateway request.
        OpenClawChatSessionKey.agentID(from: session.key) != nil
            ? session.key : OpenClawChatSessionSidebarData.identity(session)
    }

    static func sidebarEntries(from storage: String) -> [SidebarEntry] {
        let trimmed = storage.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return self.defaultSidebarEntries }
        if trimmed == "none" { return [] }
        let values: [String] = if let decoded = try? JSONDecoder().decode([String].self, from: Data(trimmed.utf8)) {
            decoded
        } else {
            // Upgrade the shipped comma-delimited native page preference once
            // a customization is saved. Canonical keys use JSON, since opaque
            // session keys may themselves contain commas.
            trimmed.split(separator: ",").map { value in
                value.contains(":") ? String(value) : "route:" + value
            }
        }
        var seen = Set<SidebarEntry>()
        return values.compactMap { value in
            guard let entry = SidebarEntry(canonicalID: value), seen.insert(entry).inserted else { return nil }
            return entry
        }
    }

    static func sidebarEntriesStorage(_ entries: [SidebarEntry]) -> String {
        // Encoding an array of strings cannot fail for these in-memory values.
        guard let data = try? JSONEncoder().encode(entries.map(\.id)) else { return "[]" }
        return String(data: data, encoding: .utf8) ?? "[]"
    }

    static func resetSidebarEntries(_ entries: [SidebarEntry]) -> [SidebarEntry] {
        self.defaultSidebarEntries + entries.filter {
            if case .session = $0 { return true }
            return false
        }
    }

    static func reconciledSidebarEntries(
        _ entries: [SidebarEntry], pinnedSessionKeys: [String]) -> [SidebarEntry]
    {
        var result = entries
        var seen = Set(entries)
        for entry in pinnedSessionKeys.map(SidebarEntry.session)
            where seen.insert(entry).inserted
        {
            result.append(entry)
        }
        return result
    }

    static func settingSidebarEntry(_ entry: SidebarEntry, pinned: Bool, entries: [SidebarEntry]) -> [SidebarEntry] {
        if pinned { return entries.contains(entry) ? entries : entries + [entry] }
        return entries.filter { $0 != entry }
    }

    /// Move through the rendered mixed zone, not just within one kind of row.
    /// Hidden slots keep their exact positions and become visible again when
    /// their agent is loaded.
    static func movingSidebarEntry(
        _ entry: SidebarEntry,
        by offset: Int,
        entries: [SidebarEntry],
        visibleEntries: [SidebarEntry]) -> [SidebarEntry]
    {
        guard offset == -1 || offset == 1,
              let visibleIndex = visibleEntries.firstIndex(of: entry),
              visibleEntries.indices.contains(visibleIndex + offset),
              let source = entries.firstIndex(of: entry),
              let target = entries.firstIndex(of: visibleEntries[visibleIndex + offset]) else { return entries }
        var result = entries
        result.swapAt(source, target)
        return result
    }
}
