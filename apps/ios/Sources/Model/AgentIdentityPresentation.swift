import Foundation
import ImageIO
import OpenClawChatUI
import OpenClawProtocol
import UIKit

enum AgentIdentityPresentation {
    nonisolated static func imageSource(identity: [String: AnyCodable]?) -> String? {
        for key in ["avatarUrl", "avatar"] {
            guard let source = identity?[key]?.value as? String else { continue }
            let choice = OpenClawChatAgentChoice(id: "", avatar: source)
            if let avatar = choice.avatar { return avatar }
        }
        return nil
    }

    nonisolated static func image(data: Data) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                  kCGImageSourceCreateThumbnailFromImageAlways: true,
                  kCGImageSourceCreateThumbnailWithTransform: true,
                  kCGImageSourceThumbnailMaxPixelSize: 144,
              ] as CFDictionary)
        else { return nil }
        return UIImage(cgImage: image)
    }

    nonisolated static func badge(avatarText: String?, displayName: String) -> String {
        self.normalizedBadgeEmoji(avatarText) ?? self.initialsBadge(for: displayName)
    }

    nonisolated static func initialsBadge(for displayName: String) -> String {
        let words = displayName
            .split(whereSeparator: { $0.isWhitespace || $0 == "-" || $0 == "_" })
            .prefix(2)
        let initials = words.compactMap(\.first).map(String.init).joined()
        return initials.isEmpty ? "OC" : initials.uppercased()
    }

    nonisolated static func normalizedBadgeEmoji(_ value: String?) -> String? {
        guard let value else { return nil }
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return normalized.isEmpty || normalized == "?" ? nil : normalized
    }
}
