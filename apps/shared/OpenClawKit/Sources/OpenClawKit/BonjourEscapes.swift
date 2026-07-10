import Foundation
import OpenClawMobileCore

public enum BonjourEscapes {
    /// mDNS / DNS-SD commonly escapes bytes in instance names as `\DDD` (decimal-encoded),
    /// e.g. spaces are `\032`.
    public static func decode(_ input: String) -> String {
        MobileCoreBridge.shared.decodeBonjourEscapesForApple(input: input)
    }
}
