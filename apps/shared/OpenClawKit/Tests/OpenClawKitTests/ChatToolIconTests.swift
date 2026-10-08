import Foundation
import OpenClawKit
import Testing
@testable import OpenClawChatUI
#if canImport(AppKit)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

struct ChatToolIconTests {
    @Test @MainActor func `shared config and row icons have available native symbols`() throws {
        struct Spec: Decodable {
            let icon: String
        }
        struct Config: Decodable {
            let fallback: Spec
            let tools: [String: Spec]
        }
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let data = try Data(contentsOf: packageRoot.appendingPathComponent(
            "Sources/OpenClawKit/Resources/tool-display.json"))
        let config = try JSONDecoder().decode(Config.self, from: data)
        for (name, spec) in config.tools {
            #expect(ToolDisplayRegistry.resolve(name: name, args: nil).icon == spec.icon)
        }
        #expect(ToolDisplayRegistry.resolve(name: "unknown_tool", args: nil).icon == config.fallback.icon)

        let rowIcons: Set = ["squareTerminal", "fileText", "pencil", "fileCode", "search", "globe"]
        let icons = Set(config.tools.values.map(\.icon)).union(rowIcons).union([config.fallback.icon])
        for icon in icons {
            let symbol = try #require(ChatToolIcon.symbols[icon], "Missing native glyph for \(icon)")
            #if canImport(AppKit)
            #expect(NSImage(systemSymbolName: symbol, accessibilityDescription: nil) != nil, "\(icon): \(symbol)")
            #elseif canImport(UIKit)
            #expect(UIImage(systemName: symbol) != nil, "\(icon): \(symbol)")
            #endif
        }
    }

    @Test func `row kinds override config icons and use exact tool names`() {
        let cases = [
            (" Run_Terminal_Cmd ", "terminal"),
            ("notebook_read", "doc.text"),
            ("edit", "pencil"),
            ("apply_patch", "pencil"),
            ("write", "chevron.left.forwardslash.chevron.right"),
            ("ls", "magnifyingglass"),
            ("fetch", "globe"),
            ("memory_search", "magnifyingglass"),
            ("browser", "globe"),
            ("message", "envelope"),
            ("cron", "calendar.badge.clock"),
            ("search_issues", "puzzlepiece.extension"),
            ("custom_browser", "puzzlepiece.extension"),
        ]
        for (name, expected) in cases {
            let summary = ToolDisplayRegistry.resolve(name: name, args: nil)
            #expect(ChatToolIcon.symbol(for: summary.name, icon: summary.icon) == expected, "\(name)")
        }
        #expect(ChatToolIcon.symbol(for: "unknown_tool", icon: "futureIcon") == "puzzlepiece.extension")
    }

    @Test func `dispatcher icons follow the displayed tool`() {
        for (id, expected) in [
            ("openclaw:core:write", "chevron.left.forwardslash.chevron.right"),
            ("openclaw:core:memory_search", "magnifyingglass"),
            ("mcp:github:search_issues", "puzzlepiece.extension"),
        ] {
            let summary = ToolDisplayRegistry.resolve(name: "tool_call", args: AnyCodable(["id": id]))
            #expect(ChatToolIcon.symbol(for: summary.name, icon: summary.icon) == expected, "\(id)")
        }
    }
}
