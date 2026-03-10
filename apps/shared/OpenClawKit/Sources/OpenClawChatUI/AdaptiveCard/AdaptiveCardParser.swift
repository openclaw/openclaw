import Foundation

struct ParsedAdaptiveCard {
    let card: AdaptiveCard
    let fallbackText: String
}

enum AdaptiveCardParser {
    private static let openMarker = "<!--adaptive-card-->"
    private static let closeMarker = "<!--/adaptive-card-->"

    /// Extract the first adaptive card JSON from message text, if present.
    static func parseAdaptiveCardMarkers(from text: String) -> ParsedAdaptiveCard? {
        guard let openRange = text.range(of: Self.openMarker),
              let closeRange = text.range(of: Self.closeMarker, range: openRange.upperBound..<text.endIndex)
        else {
            return nil
        }

        let jsonSlice = text[openRange.upperBound..<closeRange.lowerBound]
        guard let data = String(jsonSlice).data(using: .utf8) else { return nil }

        let decoder = JSONDecoder()
        guard let card = try? decoder.decode(AdaptiveCard.self, from: data) else { return nil }

        let fallback = Self.stripCardMarkers(from: text)
        return ParsedAdaptiveCard(card: card, fallbackText: fallback)
    }

    /// Remove all adaptive-card marker blocks, returning only the surrounding text.
    static func stripCardMarkers(from text: String) -> String {
        var result = text
        // Remove all marker pairs (greedy inner content)
        while let openRange = result.range(of: Self.openMarker) {
            if let closeRange = result.range(of: Self.closeMarker, range: openRange.lowerBound..<result.endIndex) {
                result.removeSubrange(openRange.lowerBound..<closeRange.upperBound)
            } else {
                // Unclosed marker; remove from open to end
                result.removeSubrange(openRange.lowerBound..<result.endIndex)
            }
        }
        return result.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
