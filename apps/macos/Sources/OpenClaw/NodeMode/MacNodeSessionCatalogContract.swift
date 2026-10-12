enum MacNodeClaudeSessionCatalogContract {
    static let pluginId = "anthropic"
    static let capability = "claude-sessions"
    static let listCommand = "anthropic.claude.sessions.list.v1"
    static let readCommand = "anthropic.claude.sessions.read.v1"
    static let commands = [listCommand, readCommand]
}

enum MacNodeCodexThreadCatalogContract {
    static let pluginId = "codex"
    static let capability = "codex-app-server-threads"
    static let listCommand = "codex.appServer.threads.list.v1"
    static let turnsCommand = "codex.appServer.thread.turns.list.v1"
    static let commands = [listCommand, turnsCommand]
}
