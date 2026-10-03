import Foundation
import OpenClawKit
import Testing

struct ToolDisplayRegistryTests {
    @Test(arguments: [false, true])
    func `dispatcher presents the called tool for both dictionary representations`(decoded: Bool) throws {
        let cases = [
            (" web_search ", "web_search", "Web Search"),
            ("mcp:github:search_issues", "search_issues", "Search Issues"),
            ("openclaw:core:web_search", "web_search", "Web Search"),
            ("client:local:search_issues", "search_issues", "Search Issues"),
        ]
        for (id, name, title) in cases {
            let raw = AnyCodable(["id": id, "args": ["query": "tool search rendering"]])
            let args = try decoded ? JSONDecoder().decode(AnyCodable.self, from: JSONEncoder().encode(raw)) : raw
            let summary = ToolDisplayRegistry.resolve(name: " Tool_Call ", args: args)
            #expect(summary.name == name)
            #expect(summary.title == title)
            #expect(summary.label == name)
            #expect(summary.detail == "tool search rendering")
        }
    }

    @Test func `invalid dispatcher IDs preserve raw presentation`() {
        for id in [nil, AnyCodable(" \n "), AnyCodable(3)] {
            var arguments = ["command": AnyCodable("outer query"), "args": AnyCodable(["query": "inner query"])]
            arguments["id"] = id
            let args = AnyCodable(arguments)
            let call = ToolDisplayRegistry.displayCall(name: "tool_call", args: args)
            #expect(call.name == "tool_call")
            #expect(call.args == args)
            let summary = ToolDisplayRegistry.resolve(name: "tool_call", args: args)
            #expect(summary.name == "tool_call")
            #expect(summary.title == "Tool Call")
            #expect(summary.detail == nil)
        }
    }

    @Test func `dispatcher discards non-object inner arguments`() {
        for inner in [nil, AnyCodable(NSNull()), AnyCodable(["query"]), AnyCodable("query"), AnyCodable(3)] {
            var arguments = ["id": AnyCodable("search_issues"), "query": AnyCodable("outer query")]
            arguments["args"] = inner
            let args = AnyCodable(arguments)
            #expect(ToolDisplayRegistry.displayCall(name: "tool_call", args: args).args == AnyCodable([String: Any]()))
            let summary = ToolDisplayRegistry.resolve(name: "tool_call", args: args)
            #expect(summary.name == "search_issues")
            #expect(summary.detail == nil)
        }
    }

    @Test func `resolves known tool from config`() {
        let summary = ToolDisplayRegistry.resolve(name: "exec", args: nil)
        #expect(summary.emoji == "🛠️")
        #expect(summary.title == "Exec")
    }

    @Test func `read ranges preserve truncation and omit unrepresentable bounds`() {
        let cases: [(Double, Double, String)] = [
            (2.9, 3.2, "fixture.txt:2-6"),
            (-2.9, 1.2, "fixture.txt:-2--1"),
            (1e100, 1, "fixture.txt"),
            (-1e100, 1, "fixture.txt"),
            (1, 1e100, "fixture.txt"),
            (.greatestFiniteMagnitude, .greatestFiniteMagnitude, "fixture.txt"),
            (.infinity, 1, "fixture.txt"),
            (1, .nan, "fixture.txt"),
        ]
        for (offset, limit, expected) in cases {
            let summary = ToolDisplayRegistry.resolve(name: "read", args: AnyCodable([
                "path": "fixture.txt", "offset": offset, "limit": limit,
            ]))
            #expect(summary.detail == expected)
        }
    }
}
