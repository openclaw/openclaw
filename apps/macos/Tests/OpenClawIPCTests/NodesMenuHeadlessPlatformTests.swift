import Foundation
import Testing
@testable import OpenClaw

/// Covers the Nodes menu version label for legacy single-version node hosts
/// (`core` vs `ui`, issue #193527): macOS node hosts report platform "macos"
/// (mapped from darwin), which must keep its version on the core label, while
/// Apple app platforms stay on the ui label.
struct NodesMenuHeadlessPlatformTests {
    private static func node(_ platform: String) throws -> NodeInfo {
        try JSONDecoder().decode(
            NodeInfo.self,
            from: Data(
                #"{"nodeId":"node-1","platform":"\#(platform)","version":"2026.10.9"}"#.utf8,
            ),
        )
    }

    @Test func `labels a legacy single-version node host by platform`() throws {
        let cases: [(String, String)] = [
            ("macos", "core v2026.10.9"),
            ("darwin", "core v2026.10.9"),
            ("windows", "core v2026.10.9"),
            ("ios", "ui v2026.10.9"),
            ("iPadOS 18.2", "ui v2026.10.9"),
            ("macOS 26.0", "ui v2026.10.9"),
        ]
        for (platform, expected) in cases {
            #expect(NodeMenuEntryFormatter.detailRightVersion(try Self.node(platform)) == expected)
        }
    }
}
