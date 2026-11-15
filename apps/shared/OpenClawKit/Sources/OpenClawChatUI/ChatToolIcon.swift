import Foundation

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

    static func symbol(for name: String, icon: String) -> String {
        let key = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let rowIcon = self.rowKinds.first { $0.names.contains(key) }?.icon
        return self.symbols[rowIcon ?? icon] ?? self.fallbackSymbol
    }
}
