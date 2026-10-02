import Foundation

extension ChatSessionSidebarModel {
    public enum Sort: String, Sendable {
        case created, updated
    }

    public struct ViewOptions: Equatable, Sendable {
        var sort: Sort = .created
        var showAutomation = false
        var showSystem = false
        var showArchived = false

        func includes(_ session: OpenClawChatSessionEntry) -> Bool {
            // Port src/shared/session-list-visibility.ts: cron keys own automation,
            // even when system-created; other probes use provenance, never titles.
            let key = session.key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            let automation = key.range(of: #"^(?:cron:|agent::*[^:]+:+cron:+[^:])"#, options: .regularExpression) != nil
            if automation { return self.showAutomation }
            let system: Bool
            if session.createdActor?.type == "system" {
                system = true
            } else {
                let internalSource = session.createdVia == "run" || session.createdVia == "internal"
                let named = [session.label, session.displayName, session.subject]
                    .contains { ChatPayloadDecoding.trimmedNonEmptyString($0) != nil }
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

        func sortedByCreation(_ sessions: [OpenClawChatSessionEntry]) -> [OpenClawChatSessionEntry] {
            /// ui/src/components/app-sidebar-session-navigation-logic.ts:
            /// valid creation dates first, descending; then first observation and key.
            func date(_ session: OpenClawChatSessionEntry) -> Double? {
                session.createdAt.flatMap { $0.isFinite && $0 >= 0 ? $0 : nil }
            }
            return sessions.sorted { lhs, rhs in
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
