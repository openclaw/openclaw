import Foundation

struct QuickChatRecentMenuItem: Equatable, Identifiable {
    let id: String
    let title: String
    let target: QuickChatSessionTargetOverride?
    let isSelected: Bool
}

enum QuickChatRecentMenuLogic {
    static func items(
        rows: [SessionRow],
        agentName: String,
        selectedTarget: QuickChatSessionTargetOverride?,
        now: Date = Date()) -> [QuickChatRecentMenuItem]
    {
        let newMessage = QuickChatRecentMenuItem(
            id: "new-message",
            title: "New message to \(agentName)",
            target: nil,
            isSelected: selectedTarget == nil)
        let recents = rows.prefix(5).map { row in
            let target = QuickChatSessionTargetOverride(key: row.key, displayName: row.label)
            return QuickChatRecentMenuItem(
                id: row.key,
                title: "\(row.label) — \(relativeAge(from: row.updatedAt, now: now))",
                target: target,
                isSelected: selectedTarget?.key == row.key)
        }
        return [newMessage] + recents
    }
}
