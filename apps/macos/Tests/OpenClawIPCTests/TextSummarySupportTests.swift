import Testing
@testable import OpenClaw

struct TextSummarySupportTests {
    private static let recoveryDiagnostics: [(String, String)] = [
        (
            "Gateway uninstall failed: service inspection unavailable\n[openclaw] The CLI command failed.\n" +
                "[openclaw] For help, run `openclaw --profile example doctor`.",
            "Gateway uninstall failed: service inspection unavailable"),
        (
            "[openclaw] OpenClaw needs a manual recovery step.\n" +
                "[openclaw] Reason: Agent database schema 2147483646 is newer than supported.\n" +
                "[openclaw] Help: openclaw --help",
            "[openclaw] Reason: Agent database schema 2147483646 is newer than supported."),
        (
            "[openclaw] The CLI command failed.\n[openclaw] Reason: Service ownership changed.\n" +
                "[openclaw] Stack:\n[openclaw] Error: Service ownership changed.\n" +
                "[openclaw]     at checkCurrent (service.js:12:3)\n" +
                "[openclaw] Try: openclaw doctor\n[openclaw] Help: openclaw --help",
            "[openclaw] Reason: Service ownership changed."),
        ("Error: old failure\nHelp: normal application output", "Help: normal application output"),
    ]

    @Test(arguments: Self.recoveryDiagnostics)
    func `surfaces CLI diagnostics before recovery footers`(output: String, expected: String) {
        #expect(TextSummarySupport.summarizeLastLine(output) == expected)
    }

    @Test func `keeps the last line for plain output`() {
        #expect(TextSummarySupport.summarizeLastLine("first\nsecond") == "second")
    }

    @Test func `returns nil for blank output`() {
        #expect(TextSummarySupport.summarizeLastLine(" \n\t\n") == nil)
    }

    @Test func `truncates long lines`() {
        let summary = TextSummarySupport.summarizeLastLine(String(repeating: "x", count: 300))
        #expect(summary?.count == 200)
        #expect(summary?.hasSuffix("…") == true)
    }

    @Test func `surfaces the error line instead of the Node version banner`() {
        let nodeFatal = """
        node:internal/modules/cjs/loader:1215
          throw err;
          ^

        Error: Cannot find module '/Users/example/dist/index.js'
            at Function._resolveFilename (node:internal/modules/cjs/loader:1212:15)
            at node:internal/main/run_main_module:36:49 {
          code: 'MODULE_NOT_FOUND'
        }

        Node.js v26.5.1
        """
        #expect(TextSummarySupport.summarizeLastLine(nodeFatal)
            == "Error: Cannot find module '/Users/example/dist/index.js'")
    }

    @Test func `falls back to the last real line when no error line precedes the banner`() {
        let output = "some diagnostic\nNode.js v26.5.1"
        #expect(TextSummarySupport.summarizeLastLine(output) == "some diagnostic")
    }

    @Test func `banner-only output keeps the banner`() {
        #expect(TextSummarySupport.summarizeLastLine("Node.js v26.5.1") == "Node.js v26.5.1")
    }

    @Test func `does not jump to old error lines without a banner`() {
        let output = "Error: transient\nretrying\ndone"
        #expect(TextSummarySupport.summarizeLastLine(output) == "done")
    }
}
