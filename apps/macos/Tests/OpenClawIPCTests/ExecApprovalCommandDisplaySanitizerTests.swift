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
}
