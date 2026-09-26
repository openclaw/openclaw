import Foundation
import OpenClawKit
import Testing

struct ToolDisplayRegistryTests {
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
