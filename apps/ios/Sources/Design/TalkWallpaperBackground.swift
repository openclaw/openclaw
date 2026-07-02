import SwiftUI

struct TalkWallpaperBackground: View {
    @AppStorage(TalkDefaults.wallpaperSelectionKey) private var wallpaperSelectionRaw =
        TalkWallpaperSelection.default.rawValue

    private var selection: TalkWallpaperSelection {
        let selection = TalkWallpaperSelection(rawValue: self.wallpaperSelectionRaw) ?? .default
        if selection == .custom, !TalkWallpaperStore.hasCustomImage() {
            return .default
        }
        return selection
    }

    var body: some View {
        Group {
            switch self.selection {
            case .default:
                TalkDefaults.defaultWallpaperColor
                    .ignoresSafeArea()
            case .ocean:
                self.imageBackground(TalkWallpaperStore.oceanImage())
            case .custom:
                self.imageBackground(TalkWallpaperStore.customImage())
            }
        }
    }

    @ViewBuilder
    private func imageBackground(_ image: UIImage?) -> some View {
        if let image {
            GeometryReader { proxy in
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: proxy.size.width, height: proxy.size.height)
                    .clipped()
                    .overlay(Color.black.opacity(0.28))
            }
            .ignoresSafeArea()
        } else {
            TalkDefaults.defaultWallpaperColor
                .ignoresSafeArea()
        }
    }
}

extension TalkDefaults {
    static let defaultWallpaperColor = Color(
        red: 248.0 / 255.0,
        green: 248.0 / 255.0,
        blue: 247.0 / 255.0)
}
