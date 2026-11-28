import OpenClawKit
import SwiftUI
import Testing
@testable import OpenClawChatUI

struct ChatGlyphTests {
    @Test func `operation glyphs follow the displayed call and editor action`() {
        let call = ToolDisplayRegistry.displayCall(name: "tool_call", args: AnyCodable([
            "id": "openclaw:core:session_project", "args": ["action": "list"],
        ] as [String: Any]))
        let display = ToolDisplayRegistry.resolve(name: call.name, args: call.args)
        #expect(ChatToolIcon.asset(for: display.name, icon: display.icon, args: call.args) == "folder")
        #expect(ChatToolIcon.asset(for: "str_replace_editor", icon: "puzzle", args: AnyCodable(["command": "view"]))
            == "fileText")
        #expect(ChatToolIcon.asset(for: "memory_search", icon: "search") == "brain")
        #expect(ChatToolIcon.asset(for: "unknown", icon: "futureIcon") == "puzzle")
    }

    @Test @MainActor func `inline marks fit inside the adjacent text line`() throws {
        for font in [OpenClawChatTypography.body, OpenClawChatTypography.heading(level: 1)] {
            let text = Text(verbatim: "Hg")
            let height = try #require(ImageRenderer(content: text.font(font)).uiImage).size.height
            for asset in ["link", "inline-code", "inline-markdown", "inline-pullRequest", "inline-issue", "github"] {
                let mark = ChatInlineGlyph.text(for: asset, font: font, environment: EnvironmentValues())
                let line = (mark + Text(verbatim: "\u{00A0}") + text).font(font)
                #expect(try #require(ImageRenderer(content: line).uiImage).size.height == height)
            }
        }
    }

    @Test @MainActor func `inline file glyphs identify the target path`() {
        #expect(ChatInlineGlyph.fileAsset(for: "docs/review.md") == "inline-markdown")
        #expect(ChatInlineGlyph.fileAsset(for: "config/package.json") == "inline-package")
    }
}
