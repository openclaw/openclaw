import Foundation
import OpenClawKit
import Testing

struct ToolDisplayRegistryTests {
    @Test(arguments: [false, true], [" Dispatch_Action ", " Tool_Call "])
    func `dispatcher presents the called tool for both dictionary representations`(
        decoded: Bool,
        dispatcher: String) throws
    {
        let cases = [
            (" web_search ", "web_search", "Web Search"),
            ("mcp:github:search_issues", "search_issues", "Search Issues"),
            ("openclaw:core:web_search", "web_search", "Web Search"),
            ("client:local:search_issues", "search_issues", "Search Issues"),
        ]
        for (id, name, title) in cases {
            let raw = AnyCodable(["id": id, "args": ["query": "tool search rendering"]])
            let args = try decoded ? JSONDecoder().decode(AnyCodable.self, from: JSONEncoder().encode(raw)) : raw
            let summary = ToolDisplayRegistry.resolve(name: dispatcher, args: args)
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

    @Test func `command purpose titles are bounded display text and preserve command identity`() {
        for name in ["exec", "bash", "shell", "run_command", "run_terminal_cmd", "mcp__openclaw__exec"] {
            let summary = ToolDisplayRegistry.resolve(
                name: name, args: AnyCodable(["title": "  Check\n local\treadiness  ", "command": "printf ready"]))
            #expect(summary.title == "Check local readiness")
            #expect(summary.detail == "printf ready")
        }
        let dispatched = ToolDisplayRegistry.resolve(name: "tool_call", args: AnyCodable([
            "id": "openclaw:core:exec", "args": ["title": "Check readiness", "command": "printf ready"],
        ]))
        #expect(dispatched.title == "Check readiness")
        #expect(dispatched.name == "exec")
        #expect(ToolDisplayRegistry.resolve(
            name: "exec", args: AnyCodable(["title": String(repeating: "a", count: 140)])).title.count == 120)
        for title in [AnyCodable(" \n "), AnyCodable(3), AnyCodable("\u{0000}"), AnyCodable("\u{0000} \u{0000}")] {
            #expect(ToolDisplayRegistry.resolve(name: "exec", args: AnyCodable(["title": title])).title == "Exec")
        }
        #expect(ToolDisplayRegistry.resolve(
            name: "read", args: AnyCodable(["title": "Not a command", "path": "sample.txt"])).title == "Read")
    }

    @Test func `resolves known tool from config`() {
        let summary = ToolDisplayRegistry.resolve(name: "exec", args: nil)
        #expect(summary.icon == "squareTerminal")
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

    @Test func `tools bridged over MCP present the tool and keep invalid names raw`() {
        let bridged = ToolDisplayRegistry.resolve(
            name: "mcp__openclaw__exec",
            args: AnyCodable(["command": "printf ready"]))
        #expect(bridged.name == "exec")
        #expect(bridged.title == ToolDisplayRegistry.resolve(name: "exec", args: nil).title)
        #expect(bridged.detail == ToolDisplayRegistry.resolve(
            name: "exec",
            args: AnyCodable(["command": "printf ready"])).detail)

        #expect(ToolDisplayRegistry.resolve(name: "mcp__github__search_issues", args: nil).name == "search_issues")
        for raw in ["mcp__", "mcp__server", "mcp__server__"] {
            #expect(ToolDisplayRegistry.resolve(name: raw, args: nil).name == raw)
        }
    }
}
