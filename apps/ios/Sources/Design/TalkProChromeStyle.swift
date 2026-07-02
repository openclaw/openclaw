import SwiftUI

struct TalkProChromeStyle {
    let usesImageWallpaper: Bool

    var primary: Color {
        self.usesImageWallpaper ? .white : Color(red: 17.0 / 255.0, green: 24.0 / 255.0, blue: 39.0 / 255.0)
    }

    var secondary: Color {
        self.usesImageWallpaper ? .white.opacity(0.72) : Color(
            red: 107.0 / 255.0,
            green: 114.0 / 255.0,
            blue: 128.0 / 255.0)
    }

    var dockLabel: Color {
        self.usesImageWallpaper ? .white : Color(red: 107.0 / 255.0, green: 114.0 / 255.0, blue: 128.0 / 255.0)
    }

    var micButtonFill: Color {
        .white
    }

    var micButtonForeground: Color {
        Color(red: 26.0 / 255.0, green: 26.0 / 255.0, blue: 26.0 / 255.0)
    }

    var speakerButtonFill: Color {
        Color.black.opacity(0.42)
    }

    var hangupButtonFill: Color {
        Color(red: 220.0 / 255.0, green: 38.0 / 255.0, blue: 38.0 / 255.0)
    }
}
