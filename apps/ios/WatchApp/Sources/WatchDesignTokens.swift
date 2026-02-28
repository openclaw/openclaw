import SwiftUI

enum WatchDesignTokens {
    // MARK: - Spacing

    static let spacingXS: CGFloat = 4
    static let spacingSM: CGFloat = 8
    static let spacingMD: CGFloat = 12
    static let spacingLG: CGFloat = 16
    static let spacingXL: CGFloat = 24

    // MARK: - Typography

    static let fontTitle: Font = .headline
    static let fontBody: Font = .body
    static let fontCaption: Font = .footnote
    static let fontBadge: Font = .caption2.weight(.semibold)

    // MARK: - Animation

    static let springResponse: Double = 0.35
    static let springDamping: Double = 0.8

    static var spring: Animation {
        .spring(response: springResponse, dampingFraction: springDamping)
    }

    // MARK: - Durations

    static let bannerAutoDismiss: Double = 2.0
    static let appearDelay: Double = 0.15
}
