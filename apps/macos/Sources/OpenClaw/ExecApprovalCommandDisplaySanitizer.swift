import Foundation

enum ExecApprovalCommandDisplaySanitizer {
    private static let invisibleCodePoints: Set<UInt32> = [
        0x115F,
        0x1160,
        0x3164,
        0xFFA0,
    ]

    static func sanitize(_ text: String) -> String {
        var sanitized = ""
        sanitized.reserveCapacity(text.count)
        for scalar in text.unicodeScalars {
            if self.shouldEscape(scalar) {
                sanitized.append(self.escape(scalar))
            } else {
                sanitized.append(String(scalar))
            }
        }
        return sanitized
    }

    private static func shouldEscape(_ scalar: UnicodeScalar) -> Bool {
        scalar.properties.generalCategory == .format || self.invisibleCodePoints.contains(scalar.value)
    }

    private static func escape(_ scalar: UnicodeScalar) -> String {
        "\\u{\(String(scalar.value, radix: 16, uppercase: true))}"
    }
}
