import Foundation
import UIKit

enum TalkWallpaperStore {
    private static let customFilename = "custom.jpg"

    static func selection(defaults: UserDefaults = .standard) -> TalkWallpaperSelection {
        guard let raw = defaults.string(forKey: TalkDefaults.wallpaperSelectionKey),
              let selection = TalkWallpaperSelection(rawValue: raw)
        else {
            return .default
        }
        if selection == .custom, !self.hasCustomImage() {
            return .default
        }
        return selection
    }

    static func setSelection(_ selection: TalkWallpaperSelection, defaults: UserDefaults = .standard) {
        defaults.set(selection.rawValue, forKey: TalkDefaults.wallpaperSelectionKey)
    }

    static func customImageURL() -> URL {
        let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("TalkWallpaper", isDirectory: true)
        return directory.appendingPathComponent(self.customFilename)
    }

    static func hasCustomImage() -> Bool {
        FileManager.default.fileExists(atPath: self.customImageURL().path)
    }

    static func customImage() -> UIImage? {
        guard self.hasCustomImage() else { return nil }
        return UIImage(contentsOfFile: self.customImageURL().path)
    }

    static func oceanImage() -> UIImage? {
        guard let url = Bundle.main.url(
            forResource: TalkDefaults.wallpaperOceanResourceName,
            withExtension: TalkDefaults.wallpaperOceanResourceExtension,
            subdirectory: TalkDefaults.wallpaperOceanResourceSubdirectory)
        else {
            return nil
        }
        guard let data = try? Data(contentsOf: url) else { return nil }
        return UIImage(data: data)
    }

    @discardableResult
    static func saveCustomImage(_ data: Data) throws -> URL {
        let directory = self.customImageURL().deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = self.customImageURL()
        try data.write(to: url, options: .atomic)
        return url
    }

    static func usesImageWallpaper(defaults: UserDefaults = .standard) -> Bool {
        switch self.selection(defaults: defaults) {
        case .ocean, .custom:
            true
        case .default:
            false
        }
    }
}
