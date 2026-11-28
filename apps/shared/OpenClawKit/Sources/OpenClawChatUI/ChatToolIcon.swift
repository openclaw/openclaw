import Foundation
import OpenClawKit
import SwiftUI

enum ChatToolIcon {
    private static let fallbackSymbol = "puzzlepiece.extension"

    static let symbols: [String: String] = [
        "arrowLeftRight": "arrow.left.arrow.right",
        "audioLines": "waveform",
        "barChart": "chart.bar",
        "bot": "cpu",
        "braces": "curlybraces",
        "brain": "brain",
        "calendarClock": "calendar.badge.clock",
        "claw": "pawprint",
        "clock": "clock",
        "edit": "square.and.pencil",
        "fileCode": "chevron.left.forwardslash.chevron.right",
        "fileDiff": "doc.badge.plus",
        "fileText": "doc.text",
        "github": "point.3.connected.trianglepath.dotted",
        "globe": "globe",
        "image": "photo",
        "key": "key",
        "layers": "square.3.layers.3d",
        "layoutDashboard": "rectangle.3.group",
        "listChecks": "checklist",
        "mail": "envelope",
        "messageSquare": "bubble.left",
        "mic": "mic",
        "monitor": "desktopcomputer",
        "monitorSmartphone": "laptopcomputer.and.iphone",
        "music": "music.note",
        "palette": "paintpalette",
        "paperclip": "paperclip",
        "pause": "pause",
        "penLine": "pencil.line",
        "pencil": "pencil",
        "play": "play",
        "plug": "powerplug",
        "puzzle": fallbackSymbol,
        "radio": "antenna.radiowaves.left.and.right",
        "search": "magnifyingglass",
        "send": "paperplane",
        "settings": "gearshape",
        "shieldCheck": "checkmark.shield",
        "shieldQuestion": "questionmark.circle",
        "spark": "sparkles",
        "squareTerminal": "terminal",
        "target": "scope",
        "trash": "trash",
        "users": "person.2",
        "wrench": "wrench.and.screwdriver",
    ]

    /// Exact names mirror the web's TOOL_KINDS and TOOL_ROW_ICONS.
    private static let rowKinds: [(names: Set<String>, icon: String)] = [
        (["bash", "exec", "shell", "run_command", "run_terminal_cmd"], "squareTerminal"),
        (["read", "read_file", "readfile", "notebookread", "notebook_read"], "fileText"),
        ([
            "edit", "edit_file", "multiedit", "multi_edit", "notebookedit", "notebook_edit",
            "apply_patch", "applypatch", "patch",
        ], "pencil"),
        (["write", "write_file", "create_file"], "fileCode"),
        (["grep", "find", "glob", "ls", "list", "codebase_search"], "search"),
        (["web_fetch", "webfetch", "fetch"], "globe"),
    ]

