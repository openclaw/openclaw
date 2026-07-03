import SwiftUI

enum WatchClawType {
    static func avatar(size: CGFloat) -> Font {
        self.body(size: size, weight: .bold)
    }

    static func label(size: CGFloat = 10, weight: Font.Weight = .bold) -> Font {
        self.body(size: size, weight: weight)
    }

    static func title(size: CGFloat, weight: Font.Weight = .semibold) -> Font {
        self.display(size: size, weight: weight)
    }

    static func body(size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .custom("Inter-Regular", size: size).weight(weight)
    }

    static func symbol(size: CGFloat, weight: Font.Weight) -> Font {
        .system(size: size, weight: weight)
    }

    static var caption: Font {
        body(size: 12)
    }

    static var captionSemiBold: Font {
        body(size: 12, weight: .semibold)
    }

    static var captionBold: Font {
        body(size: 12, weight: .bold)
    }

    static var caption2: Font {
        body(size: 11)
    }

    private static func display(size: CGFloat, weight: Font.Weight) -> Font {
        .custom("RedHatDisplay-Regular", size: size).weight(weight)
    }
}
