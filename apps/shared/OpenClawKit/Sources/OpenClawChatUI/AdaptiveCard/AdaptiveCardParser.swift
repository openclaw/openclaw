import Foundation

struct ParsedAdaptiveCard {
    let card: AdaptiveCard
    let fallbackText: String
    let templateData: Data?
}

enum AdaptiveCardParser {
    private static let openMarker = "<!--adaptive-card-->"
    private static let closeMarker = "<!--/adaptive-card-->"
    private static let dataOpenMarker = "<!--adaptive-card-data-->"
    private static let dataCloseMarker = "<!--/adaptive-card-data-->"

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

        let templateData = Self.extractTemplateData(from: text)
        let fallback = Self.stripCardMarkers(from: text)
        return ParsedAdaptiveCard(card: card, fallbackText: fallback, templateData: templateData)
    }

    /// Extract template data JSON from adaptive-card-data markers, if present.
    static func extractTemplateData(from text: String) -> Data? {
        guard let openRange = text.range(of: Self.dataOpenMarker),
              let closeRange = text.range(of: Self.dataCloseMarker, range: openRange.upperBound..<text.endIndex)
        else {
            return nil
        }

        let dataSlice = text[openRange.upperBound..<closeRange.lowerBound]
        let trimmed = String(dataSlice).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        // Validate it is parseable JSON before returning
        guard let rawData = trimmed.data(using: .utf8),
              (try? JSONSerialization.jsonObject(with: rawData)) != nil
        else {
            return nil
        }
        return rawData
    }

    /// Remove all adaptive-card marker blocks, returning only the surrounding text.
    static func stripCardMarkers(from text: String) -> String {
        var result = text

        // Remove all card marker pairs
        while let openRange = result.range(of: Self.openMarker) {
            if let closeRange = result.range(of: Self.closeMarker, range: openRange.lowerBound..<result.endIndex) {
                result.removeSubrange(openRange.lowerBound..<closeRange.upperBound)
            } else {
                result.removeSubrange(openRange.lowerBound..<result.endIndex)
            }
        }

        // Remove all data marker pairs
        while let openRange = result.range(of: Self.dataOpenMarker) {
            if let closeRange = result.range(of: Self.dataCloseMarker, range: openRange.lowerBound..<result.endIndex) {
                result.removeSubrange(openRange.lowerBound..<closeRange.upperBound)
            } else {
                result.removeSubrange(openRange.lowerBound..<result.endIndex)
            }
        }

        return result.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
