import Foundation

public enum OpenClawAppGroup {
    public static let canonicalIdentifier = "group.ai.openclawfoundation.app.shared"

    public static var identifier: String {
        let raw = Bundle.main.object(forInfoDictionaryKey: "OpenClawAppGroupIdentifier") as? String
        return raw?.trimmedNonEmpty ?? self.canonicalIdentifier
    }
}
