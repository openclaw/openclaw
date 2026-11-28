import Foundation
import OpenClawChatUI
import OpenClawKit

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

    init(session: OpenClawChatSessionEntry?) {
        guard let session else {
            self = .none
            return
        }
        self = SessionListGrouping.isWorking(session) ? .working : session.unread == true ? .unread : .none
    }
}

/// What a Sessions page row says under its title. Nothing else gets a second line.
enum SessionRowStateLine: Equatable {
    case needsApproval(command: String?)
    case failed(reason: String?)
    /// Without a number: sessions rows only carry `hasActiveSubagentRun`, and counting the hidden subagent
    /// rows of the loaded page would undercount children outside it.
    case subagentsWorking
}

enum SessionListGrouping {
    /// The session's own run, or a hidden subagent run it owns (the Control UI's Home and rows read
    /// `hasActiveSubagentRun` as the parent working: `app-sidebar-session-tree.ts:192`).
    static func isWorking(_ session: OpenClawChatSessionEntry) -> Bool {
        session.hasActiveRun == true || session.hasActiveSubagentRun == true
    }

    /// Runs that ended badly and are not yet read: `status` from the session row, cleared by `unread`.
    static func isUnseenFailure(_ session: OpenClawChatSessionEntry) -> Bool {
        session.unread == true && ["failed", "timeout"].contains(session.status ?? "")
    }

    static func group(_ session: OpenClawChatSessionEntry, needsApproval: Bool) -> SessionListGroup {
        if needsApproval || self.isUnseenFailure(session) { return .needsYou }
        if self.isWorking(session) { return .working }
        return session.pinned == true ? .pinned : .recent
    }

    /// The Sessions page row's second line. One state wins: the approval, then an unseen failure, then
    /// running subagents. A plain run keeps a one-line row with its spinner.
    static func stateLine(_ session: OpenClawChatSessionEntry, approval: OpenClawChatAttentionRequest?)
        -> SessionRowStateLine?
    {
        if let approval { return .needsApproval(command: approval.preview.trimmedNonEmpty) }
        if self.isUnseenFailure(session) {
            return .failed(reason: self.failureReason(session.lastRunError, status: session.status))
        }
        return session.hasActiveSubagentRun == true ? .subagentsWorking : nil
    }

    /// `lastRunError` as one line: the Gateway already folds whitespace and keeps 160 characters, but a
    /// row must not break on an older value. A leading warning sign and a bare status word repeat what
    /// the red "Failed" already says.
    static func failureReason(_ error: String?, status: String?) -> String? {
        guard let error else { return nil }
        var line = error.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        if line.first?.unicodeScalars.first == "\u{26A0}" {
            line = line.dropFirst().trimmingCharacters(in: .whitespaces)
        }
        let lowered = line.lowercased()
        guard !line.isEmpty, lowered != "failed", lowered != status?.lowercased() else { return nil }
        return line
    }

    /// The header's approval dot is the fallback for an approval nothing else on screen shows: it stays
    /// while some request has no row in the Needs you section (collapsed still counts as shown).
    static func hasApprovalOutsideNeedsYou(
        _ requests: [OpenClawChatAttentionRequest],
        sections: [SessionListSection],
        targets: (OpenClawChatAttentionRequest, OpenClawChatSessionEntry) -> Bool) -> Bool
    {
        let shown = sections.first { $0.id == .group(.needsYou) }?.sessions ?? []
        return requests.contains { request in
            request.sessionKey != nil && !shown.contains { targets(request, $0) }
        }
    }

    /// `held` keeps each listed key in the group it showed while a finger is on the list; new keys
    /// and fresh titles still apply at once, only the moves wait for the lift.
    static func sections(
        _ sessions: [OpenClawChatSessionEntry],
        knownCategories: [String],
        needsApproval: (OpenClawChatSessionEntry) -> Bool,
        held: [String: SessionListSection.ID]? = nil,
        personalPins: IOSSidebarPins? = nil) -> [SessionListSection]
    {
        var buckets: [SessionListSection.ID: [OpenClawChatSessionEntry]] = [:]
        let projected = personalPins.map { sessions.map($0.project) } ?? sessions
        for session in projected {
            let id = held?[session.key] ?? self.placement(session, needsApproval: needsApproval(session))
            buckets[id, default: []].append(session)
        }
        let categories = OpenClawChatSessionGroupCatalog.names(
            catalog: nil,
            local: knownCategories,
            sessions: projected.filter { $0.pinned != true })
        let order: [SessionListSection.ID] = [.group(.needsYou), .group(.working), .group(.pinned)]
            + categories.map { .category($0) } + [.group(.recent)]
        return order.compactMap { id in
            let rows = buckets[id] ?? []
            // Stored groups stay as move targets after their last member leaves; the fixed groups show only with rows.
            if case .group = id, rows.isEmpty { return nil }
            if id == .group(.pinned), let positions = personalPins?.positions {
                return SessionListSection(id: id, sessions: rows.sorted {
                    (positions[$0.key] ?? .max) < (positions[$1.key] ?? .max)
                })
            }
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
