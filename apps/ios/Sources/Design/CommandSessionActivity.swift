import Foundation
import OpenClawChatUI

enum CommandSessionActivityFilter: String, CaseIterable {
    case all
    case needsYou
    case working

    var title: String {
        switch self {
        case .all: String(localized: "All")
        case .needsYou: String(localized: "Needs you")
        case .working: String(localized: "Working")
        }
    }
}

/// A presentation of the selected roster and its existing actionable requests.
@MainActor
struct CommandSessionActivitySnapshot {
    let sessions: [OpenClawChatSessionEntry]
    let isConnected: Bool
    let isComplete: Bool
    private let attention: [String: OpenClawChatAttentionSummary]
    private let working: Set<String>

    init(
        sessions: [OpenClawChatSessionEntry],
        requests: [OpenClawChatAttentionRequest],
        mainSessionKey: String,
        activeAgentID: String?,
        sessionRoutingContract: String?,
        isConnected: Bool,
        isComplete: Bool,
        now: Date)
    {
        self.sessions = sessions
        self.isConnected = isConnected
        self.isComplete = isComplete
        var attention: [String: OpenClawChatAttentionSummary] = [:]
        var working = Set<String>()
        if isConnected {
            for session in sessions where session.archived != true {
                attention[session.key] = ChatSessionSidebarModel.attentionSummary(
                    requests: requests,
                    sessions: [session],
                    mainSessionKey: mainSessionKey,
                    activeAgentID: activeAgentID,
                    sessionRoutingContract: sessionRoutingContract,
                    now: now)
                if Self.isWorking(session) { working.insert(session.key) }
            }
        }
        self.attention = attention
        self.working = working
    }

    func sessions(matching filter: CommandSessionActivityFilter) -> [OpenClawChatSessionEntry] {
        switch filter {
        case .all: self.sessions
        case .needsYou: self.sessions.filter { self.attention[$0.key] != nil }
        case .working: self.sessions.filter { self.working.contains($0.key) }
        }
    }

    func countText(for filter: CommandSessionActivityFilter) -> String {
        guard filter == .all || self.isConnected else { return "—" }
        let count = self.sessions(matching: filter).count.formatted()
        return count + (self.isComplete ? "" : "+")
    }

    func attention(for session: OpenClawChatSessionEntry) -> OpenClawChatAttentionSummary? {
        self.attention[session.key]
    }

    private static func isWorking(_ session: OpenClawChatSessionEntry) -> Bool {
        if session.hasActiveSubagentRun == true { return true }
        // The Gateway session-run-state contract and Android use this precedence:
        // terminal status wins, then explicit liveness, then queued/running status.
        if let status = session.status, status != "queued", status != "running" { return false }
        return session.hasActiveRun ?? (session.status == "queued" || session.status == "running")
    }
}
