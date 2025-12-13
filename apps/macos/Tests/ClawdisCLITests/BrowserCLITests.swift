import Testing
@testable import ClawdisCLI

@Suite struct BrowserCLITests {
    @Test func tabsOutputIncludesFullTargetId() async throws {
        let res: [String: Any] = [
            "running": true,
            "tabs": [
                [
                    "targetId": "57A01309E14B5DEE0FB41F908515A2FC",
                    "title": "Example",
                    "url": "https://example.com/",
                ],
            ],
        ]

        let lines = BrowserCLI._testFormatTabs(res: res)
        #expect(lines.contains("  id: 57A01309E14B5DEE0FB41F908515A2FC"))
    }
}
