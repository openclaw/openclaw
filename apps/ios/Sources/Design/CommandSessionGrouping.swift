import Foundation
import OpenClawChatUI
import OpenClawKit

struct CommandSessionSection: Identifiable {
    enum ID: Hashable {
        case pinned
        case category(String)
        case ungrouped
    }

    let id: ID
    let title: String
    let entries: [OpenClawChatSessionEntry]
    let showsHeader: Bool
}

enum CommandSessionGrouping {
    static func sections(
        from entries: [OpenClawChatSessionEntry],
        knownGroups: [String] = []) -> [CommandSessionSection]
    {
        let pinned = entries.filter { $0.pinned == true }.sorted(by: self.activityComesBefore)
        let unpinned = entries.filter { $0.pinned != true }
        // Stored-but-empty groups still render as sections so they remain
        // visible move targets after their last member leaves.
        let categoryNames = self.categories(from: unpinned, knownGroups: knownGroups)
        var sections: [CommandSessionSection] = []

        if !pinned.isEmpty {
            sections.append(CommandSessionSection(
                id: .pinned,
                title: "Pinned",
                entries: pinned,
                showsHeader: true))
        }

        for category in categoryNames {
            let categoryEntries = unpinned.filter { $0.category?.trimmedNonEmpty == category }
            sections.append(CommandSessionSection(
                id: .category(category),
                title: category,
                entries: categoryEntries.sorted(by: self.activityComesBefore),
                showsHeader: true))
        }

        let ungrouped = unpinned.filter { $0.category?.trimmedNonEmpty == nil }.sorted(by: self.activityComesBefore)
        if !ungrouped.isEmpty {
            sections.append(CommandSessionSection(
                id: .ungrouped,
                title: "Ungrouped",
                entries: ungrouped,
                showsHeader: !categoryNames.isEmpty))
        }

        return sections
    }

    static func previewOrder(_ entries: [OpenClawChatSessionEntry]) -> [OpenClawChatSessionEntry] {
        entries.sorted { lhs, rhs in
            if (lhs.pinned == true) != (rhs.pinned == true) {
                return lhs.pinned == true
            }
            return self.activityComesBefore(lhs, rhs)
        }
    }

    /// Capped preview that always keeps the open chat visible: when the current
    /// session falls outside the cap it leads the list (pre-existing Command
    /// Center contract), otherwise natural pinned/activity order wins.
    static func previewSelection(
        _ entries: [OpenClawChatSessionEntry],
        currentKey: String) -> [OpenClawChatSessionEntry]
    {
        let ordered = self.previewOrder(entries)
        let capped = Array(ordered.prefix(3))
        guard !currentKey.isEmpty,
              !capped.contains(where: { $0.key == currentKey }),
              let current = ordered.first(where: { $0.key == currentKey })
        else { return capped }
        return [current] + capped.prefix(2)
    }

    static func categories(
        from entries: [OpenClawChatSessionEntry],
        knownGroups: [String] = []) -> [String]
    {
        Set(entries.compactMap { $0.category?.trimmedNonEmpty })
            .union(knownGroups.compactMap(\.trimmedNonEmpty))
            .sorted(by: self.categoryComesBefore)
    }

    /// Union of the active and archived enumerations, deduped by key. Group
    /// mutations must patch archived members too so restores land back in the
    /// renamed group instead of the stale one.
    static func members(
        of group: String,
        in lists: [[OpenClawChatSessionEntry]]) -> [OpenClawChatSessionEntry]
    {
        guard let target = group.trimmedNonEmpty else { return [] }
        var seen = Set<String>()
        return lists.flatMap(\.self).filter { entry in
            entry.category?.trimmedNonEmpty == target && seen.insert(entry.key).inserted
        }
    }

    private static func activityComesBefore(
        _ lhs: OpenClawChatSessionEntry,
        _ rhs: OpenClawChatSessionEntry) -> Bool
    {
        let left = lhs.lastActivityAt ?? lhs.updatedAt ?? 0
        let right = rhs.lastActivityAt ?? rhs.updatedAt ?? 0
        return left == right ? lhs.key < rhs.key : left > right
    }

    private static func categoryComesBefore(_ lhs: String, _ rhs: String) -> Bool {
        let order = lhs.localizedCaseInsensitiveCompare(rhs)
        return order == .orderedSame ? lhs < rhs : order == .orderedAscending
    }
}
