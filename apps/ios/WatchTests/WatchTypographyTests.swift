import SwiftUI
import Testing
import UIKit
@testable import OpenClawWatchApp

struct WatchTypographyTests {
    @Test func `bundled fonts load from watch app bundle`() {
        for name in [
            "RedHatDisplay-Regular",
            "Inter-Regular",
            "Inter-Italic",
            "JetBrainsMono-Regular",
            "JetBrainsMono-Medium",
            "JetBrainsMono-SemiBold",
        ] {
            #expect(UIFont(name: name, size: 12) != nil, "Missing bundled font: \(name)")
        }
    }

    @available(watchOS 26.0, *)
    @Test func `watch text fonts scale with Dynamic Type`() {
        let fonts: [(String, Font)] = [
            ("title", WatchClawType.title(size: 17)),
            ("body", WatchClawType.body(size: 15)),
            ("label", WatchClawType.label()),
            ("avatar", WatchClawType.avatar(size: 12)),
            ("captionSemiBold", WatchClawType.captionSemiBold),
            ("captionBold", WatchClawType.captionBold),
            ("caption2", WatchClawType.caption2),
            ("command", WatchClawType.command),
        ]
        for (name, font) in fonts {
            #expect(
                Self.pointSize(of: font, at: .accessibility5) > Self.pointSize(of: font, at: .large),
                "\(name) ignores Dynamic Type")
        }
    }

    @available(watchOS 26.0, *)
    private static func pointSize(of font: Font, at size: DynamicTypeSize) -> CGFloat {
        var environment = EnvironmentValues()
        environment.dynamicTypeSize = size
        return font.resolve(in: environment.fontResolutionContext).pointSize
    }
}
