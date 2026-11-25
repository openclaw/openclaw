import Foundation

/// Parses ISO 8601 instants sent in node command params.
///
/// `ISO8601DateFormatter()` with default options rejects fractional seconds, but
/// JavaScript's `Date.prototype.toISOString()` always emits them
/// (`2026-11-08T10:00:00.000Z`), and Android's `Instant.parse` accepts both forms.
public enum OpenClawISO8601 {
    public static func date(from string: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: string) ?? ISO8601DateFormatter().date(from: string)
    }
}
