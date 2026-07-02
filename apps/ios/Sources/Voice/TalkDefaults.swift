import Foundation

enum TalkWallpaperSelection: String, CaseIterable, Identifiable {
    case `default`
    case ocean
    case custom

    var id: String {
        self.rawValue
    }

    var label: String {
        switch self {
        case .default: "Default gray"
        case .ocean: "Ocean"
        case .custom: "Your photo"
        }
    }
}

enum TalkDefaults {
    static let silenceTimeoutMs = 900
    static let speakerphoneEnabledKey = "talk.speakerphone.enabled"
    static let speakerphoneEnabledByDefault = true
    static let wallpaperSelectionKey = "talk.wallpaper.selection"
    static let wallpaperOceanResourceName = "ocean"
    static let wallpaperOceanResourceExtension = "jpg"
    static let wallpaperOceanResourceSubdirectory = "TalkWallpapers"
    static let defaultWallpaperColorHex = "#f8f8f7"

    static func speakerphoneEnabled(defaults: UserDefaults = .standard) -> Bool {
        guard defaults.object(forKey: self.speakerphoneEnabledKey) != nil else {
            return self.speakerphoneEnabledByDefault
        }
        return defaults.bool(forKey: self.speakerphoneEnabledKey)
    }
}
