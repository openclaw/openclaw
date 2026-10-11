import Foundation

/// Menu admission mirrors the web session-method-access owner. The Gateway still authorizes every mutation.
public enum OpenClawSessionMenuAction: Sendable, Equatable {
    case rename, pin, snooze, archive, unread, appearance, group, assignOwner, involvement, fork, delete, markdown,
         reclaim

    public var method: String {
        switch self {
        case .rename, .pin, .snooze, .archive, .unread, .appearance, .group: "sessions.patch"
        case .assignOwner: "sessions.assignOwner"
        case .involvement: "sessions.setInvolvement"
        case .fork: "sessions.create"
        case .delete: "sessions.delete"
        case .markdown: "chat.history"
        case .reclaim: "sessions.reclaim"
        }
    }
}

extension OpenClawSessionMenuConnection {
    public func allows(_ action: OpenClawSessionMenuAction, session: OpenClawChatSessionEntry) -> Bool {
        let admin = self.allows(action.method, scope: "operator.admin")
        let owned = session.sharingRole == .owner || session.sharingRole == .admin
        let hasIdentity = session.sessionId?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
        switch action {
        case .archive:
            return hasIdentity && (admin || (owned && self.allows(action.method, scope: "operator.sessions.write")))
        case .snooze:
            return hasIdentity && self.scopedMutationAllowed(action.method, owned: owned)
        case .pin, .rename:
            return self.scopedMutationAllowed(action.method, owned: owned)
        case .fork:
            // Incognito creation is admin-only, including fork's parentSessionKey.
            return session.incognito == true || session.key.contains(":incognito:")
                ? admin : self.allows(action.method, scope: "operator.write")
        case .delete:
            return self.allows(action.method, scope: session.isArchived ? "operator.write" : "operator.admin")
        case .markdown:
            return self.allows(action.method, scope: "operator.sessions.read")
        case .involvement:
            return hasIdentity && self.allows(action.method, scope: "operator.read")
        default:
            return self.allows(action.method)
        }
    }

    private func scopedMutationAllowed(_ method: String, owned: Bool) -> Bool {
        self.allows(method, scope: "operator.write") ||
            (owned && self.allows(method, scope: "operator.sessions.write"))
    }
}

extension ChatSessionSidebarActions {
    public nonisolated static let iconGlyphs = [
        ("braces", "curlybraces"), ("book", "book"), ("monitor", "desktopcomputer"),
        ("bot", "cpu"), ("kanban", "rectangle.split.3x1"), ("coins", "dollarsign.circle"),
    ]
    public static let emoji = ["🦞", "🚀", "🐛", "✅", "🔥", "📦", "🧪", "📝", "🔍", "⚡", "🎯"]

    public static func acceptsCustomEmoji(_ input: String) -> Bool {
        let value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.count == 1 && value.utf16.count <= 16 &&
            !value.unicodeScalars.allSatisfy { (33...126).contains($0.value) }
    }

    public static func canPin(_ session: OpenClawChatSessionEntry) -> Bool {
        let key = session.key.lowercased()
        let name = OpenClawChatSessionKey.agentID(from: key) == nil
            ? key : String(key.split(separator: ":", maxSplits: 2).last ?? "")
        guard !session.isArchived, !name.hasPrefix("subagent:"),
              ChatPayloadDecoding.trimmedNonEmptyString(session.spawnedBy) == nil else { return false }
        guard let parent = ChatPayloadDecoding.trimmedNonEmptyString(session.parentSessionKey) else { return true }
        return OpenClawChatSessionKey.agentID(from: key).map { parent == "agent:\($0):main" } ?? false
    }

    public static func canStopCloudWorker(_ session: OpenClawChatSessionEntry) -> Bool {
        guard let placement = session.placement else { return false }
        return placement.state != .local && placement.state != .reclaimed &&
            !(placement.state == .failed && placement.recoveryAction == "restart") &&
            !(placement.state == .active && session.hasActiveRun == true)
    }
}
