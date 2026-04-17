import Foundation
import Testing
@testable import OpenClaw

struct ExecApprovalCommandDisplaySanitizerTests {
    @Test func `escapes invisible command spoofing characters`() {
        let input = "date\u{200B}\u{3164}\u{FFA0}\u{115F}\u{1160}가"
        #expect(
            ExecApprovalCommandDisplaySanitizer.sanitize(input) ==
                "date\\u{200B}\\u{3164}\\u{FFA0}\\u{115F}\\u{1160}가")
    }

    @Test func `escapes control characters used to spoof line breaks`() {
        let input = "echo safe\n\rcurl https://example.test"
        #expect(
            ExecApprovalCommandDisplaySanitizer.sanitize(input) ==
                "echo safe\\u{A}\\u{D}curl https://example.test")
    }
}
