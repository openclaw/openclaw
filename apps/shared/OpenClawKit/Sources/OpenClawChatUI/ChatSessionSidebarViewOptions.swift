import Foundation

extension ChatSessionSidebarModel {
    public enum Sort: String, Sendable {
        case created, updated, people
    }

    public enum Grouping: String, Sendable { case category, project, person, none }
    public enum EmptyGroups: String, Sendable { case filtering, always, never }

    public struct ViewOptions: Equatable, Sendable {
        var sort: Sort = .created
        var showAutomation = false
        var showSystem = false
        var grouping: Grouping = .category
        var emptyGroups: EmptyGroups = .filtering
        var status: OpenClawChatSidebarStatus = .active
        var ownerFilter = ""
        var showMessagePreview = false

        var ownerID: String? {
            self.ownerFilter.hasPrefix("owner:") ? String(self.ownerFilter.dropFirst(6)) : nil
        }

        var involvingMe: Bool {
            self.ownerFilter == "involving-me"
        }

        // ui/src/components/app-sidebar-session-filter-summary.ts:75 counts membership filters only.
        var filterCount: Int {
            (self.ownerFilter.isEmpty ? 0 : 1) + (self.status == .active ? 0 : 1)
        }

        func effectiveGrouping(peopleAvailable: Bool) -> Grouping {
            self.grouping == .person && !peopleAvailable ? .category : self.grouping
        }

        func isChanged(peopleAvailable: Bool) -> Bool {
            self.filterCount > 0 || self.showAutomation || self.showSystem || self.showMessagePreview ||
                self.sort != .created || self.effectiveGrouping(peopleAvailable: peopleAvailable) != .category ||
                self.emptyGroups != .filtering
        }

        mutating func reset(peopleAvailable: Bool) {
            // ui/src/components/sidebar-menus-render.ts:541 preserves a capability-hidden Person preference.
            let grouping = self.effectiveGrouping(peopleAvailable: peopleAvailable) == .category
                ? self.grouping : .category
            self = Self(grouping: grouping)
        }

        func includes(_ session: OpenClawChatSessionEntry) -> Bool {
            // Port src/shared/session-list-visibility.ts: cron keys own automation,
            // even when system-created; other probes use provenance, never titles.
            let key = session.key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            let automation = key.range(of: #"^(?:cron:|agent::*[^:]+:+cron:+[^:])"#, options: .regularExpression) != nil
            if automation { return self.showAutomation }
            let named = [session.label, session.displayName, session.subject]
                .contains { ChatPayloadDecoding.trimmedNonEmptyString($0) != nil }
            // src/shared/session-list-visibility.ts:27: a named heartbeat outranks system provenance.
            if session.classification == "heartbeat" { return self.showSystem || named }
            let system: Bool
            if session.createdActor?.type == "system" {
                system = true
            } else {
                let internalSource = session.createdVia == "run" || session.createdVia == "internal"
                system = internalSource && session.createdActor?.type != "human" && !named
            }
            return self.showSystem || !system
        }
    }

    public struct ObservedOrder: Sendable {
        private var indices: [String: Int] = [:]
        private var nextIndex = 0

        public init() {}

        mutating func observe(_ keys: [String]) {
            for key in keys where !key.isEmpty && self.indices[key] == nil {
                self.indices[key] = self.nextIndex
                self.nextIndex += 1
            }
            // Match the web projection's sidebar-lifetime registry: retain paging
            // gaps, evicting absent keys only above its 1,000-entry memory bound.
            if self.indices.count > 1000 {
                let retained = Set(keys)
                let absent = self.indices.keys.filter { !retained.contains($0) }
                    .sorted { self.indices[$0, default: 0] < self.indices[$1, default: 0] }
                for key in absent.prefix(self.indices.count - 1000) {
                    self.indices[key] = nil
                }
            }
        }

        func sortedByCreation(
            _ sessions: [OpenClawChatSessionEntry], owners: [OpenClawChatSessionEntry.CreatedActor]? = nil)
            -> [OpenClawChatSessionEntry]
        {
            /// ui/src/components/app-sidebar-session-navigation-logic.ts:
            /// valid creation dates first, descending; then first observation and key.
            func date(_ session: OpenClawChatSessionEntry) -> Double? {
                session.createdAt.flatMap { $0.isFinite && $0 >= 0 ? $0 : nil }
            }
            let labels = Dictionary((owners ?? []).compactMap { actor in
                actor.id.map { ($0, ChatPayloadDecoding.trimmedNonEmptyString(actor.label) ?? "") }
            }, uniquingKeysWith: { first, _ in first })
            return sessions.sorted { lhs, rhs in
                // ui/src/components/app-sidebar-session-navigation-logic.ts:71: facet labels, then Created ties.
                let leftID = ChatPayloadDecoding.trimmedNonEmptyString(lhs.owner?.actor.id) ?? ""
                let rightID = ChatPayloadDecoding.trimmedNonEmptyString(rhs.owner?.actor.id) ?? ""
                if owners != nil, leftID != rightID {
                    let left = ChatPayloadDecoding.trimmedNonEmptyString(labels[leftID]) ??
                        ChatPayloadDecoding.trimmedNonEmptyString(lhs.owner?.actor.label) ?? leftID
                    let right = ChatPayloadDecoding.trimmedNonEmptyString(labels[rightID]) ??
                        ChatPayloadDecoding.trimmedNonEmptyString(rhs.owner?.actor.label) ?? rightID
                    let comparison = left.localizedCompare(right)
                    if comparison != .orderedSame { return comparison == .orderedAscending }
                    let ids = leftID.localizedCompare(rightID)
                    if ids != .orderedSame { return ids == .orderedAscending }
                }
                let left = date(lhs)
                let right = date(rhs)
                if left != right {
                    guard let left else { return false }
                    guard let right else { return true }
                    return left > right
                }
                let leftIndex = self.indices[lhs.key] ?? Int.max
                let rightIndex = self.indices[rhs.key] ?? Int.max
                return leftIndex == rightIndex ? lhs.key < rhs.key : leftIndex < rightIndex
            }
        }
    }
}
