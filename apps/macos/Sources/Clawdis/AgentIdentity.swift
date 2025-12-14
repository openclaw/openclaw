import Foundation

struct AgentIdentity: Codable, Equatable {
    var name: String
    var theme: String
    var emoji: String

    var isEmpty: Bool {
        self.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            self.theme.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            self.emoji.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

enum AgentIdentityEmoji {
    static func suggest(theme: String) -> String {
        let normalized = theme.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if normalized.isEmpty { return "🦞" }

        let table: [(needle: String, emoji: String)] = [
            ("lobster", "🦞"),
            ("sloth", "🦥"),
            ("space", "🪐"),
            ("rocket", "🚀"),
            ("astronaut", "🧑‍🚀"),
            ("octopus", "🐙"),
            ("crab", "🦀"),
            ("shark", "🦈"),
            ("cat", "🐈"),
            ("dog", "🐕"),
            ("owl", "🦉"),
            ("fox", "🦊"),
            ("robot", "🤖"),
            ("wizard", "🧙"),
            ("ninja", "🥷"),
        ]

        for entry in table where normalized.contains(entry.needle) {
            return entry.emoji
        }
        return "🦞"
    }
}

