#if os(iOS)
import UIKit

/// The native color tokens shared by the iOS app and its extensions.
public enum OpenClawIOSBrand {
    public static let accent = UIColor(red: 205 / 255.0, green: 53 / 255.0, blue: 53 / 255.0, alpha: 1)
    public static let danger = UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 240 / 255.0, green: 133 / 255.0, blue: 122 / 255.0, alpha: 1)
            : UIColor(red: 185 / 255.0, green: 28 / 255.0, blue: 28 / 255.0, alpha: 1)
    }
}
#endif
