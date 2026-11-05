import Foundation
import Testing
@testable import OpenClaw

/// Covers the headless-platform classifier behind the Nodes menu version label
/// (`core` vs `ui`) for legacy single-version node hosts (issue #193527).
struct NodesMenuHeadlessPlatformTests {
    private static func node(_ platform: String) throws -> NodeInfo {
        try JSONDecoder().decode(
            NodeInfo.self,
            from: Data(#"{"nodeId":"node-1","platform":"\#(platform)"}"#.utf8),
        )
    }

    @Test func `classifies headless platforms for the version label`() throws {
        let cases: [(String, Bool)] = [
            ("macos", true), // macOS node hosts report macos (mapped from darwin)
            ("darwin", true),
            ("linux", true),
            ("win32", true),
            ("windows", true),
            ("ios", false),
            ("iPadOS 18.2", false), // versioned Apple app platforms stay non-headless
            ("macOS 26.0", false),
        ]
        for (platform, expected) in cases {
            #expect(NodeMenuEntryFormatter.isHeadlessPlatform(try Self.node(platform)) == expected)
        }
    }
}