    /// The chat operation icons after #204409; the shared tool-display catalog supplies the rest.
    private static let operationIcons = [
        "agents_list": "bot",
        "automations": "calendarClock",
        "autoreview": "fileDiff",
        "canvas": "panelsTopLeft",
        "code_execution": "search",
        "codex_endpoint_probe": "squareTerminal",
        "codex_plugins": "squareTerminal",
        "codex_session_interrupt": "squareTerminal",
        "codex_session_read": "squareTerminal",
        "codex_session_send": "squareTerminal",
        "codex_sessions_list": "squareTerminal",
        "codex_threads": "squareTerminal",
        "conversations_turn": "messageSquare",
        "crabbox": "box",
        "decision_evaluate": "scale",
        "deep_research": "search",
        "diffs": "fileDiff",
        "dir_fetch": "file",
        "dir_list": "file",
        "discussion": "messageSquare",
        "dismiss_task": "listTodo",
        "dispatch_action": "zap",
        "facetime_call": "audioLines",
        "facetime_end_call": "audioLines",
        "feishu_app_scopes": "fileText",
        "feishu_bitable_create_app": "fileText",
        "feishu_bitable_create_field": "fileText",
        "feishu_bitable_create_record": "fileText",
        "feishu_bitable_get_meta": "fileText",
        "feishu_bitable_get_record": "fileText",
        "feishu_bitable_list_fields": "fileText",
        "feishu_bitable_list_records": "fileText",
        "feishu_bitable_update_record": "fileText",
        "feishu_chat": "fileText",
        "feishu_doc": "fileText",
        "feishu_drive": "fileText",
        "feishu_perm": "fileText",
        "feishu_wiki": "fileText",
        "file_fetch": "file",
        "file_write": "file",
        "firecrawl_scrape": "globe",
        "firecrawl_search": "globe",
        "github_identity_status": "github",
        "github_read": "github",
        "github_search": "github",
        "google_meet": "users",
        "intent": "brain",
        "knowledge_annotate": "book",
        "knowledge_attach": "book",
        "knowledge_attach_file": "book",
        "knowledge_attachment": "book",
        "knowledge_chronicle_day": "book",
        "knowledge_chronicle_last_seen": "book",
        "knowledge_chronicle_since": "book",
        "knowledge_connections": "book",
        "knowledge_correct": "book",
        "knowledge_create_claim": "book",
        "knowledge_create_relationship": "book",
        "knowledge_diagnostics": "book",
        "knowledge_edit_body": "book",
        "knowledge_evidence_read": "book",
        "knowledge_extract_section": "book",
        "knowledge_grep": "book",
        "knowledge_history": "book",
        "knowledge_lookup": "book",
        "knowledge_merge": "book",
        "knowledge_mutation": "book",
        "knowledge_ontology": "book",
        "knowledge_publish_batch": "book",
        "knowledge_recall": "book",
        "knowledge_reconcile_evidence": "book",
        "knowledge_record": "book",
        "knowledge_records": "book",
        "knowledge_relink": "book",
        "knowledge_remember": "book",
        "knowledge_resume": "book",
        "knowledge_revision": "book",
        "knowledge_save_page": "book",
        "knowledge_source_check": "book",
        "knowledge_status": "book",
        "knowledge_supersede": "book",
        "knowledge_timeline": "book",
        "knowledge_unmerge": "book",
        "knowledge_verify": "book",
        "knowledge_withdraw": "book",
        "llm-task": "braces",
        "lobster": "workflow",
        "local_image": "image",
        "mcp_events": "activity",
        "memory_forget": "brain",
        "memory_recall": "brain",
        "memory_search": "brain",
        "memory_store": "brain",
        "node_inference": "server",
        "onepassword": "key",
        "openclaw": "settings",
        "openclaw_end_call": "audioLines",
        "personal_instructions": "fileText",
        "portal": "panelsTopLeft",
        "qa_restart_unsafe_probe": "bug",
        "qa_restart_wait": "bug",
        "search": "search",
        "session_project": "folder",
        "sessions_create": "messageSquarePlus",
        "sessions_history": "messageSquare",
        "sessions_yield": "clock",
        "show_widget": "layoutDashboard",
        "skill_workshop": "book",
        "slack_huddles": "users",
        "structured_output": "braces",
        "suggest_task": "listTodo",
        "talk_voice": "audioLines",
        "tavily_extract": "globe",
        "tavily_search": "globe",
        "teams_meetings": "users",
        "theme": "pipette",
        "tool_call": "puzzle",
        "tool_call_update": "puzzle",
        "tool_describe": "book",
        "tool_search": "search",
        "toolsearch": "search",
        "visitor_invite": "userPlus",
        "visitor_list": "userPlus",
        "visitor_revoke": "userPlus",
        "voice_call": "audioLines",
        "whatsapp_call": "messageCircle",
        "whatsapp_login": "messageCircle",
        "wiki_apply": "book",
        "wiki_get": "book",
        "wiki_lint": "book",
        "wiki_search": "book",
        "wiki_status": "book",
        "workboard_attachment_add": "kanban",
        "workboard_attachment_delete": "kanban",
        "workboard_attachment_read": "kanban",
        "workboard_block": "kanban",
        "workboard_board_archive": "kanban",
        "workboard_board_create": "kanban",
        "workboard_board_delete": "kanban",
        "workboard_boards": "kanban",
        "workboard_claim": "kanban",
        "workboard_comment": "kanban",
        "workboard_complete": "kanban",
        "workboard_create": "kanban",
        "workboard_decompose": "kanban",
        "workboard_dispatch": "kanban",
        "workboard_heartbeat": "kanban",
        "workboard_link": "kanban",
        "workboard_list": "kanban",
        "workboard_move": "kanban",
        "workboard_notify_advance": "kanban",
        "workboard_notify_events": "kanban",
        "workboard_notify_list": "kanban",
        "workboard_notify_subscribe": "kanban",
        "workboard_notify_unsubscribe": "kanban",
        "workboard_promote": "kanban",
        "workboard_proof": "kanban",
        "workboard_protocol_violation": "kanban",
        "workboard_read": "kanban",
        "workboard_reassign": "kanban",
        "workboard_reclaim": "kanban",
        "workboard_release": "kanban",
        "workboard_runs": "kanban",
        "workboard_sessions_board_move": "kanban",
        "workboard_sessions_board_read": "kanban",
        "workboard_sessions_board_update": "kanban",
        "workboard_specify": "kanban",
        "workboard_stats": "kanban",
        "workboard_unblock": "kanban",
        "workboard_verify": "kanban",
        "workboard_worker_log": "kanban",
        "x_search": "search",
        "zalouser": "messageCircle",
        "zoom_meetings": "users",
    ]

    /// Intrinsic Control UI identity, after the row-kind and operation-icon overrides. No
    /// plugin artwork is fetched to decorate a transcript; the catalog fallback works offline.
    static func asset(for name: String, icon: String, args: AnyCodable? = nil) -> String {
        let key = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let arguments = args?.dictionaryValue
        if key == "sessions", arguments?["action"]?.stringValue == "stop",
           let target = arguments?["sessionKey"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
           target.range(of: #"^(agent:[^:]+:)?subagent:"#, options: [.regularExpression, .caseInsensitive]) != nil
        {
            return "bot"
        }
        let command = arguments?["command"]?.stringValue
        if ["str_replace_editor", "str_replace_based_edit_tool"].contains(key) {
            switch command?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
            case "view": return "fileText"
            case "create": return "fileCode"
            case "str_replace", "insert", "undo_edit": return "pencil"
            default: break
            }
        } else if let row = self.rowKinds.first(where: { $0.names.contains(key) }) {
            return row.icon
        } else if command != nil, let arguments, arguments.count <= 3 {
            return "squareTerminal"
        }
        return self.operationIcons[key] ?? (self.symbols[icon] == nil ? "puzzle" : icon)
    }

    @MainActor @ViewBuilder static func glyph(for name: String, icon: String, args: AnyCodable? = nil) -> some View {
        #if os(iOS)
        ChatVectorGlyph(asset: self.asset(for: name, icon: icon, args: args), size: 13)
        #else
        Image(systemName: self.symbol(for: name, icon: icon))
        #endif
    }

    static func symbol(for name: String, icon: String) -> String {
        let key = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let rowIcon = self.rowKinds.first { $0.names.contains(key) }?.icon
        return self.symbols[rowIcon ?? icon] ?? self.fallbackSymbol
    }
}
