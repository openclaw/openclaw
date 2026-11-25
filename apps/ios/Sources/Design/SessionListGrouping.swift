import Foundation
import OpenClawChatUI

/// Sessions list groups, in order. A session sits in one group only, and state wins over Pinned.
enum SessionListGroup: String, CaseIterable, Hashable {
    case needsYou, working, pinned, recent

    var title: String {
        switch self {
        case .needsYou: String(localized: "Needs you")
        case .working: String(localized: "Working")
        case .pinned: String(localized: "Pinned")
        case .recent: String(localized: "Recent")
        }
    }

    /// Collapsed groups persist on this device beside the sidebar's own section preferences.
    var collapsedStorageKey: String {
        "sessions.\(self.rawValue)Collapsed"
    }
}

/// What a row says at its end. The header already says Working, so a row there carries no spinner;
/// "Needs approval" and "Failed" say more than "Needs you" and stay.
enum SessionListMark: Equatable {
    case none, working, unread, needsApproval, failed

    var label: String? {
        switch self {
        case .needsApproval: String(localized: "Needs approval")
        case .failed: String(localized: "Failed")
        default: nil
        }
    }
}

struct SessionListSection: Identifiable, Equatable {
    enum ID: Hashable {
        case group(SessionListGroup)
        /// A user-made session group; its header keeps the existing rename and delete menu.
        case category(String)
    }

    let id: ID
    let sessions: [OpenClawChatSessionEntry]
}

/// The one mark a session row has room for at its end (Victor, F45: "Ou é spinner ou é unread. Both não
/// coexistem."). While a run is in progress the spinner wins; the unread dot shows once it stops.
enum SessionRowActivityMark: Equatable {
    case none, working, unread

    init(isWorking: Bool, isUnread: Bool) {
        self = isWorking ? .working : isUnread ? .unread : .none
    }
}

enum SessionListGrouping {
    /// Runs that ended badly and are not yet read: `status` from the session row, cleared by `unread`.
    static func isUnseenFailure(_ session: OpenClawChatSessionEntry) -> Bool {
        session.unread == true && ["failed", "timeout"].contains(session.status ?? "")
    }

    static func group(_ session: OpenClawChatSessionEntry, needsApproval: Bool) -> SessionListGroup {
        if needsApproval || self.isUnseenFailure(session) { return .needsYou }
        if session.hasActiveRun == true { return .working }
        return session.pinned == true ? .pinned : .recent
    }

    static func mark(
        _ session: OpenClawChatSessionEntry,
        needsApproval: Bool,
        in group: SessionListGroup) -> SessionListMark
    {
        if needsApproval { return .needsApproval }
        if self.isUnseenFailure(session) { return .failed }
        switch SessionRowActivityMark(isWorking: session.hasActiveRun == true, isUnread: session.unread == true) {
        case .working: return group == .working ? .none : .working
        case .unread: return .unread
        case .none: return .none
        }
    }

    /// `held` keeps each listed key in the group it showed while a finger is on the list; new keys
    /// and fresh titles still apply at once, only the moves wait for the lift.
    static func sections(
        _ sessions: [OpenClawChatSessionEntry],
        knownCategories: [String],
        needsApproval: (OpenClawChatSessionEntry) -> Bool,
        held: [String: SessionListSection.ID]? = nil) -> [SessionListSection]
    {
        var buckets: [SessionListSection.ID: [OpenClawChatSessionEntry]] = [:]
        for session in sessions {
            let id = held?[session.key] ?? self.placement(session, needsApproval: needsApproval(session))
            buckets[id, default: []].append(session)
        }
        let categories = OpenClawChatSessionGroupCatalog.names(
            catalog: nil,
            local: knownCategories,
            sessions: sessions.filter { $0.pinned != true })
        let order: [SessionListSection.ID] = [.group(.needsYou), .group(.working), .group(.pinned)]
            + categories.map { .category($0) } + [.group(.recent)]
        return order.compactMap { id in
            let rows = buckets[id] ?? []
            // Stored groups stay as move targets after their last member leaves; the fixed groups show only with rows.
            if case .group = id, rows.isEmpty { return nil }
            return SessionListSection(id: id, sessions: rows.sorted(by: self.activityComesBefore))
        }
    }

    static func placement(_ session: OpenClawChatSessionEntry, needsApproval: Bool) -> SessionListSection.ID {
        let group = self.group(session, needsApproval: needsApproval)
        if group == .recent, let category = session.category?.trimmingCharacters(in: .whitespacesAndNewlines),
           !category.isEmpty
        {
            return .category(category)
        }
        return .group(group)
    }

    static func activityComesBefore(_ lhs: OpenClawChatSessionEntry, _ rhs: OpenClawChatSessionEntry) -> Bool {
        let left = lhs.lastActivityAt ?? lhs.updatedAt ?? 0
        let right = rhs.lastActivityAt ?? rhs.updatedAt ?? 0
        return left == right ? lhs.key < rhs.key : left > right
    }
}
